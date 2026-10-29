/**
 * `skill_zh package` 的白名单导出、`--out` 校验与结构自检（docs/SPEC.md R2/R6.1-I1、docs/tools.md `package`）。
 *
 * 全部在系统临时目录里跑；导出目标都在临时根内，不写仓库与用户目录。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runCommand } from "../dist/cli/dispatch.js";
import { parseArgs } from "../dist/cli/parse-args.js";

/**
 * 在临时根里执行用例，结束后递归删除。
 *
 * @param {(root: string) => unknown} fn 用例体
 * @returns 用例体返回值
 */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "skill-creator-package-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  try {
    return fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 分发上下文：项目目录即临时根。
 *
 * @param root 临时根
 * @returns 上下文对象
 */
function ctxOf(root) {
  return { directory: root, worktree: root };
}

/** 统一成 `/` 分隔，便于拼 args 与断言。 */
const toDisplay = (path) => path.replaceAll("\\", "/");

/**
 * 探测当前平台能否创建目录符号链接。
 *
 * @returns 能创建时返回 `true`
 */
function detectSymlinkSupport() {
  const root = mkdtempSync(join(tmpdir(), "osc-package-link-"));
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

/** 当前平台是否支持符号链接；不支持时相关用例 skip。 */
const SYMLINK_SUPPORTED = detectSymlinkSupport();

/**
 * 按相对路径写文件。
 *
 * @param root 容器目录
 * @param rel 相对路径
 * @param content 内容
 */
function writeFile(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/**
 * 造一个合规技能目录（含 `references/`）。
 *
 * @param root 临时根
 * @param name 目录名
 * @returns 技能目录绝对路径
 */
function writeValidSkill(root, name) {
  const skillDir = join(root, "skills", name);
  writeFile(
    root,
    `skills/${name}/SKILL.md`,
    ["---", `name: ${name}`, "description: 导出测试技能", "---", "", "# 测试技能", ""].join("\n"),
  );
  writeFile(root, `skills/${name}/references/ref.md`, "reference\n");
  return skillDir;
}

/**
 * 递归列出目录下的普通文件（相对 POSIX 路径）。
 *
 * @param root 根目录
 * @returns 排序后的相对路径
 */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(toDisplay(join(dir, entry.name).slice(root.length + 1)));
    }
  };
  walk(root);
  return out.sort();
}

test("只导出白名单内容，白名单外条目跳过并列出", () => {
  withTempRoot((root) => {
    const skillDir = writeValidSkill(root, "demo-skill");
    writeFile(skillDir, "agents/helper.md", "agent\n");
    writeFile(skillDir, "templates/page.html", "<html></html>\n");
    writeFile(skillDir, "dist/index.js", "build\n");
    writeFile(skillDir, "bin/run.js", "bin\n");
    writeFile(skillDir, "test/x.test.js", "test\n");
    writeFile(skillDir, "notes.md", "root file outside whitelist\n");

    const outDir = join(root, "pkg", "demo-skill");
    const result = runCommand(
      parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(outDir)}"`),
      ctxOf(root),
    );

    assert.equal(result.ok, true, result.output);
    assert.deepEqual(listFiles(outDir), [
      "SKILL.md",
      "agents/helper.md",
      "references/ref.md",
      "templates/page.html",
    ]);
    for (const skipped of ["dist/", "bin/", "test/", "notes.md"]) {
      assert.ok(result.output.includes(skipped), `输出未列出跳过的 ${skipped}`);
    }
    assert.ok(!existsSync(join(outDir, "dist")));
    assert.ok(!existsSync(join(outDir, "notes.md")));
  });
});

test("--out 必填：缺 --out / 缺技能目录都走三段式并给可照抄示例", () => {
  withTempRoot((root) => {
    const skillDir = writeValidSkill(root, "demo-skill");

    const noOut = runCommand(parseArgs(`package "${toDisplay(skillDir)}"`), ctxOf(root));
    assert.equal(noOut.ok, false);
    const noOutLines = noOut.output.split("\n");
    assert.equal(noOutLines.length, 3);
    assert.equal(noOutLines[0], "错误：缺少参数 --out <产物路径>");
    assert.ok(noOutLines[1].includes("skill_zh package"));

    const noTarget = runCommand(parseArgs("package"), ctxOf(root));
    assert.equal(noTarget.ok, false);
    assert.equal(noTarget.output.split("\n")[0], "错误：缺少参数 <技能目录>");
  });
});

