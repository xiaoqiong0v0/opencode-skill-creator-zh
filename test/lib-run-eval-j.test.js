/**
 * 评测隔离约束 J1 / J5 / J6 / J7 / J8 / J9 的直接单测（`docs/SPEC.md` R6.2）。
 *
 * - J1：符号链接失败时降级为**逐文件**镜像（技能白名单 + 单文件上限），绝不整目录递归拷；
 * - J5：`SKILL_ZH_DEBUG=1` 打印逐条清单（含跳过原因），默认只输出汇总；
 * - J6：命中同名技能时只往隔离根写 `permission.skill.<name> = "deny"`，用户目录哈希不变；
 * - J7：deny 写不进时中止，不启动子进程；
 * - J8：`--no-shadow-guard`（`shadowGuard: false`）不写 deny，命中同名即中止；
 * - J9：隔离根只由四项构成，四项之外不放行，被测技能按内容哈希不可见。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { test } from "node:test";

import { parse as parseJsonc } from "jsonc-parser";

import {
  IsolationError,
  MAX_MIRROR_FILE_BYTES,
  ShadowGuardError,
  applySkillDeny,
  runEval,
  symlinkProjectOpenCodeConfig,
} from "../dist/lib/run-eval.js";
import { createFakeOpencodeHarness, triggerLine, withFakeOpencode } from "./helpers/fake-opencode.mjs";

/**
 * 建一对「项目根 + 评测根」临时目录并在结束时清理。
 *
 * @param {(projectRoot: string, evalRoot: string) => unknown} body 用例主体
 * @returns {unknown} 主体返回值
 */
function withProjectAndEvalRoots(body) {
  const projectRoot = mkdtempSync(join(tmpdir(), "skill-eval-j-project-"));
  const evalRoot = mkdtempSync(join(tmpdir(), "skill-eval-j-root-"));
  try {
    return body(projectRoot, evalRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(evalRoot, { recursive: true, force: true });
  }
}

/**
 * 在给定目录下写一个技能目录（含 `SKILL.md`）。
 *
 * @param {string} parent 父目录
 * @param {string} name 技能目录名
 * @param {string} body `SKILL.md` 正文
 */
function writeSkill(parent, name, body) {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(join(parent, name, "SKILL.md"), body);
}

/**
 * 递归收集目录下的所有文件（符号链接按目标读取），返回「相对路径 → 内容」。
 *
 * @param {string} root 根目录
 * @returns {Map<string, string>} 快照
 */
function snapshot(root) {
  const result = new Map();
  const walk = (base) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const child = join(base, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(child);
        continue;
      }
      const source = lstatSync(child).isSymbolicLink() ? readlinkSync(child) : child;
      try {
        const stats = statSync(source);
        if (stats.isFile()) {
          result.set(relative(root, child).replaceAll("\\", "/"), readFileSync(source, "utf-8"));
        }
      } catch {
        // 悬空链接：快照里不记，哈希比较仍能发现差异。
      }
    }
  };
  walk(root);
  return result;
}

/**
 * 递归查找内容包含 needle 的文件。
 *
 * @param {string} root 根目录
 * @param {string} needle 内容片段
 * @returns {string[]} 命中文件路径
 */
function findFilesContaining(root, needle) {
  return [...snapshot(root).entries()]
    .filter(([, content]) => content.includes(needle))
    .map(([path]) => path);
}

/**
 * 临时把 `symlinkSync` 打桩成抛 EPERM（模拟 Windows 未开开发者模式）。
 *
 * @param {() => unknown} body 用例主体
 * @returns {unknown} 主体返回值
 */
function withSymlinkFailure(body) {
  const original = fs.symlinkSync;
  fs.symlinkSync = () => {
    const error = new Error("EPERM: operation not permitted, symlink");
    error.code = "EPERM";
    throw error;
  };
  syncBuiltinESMExports();
  try {
    return body();
  } finally {
    fs.symlinkSync = original;
    syncBuiltinESMExports();
  }
}