test("拒绝导出到源目录内部（子目录与源目录本身）", () => {
  withTempRoot((root) => {
    const skillDir = writeValidSkill(root, "demo-skill");

    for (const outDir of [skillDir, join(skillDir, "dist")]) {
      const result = runCommand(
        parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(outDir)}"`),
        ctxOf(root),
      );
      assert.equal(result.ok, false, result.output);
      assert.match(result.output.split("\n")[0], /导出目标不能是技能目录本身或其子目录/);
    }
    // 没有在源目录里留下导出副本。
    assert.ok(!existsSync(join(skillDir, "dist")));
  });
});

test("结构不合规拒绝导出，不产出半成品", () => {
  withTempRoot((root) => {
    // 目录名与 frontmatter name 不一致。
    const skillDir = join(root, "skills", "wrong-dir");
    writeFile(
      root,
      "skills/wrong-dir/SKILL.md",
      ["---", "name: demo-skill", "description: 导出测试技能", "---", "", "# 测试技能", ""].join("\n"),
    );
    mkdirSync(join(skillDir, "references"), { recursive: true });

    const outDir = join(root, "pkg");
    const result = runCommand(
      parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(outDir)}"`),
      ctxOf(root),
    );

    assert.equal(result.ok, false);
    assert.match(result.output, /^错误：导出前校验未通过/);
    assert.ok(result.output.includes("目录名与 frontmatter name 不一致"));
    assert.ok(!existsSync(join(outDir, "SKILL.md")));
  });
});

test("缺少 references/ 时拒绝导出", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "skills", "no-refs");
    writeFile(
      root,
      "skills/no-refs/SKILL.md",
      ["---", "name: no-refs", "description: 导出测试技能", "---", "", "# 测试技能", ""].join("\n"),
    );

    const result = runCommand(
      parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(join(root, "pkg"))}"`),
      ctxOf(root),
    );

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("缺少 references/ 目录"));
  });
});

test("文件清单含相对路径与字节数", () => {
  withTempRoot((root) => {
    const skillDir = writeValidSkill(root, "demo-skill");
    const outDir = join(root, "pkg", "demo-skill");

    const result = runCommand(
      parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(outDir)}"`),
      ctxOf(root),
    );

    assert.equal(result.ok, true, result.output);
    for (const rel of ["SKILL.md", "references/ref.md"]) {
      const size = statSync(join(outDir, rel)).size;
      assert.ok(result.output.includes(`${rel}  ${size} 字节`), `清单缺少 ${rel} / ${size}`);
    }
    assert.ok(result.output.includes("npm 发布由用户手动执行"));
    assert.equal(readFileSync(join(outDir, "references", "ref.md"), "utf-8"), "reference\n");
  });
});

test("正向绕过：--out 经符号链接指向源目录内部时仍被拒绝", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台无法创建符号链接（Windows 需管理员或开发者模式）");
    return;
  }
  withTempRoot((root) => {
    const skillDir = join(root, "real-skill");
    writeFile(
      root,
      "real-skill/SKILL.md",
      ["---", "name: real-skill", "description: 导出测试技能", "---", "", "# 测试技能", ""].join("\n"),
    );
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "references", "ref.md"), "reference\n");

    const link = join(root, "link-skill");
    symlinkSync(skillDir, link, "dir");

    const result = runCommand(
      parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(join(link, "dist"))}"`),
      ctxOf(root),
    );

    assert.equal(result.ok, false, result.output);
    assert.match(result.output.split("\n")[0], /子目录/);
    assert.ok(!existsSync(join(skillDir, "dist")));
  });
});

test("反向祖先：--out 是技能目录的祖先时被拒绝", () => {
  withTempRoot((root) => {
    const skillDir = writeValidSkill(root, "demo-skill");
    const result = runCommand(
      parseArgs(`package "${toDisplay(skillDir)}" --out "${toDisplay(join(root, "skills"))}"`),
      ctxOf(root),
    );

    assert.equal(result.ok, false, result.output);
    assert.match(result.output.split("\n")[0], /祖先目录/);
    assert.ok(!existsSync(join(root, "skills", "SKILL.md")));
  });
});