/**
 * 捕获 console.error 输出。
 *
 * @param {() => unknown} body 用例主体
 * @returns {{value: unknown, lines: string[]}} 主体返回值与捕获行
 */
function captureStderr(body) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: body(), lines };
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// J1：逐文件镜像，不整目录递归拷
// ---------------------------------------------------------------------------

test("J1 符号链接失败时只逐文件镜像技能白名单，超限文件跳过并留调试记录", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    const sibling = join(skillsRoot, "sibling");
    mkdirSync(join(sibling, "references"), { recursive: true });
    mkdirSync(join(sibling, "agents"), { recursive: true });
    mkdirSync(join(sibling, "dist"), { recursive: true });
    mkdirSync(join(sibling, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(sibling, ".git"), { recursive: true });
    writeFileSync(join(sibling, "SKILL.md"), "SIBLING_BODY\n");
    writeFileSync(join(sibling, "agents", "helper.md"), "AGENT_BODY\n");
    writeFileSync(join(sibling, "references", "rules.md"), "RULES_BODY\n");
    writeFileSync(join(sibling, "references", "big.bin"), "x".repeat(MAX_MIRROR_FILE_BYTES + 1));
    writeFileSync(join(sibling, "dist", "bundle.js"), "DIST_BUNDLE\n");
    writeFileSync(join(sibling, "node_modules", "pkg", "index.js"), "DEP\n");
    writeFileSync(join(sibling, ".git", "config"), "GIT\n");
    writeFileSync(join(sibling, "notes.txt"), "NOT_WHITELISTED\n");
    writeFileSync(join(projectRoot, ".opencode", "opencode.json"), "{}\n");

    const previousDebug = process.env.SKILL_ZH_DEBUG;
    process.env.SKILL_ZH_DEBUG = "1";
    let stderrLines;
    try {
      stderrLines = withSymlinkFailure(() => {
        const { lines } = captureStderr(() =>
          symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill"),
        );
        return lines;
      });
    } finally {
      if (previousDebug === undefined) delete process.env.SKILL_ZH_DEBUG;
      else process.env.SKILL_ZH_DEBUG = previousDebug;
    }

    const target = join(evalRoot, ".opencode", "skills", "sibling");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf-8"), "SIBLING_BODY\n");
    assert.equal(readFileSync(join(target, "agents", "helper.md"), "utf-8"), "AGENT_BODY\n");
    assert.equal(readFileSync(join(target, "references", "rules.md"), "utf-8"), "RULES_BODY\n");
    // 白名单外 / 构建产物 / 依赖 / 版本库 / 超限文件都不进隔离根。
    for (const skipped of ["dist", "node_modules", ".git", "notes.txt", "references/big.bin"]) {
      assert.equal(existsSync(join(target, skipped)), false, `不应镜像：${skipped}`);
    }
    // 调试清单点名超限文件与跳过原因。
    assert.ok(
      stderrLines.some((line) => line.includes("big.bin") && line.includes("超过单文件上限")),
      "调试清单未点名超限文件",
    );
    assert.ok(
      stderrLines.some((line) => line.includes("notes.txt") && line.includes("不在技能白名单")),
      "调试清单未点名白名单外条目",
    );
  });
});

test("J1 源码门禁：src/ 内不存在 cpSync(..., { recursive })", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) files.push(child);
    }
  };
  walk("src");

  const offenders = files.filter((file) => /cpSync\([^)]*recursive/.test(readFileSync(file, "utf-8")));
  assert.deepEqual(offenders, []);
});

test("J2 源码门禁：process.cwd() 只允许出现在 bin 入口 src/cli/main.ts", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) files.push(child);
    }
  };
  walk("src/cli");
  files.push("src/tool.ts");

  /** 去掉注释后的源码（注释里写「不读 process.cwd()」不算命中）。 */
  const stripComments = (file) =>
    readFileSync(file, "utf-8")
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .replaceAll(/\/\/.*$/gm, "");

  const offenders = files
    .filter((file) => stripComments(file).includes("process.cwd("))
    .map((file) => file.replaceAll("\\", "/"));

  // 白名单钉死到唯一一个文件：独立 CLI（bin）显式把 cwd 当 directory；插件、dispatch 与
  // 各子命令仍为 0。新增任何其它 cwd 读取都会让这条断言变红。
  assert.deepEqual(offenders, ["src/cli/main.ts"]);
  assert.equal(
    stripComments("src/cli/main.ts").match(/process\.cwd\(/g)?.length,
    1,
    "bin 入口只允许 1 处 process.cwd() 调用",
  );
});

// ---------------------------------------------------------------------------
// J5：调试清单 vs 默认汇总
// ---------------------------------------------------------------------------

test("J5 未开调试时只输出汇总，不打印逐条镜像清单", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeSkill(join(projectRoot, ".opencode", "skills"), "sibling", "SIBLING_BODY\n");
    writeFileSync(join(projectRoot, ".opencode", "opencode.json"), "{}\n");

    const previousDebug = process.env.SKILL_ZH_DEBUG;
    delete process.env.SKILL_ZH_DEBUG;
    let report;
    let lines;
    try {
      const captured = captureStderr(() => {
        report = symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
      });
      lines = captured.lines;
    } finally {
      if (previousDebug !== undefined) process.env.SKILL_ZH_DEBUG = previousDebug;
    }

    assert.deepEqual(lines, []);
    assert.ok(report.entries.length > 0);
    // 符号链接可用时按链接镜像（bytes 为 0），不可用时逐文件拷贝；两种都算命中。
    assert.ok(
      report.entries.some((entry) => entry.path.includes("sibling")),
      "镜像清单未记录兄弟技能",
    );
  });
});

// ---------------------------------------------------------------------------
// J6 / J7 / J8：同名技能自动 deny、写入失败回退、开关
// ---------------------------------------------------------------------------

/**
 * 建一个「项目 + 全局同名技能」夹具。
 *
 * @param {string} root 夹具根
 * @returns {{projectRoot: string, globalSkillDir: string, globalSkillPath: string}}
 */
function makeShadowFixture(root) {
  const projectRoot = join(root, "project");
  mkdirSync(join(projectRoot, ".opencode", "skills", "sibling"), { recursive: true });
  writeFileSync(join(projectRoot, ".opencode", "skills", "sibling", "SKILL.md"), "SIBLING\n");
  writeFileSync(
    join(projectRoot, ".opencode", "opencode.json"),
    JSON.stringify({ permission: { bash: "allow" } }),
  );

  const globalSkillDir = join(root, "global-skills");
  const globalSkillPath = join(globalSkillDir, "demo-skill");
  mkdirSync(globalSkillPath, { recursive: true });
  writeFileSync(join(globalSkillPath, "SKILL.md"), "GLOBAL_DEMO\n");
  return { projectRoot, globalSkillDir, globalSkillPath };
}

test("J6 命中同名技能时在隔离根写 deny，用户目录哈希不变", async () => {
  const harness = createFakeOpencodeHarness();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skill-eval-shadow-"));
  try {
    const { projectRoot, globalSkillDir, globalSkillPath } = makeShadowFixture(fixtureRoot);
    const before = snapshot(globalSkillDir);
    const envFile = join(harness.root, "shadow-env.json");

    await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({ lines: [triggerLine("read")], envFile, exitCode: 0 });
      return runEval({
        evalSet: [{ query: "shadow", should_trigger: true }],
        skillName: "demo-skill",
        description: "Demo.",
        numWorkers: 1,
        timeout: 10,
        projectRoot,
        runsPerQuery: 1,
        skillEnumerator: async () => [{ name: "demo-skill", location: globalSkillPath }],
      });
    });

    const captured = JSON.parse(readFileSync(envFile, "utf-8"));
    assert.ok(captured.denyConfig, "隔离根未写出 .opencode/opencode.json");
    const deny = JSON.parse(captured.denyConfig);
    assert.equal(deny.permission.skill["demo-skill"], "deny");
    // 与已有配置合并，不覆盖 permission.bash。
    assert.equal(deny.permission.bash, "allow");
    // 用户目录完全没被写：文件集合与内容哈希前后一致。
    assert.deepEqual([...snapshot(globalSkillDir)], [...before]);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("J7 deny 写入失败时不启动子进程，错误带实际路径", async () => {
  const harness = createFakeOpencodeHarness();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skill-eval-denyfail-"));
  const startLog = join(harness.root, "starts.log");
  const originalWrite = fs.writeFileSync;
  try {
    const { projectRoot, globalSkillPath } = makeShadowFixture(fixtureRoot);
    fs.writeFileSync = (file, ...rest) => {
      if (String(file).replaceAll("\\", "/").endsWith(".opencode/opencode.json")) {
        throw new Error("EACCES: deny write blocked");
      }
      return originalWrite(file, ...rest);
    };
    syncBuiltinESMExports();

    await assert.rejects(
      withFakeOpencode(harness, async (writeScenario) => {
        writeScenario({ lines: [triggerLine("read")], startLog, exitCode: 0 });
        return runEval({
          evalSet: [{ query: "deny fail", should_trigger: true }],
          skillName: "demo-skill",
          description: "Demo.",
          numWorkers: 1,
          timeout: 10,
          projectRoot,
          skillEnumerator: async () => [{ name: "demo-skill", location: globalSkillPath }],
        });
      }),
      (error) => {
        assert.ok(error instanceof ShadowGuardError, `错误类型不对：${error}`);
        assert.match(error.message, /permission\.skill\.demo-skill/);
        assert.deepEqual(error.locations, [globalSkillPath]);
        return true;
      },
    );

    assert.equal(existsSync(startLog), false, "deny 写入失败后仍启动了 opencode run");
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    rmSync(fixtureRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("J8 --no-shadow-guard：不写 deny，命中同名即中止；无冲突时正常评测", async () => {
  const harness = createFakeOpencodeHarness();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skill-eval-noshadow-"));
  const startLog = join(harness.root, "starts.log");
  try {
    const { projectRoot, globalSkillPath } = makeShadowFixture(fixtureRoot);

    await assert.rejects(
      withFakeOpencode(harness, async (writeScenario) => {
        writeScenario({ lines: [triggerLine("read")], startLog, exitCode: 0 });
        return runEval({
          evalSet: [{ query: "blocked", should_trigger: true }],
          skillName: "demo-skill",
          description: "Demo.",
          numWorkers: 1,
          timeout: 10,
          projectRoot,
          shadowGuard: false,
          skillEnumerator: async () => [{ name: "demo-skill", location: globalSkillPath }],
        });
      }),
      (error) => {
        assert.ok(error instanceof ShadowGuardError);
        assert.match(error.message, /检测到同名技能/);
        assert.deepEqual(error.locations, [globalSkillPath]);
        return true;
      },
    );
    assert.equal(existsSync(startLog), false, "关闭屏蔽后仍启动了子进程");

    // 无同名技能时开关不影响执行。
    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({ lines: [triggerLine("read")], exitCode: 0 });
      return runEval({
        evalSet: [{ query: "ok", should_trigger: true }],
        skillName: "demo-skill",
        description: "Demo.",
        numWorkers: 1,
        timeout: 10,
        projectRoot,
        shadowGuard: false,
        skillEnumerator: async () => [],
      });
    });
    assert.equal(output.results[0].pass, true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// J9：镜像范围固定为方案 C 的四项
// ---------------------------------------------------------------------------

test("J9 隔离根只含四项：根配置及引用 + .opencode 非 skills 条目 + 兄弟技能", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeFileSync(join(projectRoot, "opencode.json"), JSON.stringify({ instructions: ["./rules/a.md"] }));
    mkdirSync(join(projectRoot, "rules"), { recursive: true });
    writeFileSync(join(projectRoot, "rules", "a.md"), "ROOT_RULES\n");
    mkdirSync(join(projectRoot, ".opencode", "agent"), { recursive: true });
    writeFileSync(join(projectRoot, ".opencode", "agent", "planner.md"), "AGENT\n");
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    writeSkill(skillsRoot, "sibling", "SIBLING_BODY\n");
    writeSkill(skillsRoot, "demo-skill", "DEMO_SECRET_BODY\n");
    mkdirSync(join(projectRoot, "src"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "main.ts"), "SOURCE\n");
    mkdirSync(join(projectRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(projectRoot, "node_modules", "pkg", "index.js"), "DEP\n");

    symlinkProjectOpenCodeConfig(
      projectRoot,
      evalRoot,
      "demo-skill",
      join(skillsRoot, "demo-skill"),
    );

    const topLevel = readdirSync(evalRoot).sort();
    assert.deepEqual(topLevel, [".opencode", "opencode.json", "rules"]);
    assert.equal(readFileSync(join(evalRoot, "rules", "a.md"), "utf-8"), "ROOT_RULES\n");
    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "agent", "planner.md"), "utf-8"),
      "AGENT\n",
    );
    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "skills", "sibling", "SKILL.md"), "utf-8"),
      "SIBLING_BODY\n",
    );
    // 被测技能按内容哈希不可见；项目源码/依赖不进隔离根。
    assert.deepEqual(findFilesContaining(evalRoot, "DEMO_SECRET_BODY"), []);
    assert.equal(existsSync(join(evalRoot, "src")), false);
    assert.equal(existsSync(join(evalRoot, "node_modules")), false);
  });
});

/**
 * 探测当前平台是否允许创建符号链接（Windows 需管理员或开发者模式）。
 *
 * @returns {boolean} 能建出目录符号链接时为 true
 */
function detectSymlinkSupport() {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-j-symlink-probe-"));
  try {
    mkdirSync(join(root, "target"), { recursive: true });
    symlinkSync(join(root, "target"), join(root, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SYMLINK_SUPPORTED = detectSymlinkSupport();

test("J1 降级镜像不跟随入口符号链接（root 是链接时跳过）", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法构造入口别名");
    return;
  }

  const outside = mkdtempSync(join(tmpdir(), "skill-eval-j-outside-"));
  try {
    writeFileSync(join(outside, "secret.md"), "OUTSIDE_SECRET\n");
    withProjectAndEvalRoots((projectRoot, evalRoot) => {
      mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
      writeFileSync(join(projectRoot, ".opencode", "opencode.json"), "{}\n");
      // ① .opencode 下一条指向外部目录的别名；② 根配置引用一个根级别名。
      symlinkSync(outside, join(projectRoot, ".opencode", "agent-alias"), "dir");
      symlinkSync(outside, join(projectRoot, "root-alias"), "dir");
      writeFileSync(
        join(projectRoot, "opencode.json"),
        JSON.stringify({ instructions: ["./root-alias"] }),
      );

      const previousDebug = process.env.SKILL_ZH_DEBUG;
      process.env.SKILL_ZH_DEBUG = "1";
      let lines;
      try {
        const captured = captureStderr(() =>
          withSymlinkFailure(() =>
            symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill"),
          ),
        );
        lines = captured.lines;
      } finally {
        if (previousDebug === undefined) delete process.env.SKILL_ZH_DEBUG;
        else process.env.SKILL_ZH_DEBUG = previousDebug;
      }

      // 入口符号链接必须整体跳过，绝不把外部目录内容搬进隔离根。
      assert.equal(existsSync(join(evalRoot, ".opencode", "agent-alias")), false);
      assert.equal(existsSync(join(evalRoot, "root-alias")), false);
      assert.deepEqual(findFilesContaining(evalRoot, "OUTSIDE_SECRET"), []);
      assert.ok(
        lines.some((line) => line.includes("agent-alias") && line.includes("符号链接条目")),
        "调试清单未点名跳过的入口符号链接",
      );
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("J6 applySkillDeny 优先写项目实际使用的 opencode.jsonc", () => {
  withProjectAndEvalRoots((_projectRoot, evalRoot) => {
    mkdirSync(join(evalRoot, ".opencode"), { recursive: true });
    writeFileSync(
      join(evalRoot, ".opencode", "opencode.jsonc"),
      '{ "model": "demo", "permission": { "bash": "allow" } }\n',
    );

    applySkillDeny(evalRoot, ["demo-skill"]);

    const merged = parseJsonc(readFileSync(join(evalRoot, ".opencode", "opencode.jsonc"), "utf-8"));
    assert.equal(merged.model, "demo");
    assert.equal(merged.permission.bash, "allow");
    assert.equal(merged.permission.skill["demo-skill"], "deny");
    // 不得另建 opencode.json 造成两份配置。
    assert.equal(existsSync(join(evalRoot, ".opencode", "opencode.json")), false);
  });
});

test("J7 枚举不可用（生产路径）→ 中止且不启动子进程", async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "skill-eval-j-enumnull-"));
  try {
    writeSkill(join(projectRoot, ".opencode", "skills"), "sibling", "SIBLING\n");
    await assert.rejects(
      runEval({
        evalSet: [{ query: "q", should_trigger: true }],
        skillName: "demo-skill",
        description: "Demo.",
        numWorkers: 1,
        timeout: 10,
        projectRoot,
        skillEnumerator: async () => null,
      }),
      (error) => {
        assert.ok(error instanceof ShadowGuardError);
        assert.deepEqual(error.locations, []);
        assert.match(error.message, /无法枚举/);
        return true;
      },
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("J7 单条 query 的 deny 写入失败 → 整轮中止（不计入 errored）", async () => {
  const harness = createFakeOpencodeHarness();
  const fixtureRoot = mkdtempSync(join(tmpdir(), "skill-eval-j-fatal-"));
  const startLog = join(harness.root, "starts.log");
  const originalWrite = fs.writeFileSync;
  try {
    const { projectRoot, globalSkillPath } = makeShadowFixture(fixtureRoot);
    await assert.rejects(
      withFakeOpencode(harness, async (writeScenario) => {
        writeScenario({ lines: [triggerLine("read")], startLog, exitCode: 0 });
        fs.writeFileSync = (file, ...rest) => {
          const target = String(file).replaceAll("\\", "/");
          // 只让「正式评测根」的 deny 写入失败；预检探针根仍可写。
          if (
            target.includes("opencode-skill-eval-") &&
            !target.includes("probe") &&
            target.endsWith(".opencode/opencode.json")
          ) {
            throw new Error("EACCES: per-query deny blocked");
          }
          return originalWrite(file, ...rest);
        };
        syncBuiltinESMExports();
        return runEval({
          evalSet: [{ query: "fatal", should_trigger: true }],
          skillName: "demo-skill",
          description: "Demo.",
          numWorkers: 1,
          timeout: 10,
          projectRoot,
          skillEnumerator: async () => [{ name: "demo-skill", location: globalSkillPath }],
        });
      }),
      (error) => {
        assert.ok(error instanceof IsolationError, `错误类型不对：${error}`);
        assert.match(error.message, /隔离根准备失败/);
        return true;
      },
    );

    const evalStarts = existsSync(startLog)
      ? readFileSync(startLog, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.cwd !== realpathSync(projectRoot))
      : [];
    assert.deepEqual(evalStarts, [], "deny 失败后仍启动了评测子进程");
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    rmSync(fixtureRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});
