/**
 * `lib/run-eval` 的离线可跑部分：项目根探测、配置镜像与三道技能排除守卫、冲突枚举。
 *
 * 用例迁自上游 `.tmp/old/plugin/test/run-eval.test.ts`（基线 `d4383924`）里不依赖真实
 * `opencode` 子进程的部分；需要真跑 `opencode run`、网络或产生费用的端到端用例不在此
 * 文件（见交接清单）。
 *
 * 写盘一律 `os.tmpdir()` + `mkdtempSync`，每个用例在 `finally` 里递归清理；依赖文件
 * 系统符号链接的用例在平台不支持时显式 skip 并说明。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import {
  createV2SkillEnumerator,
  findProjectRoot,
  findSkillConflicts,
  findSkillConflictsInList,
  symlinkProjectOpenCodeConfig,
} from "../dist/lib/run-eval.js";

/**
 * 探测当前平台是否允许创建符号链接（Windows 需管理员或开发者模式）。
 *
 * @returns 能在临时目录里建出目录符号链接时返回 `true`
 */
const detectSymlinkSupport = () => {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-symlink-probe-"));
  try {
    mkdirSync(join(root, "target"), { recursive: true });
    symlinkSync(join(root, "target"), join(root, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/** 当前平台是否支持符号链接；不支持时相关用例 skip。 */
const SYMLINK_SUPPORTED = detectSymlinkSupport();

/**
 * 建一对「项目根 + 评测根」临时目录并在结束时清理。
 *
 * @param {(projectRoot: string, evalRoot: string) => unknown} body 用例主体
 * @returns {unknown} 主体返回值
 */
const withProjectAndEvalRoots = (body) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "skill-eval-project-"));
  const evalRoot = mkdtempSync(join(tmpdir(), "skill-eval-root-"));
  try {
    return body(projectRoot, evalRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(evalRoot, { recursive: true, force: true });
  }
};

/**
 * 在给定目录下写一个技能目录（含 `SKILL.md`）。
 *
 * @param parent 技能目录的父目录
 * @param name 技能目录名
 * @param body `SKILL.md` 正文
 */
const writeSkill = (parent, name, body) => {
  mkdirSync(join(parent, name), { recursive: true });
  writeFileSync(join(parent, name, "SKILL.md"), body);
};

/**
 * 执行主体并收集期间写到 stderr 的告警（`console.error`）。
 *
 * @param {(warnings: string[]) => unknown} body 用例主体
 * @returns {unknown} 主体返回值
 */
const withStderrCapture = (body) => {
  const warnings = [];
  const originalError = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    return body(warnings);
  } finally {
    console.error = originalError;
  }
};

// ---------------------------------------------------------------------------
// findProjectRoot：仅独立 CLI 兜底；跳过运行时目录、校验项目形态
// ---------------------------------------------------------------------------

test("findProjectRoot 命中祖先目录的 .opencode/skills 时返回该目录", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-rootprobe-"));
  try {
    mkdirSync(join(root, ".opencode", "skills"), { recursive: true });
    mkdirSync(join(root, "nested", "deeper"), { recursive: true });

    assert.equal(findProjectRoot(join(root, "nested", "deeper")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot 不采纳只有 .claude/skills 的目录（与 SPEC J2 对齐）", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-claudeprobe-"));
  try {
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    const start = join(root, "nested");
    mkdirSync(start, { recursive: true });

    assert.equal(findProjectRoot(start), start);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot 采纳带项目配置文档的祖先目录", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-configprobe-"));
  try {
    writeFileSync(join(root, "opencode.json"), "{}\n");
    mkdirSync(join(root, "nested"), { recursive: true });

    assert.equal(findProjectRoot(join(root, "nested")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot 不采纳只有 .opencode/ 而无 skills/配置的目录", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-shapeless-"));
  try {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    const start = join(root, "nested");
    mkdirSync(start, { recursive: true });

    assert.equal(findProjectRoot(start), start);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findProjectRoot 不返回 home（~/.opencode 是运行时目录），回退起点", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "skill-eval-home-"));
  const workdir = join(fakeHome, "work");
  try {
    // home 自身带 .opencode/skills（运行时目录）也会被 arguably 判成项目形态 ——
    // 必须靠「home 不算项目根」这条排除掉，否则从 home 子目录调用会返回 home。
    mkdirSync(join(fakeHome, ".opencode", "skills"), { recursive: true });
    mkdirSync(workdir, { recursive: true });

    assert.equal(findProjectRoot(workdir, fakeHome), workdir);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("findProjectRoot 在绝对临时路径上不命中时回退传入的起点", () => {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-nomarker-"));
  try {
    const start = join(root, "nested");
    mkdirSync(start, { recursive: true });
    assert.equal(findProjectRoot(start), start);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// linkOrCopyConfigEntry：镜像单个配置条目（幂等 / 优先符号链接 / 回退拷贝）
// ---------------------------------------------------------------------------

test("配置镜像对已存在的目标保持原样（幂等，不覆盖）", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeSkill(join(projectRoot, ".opencode", "skills"), "sibling", "SIBLING_BODY\n");
    writeFileSync(join(projectRoot, ".opencode", "opencode.json"), '{"from":"source"}\n');
    // 评测根里已有同名条目（模拟上一轮镜像的残留）：必须原样保留，不覆盖、不报 EEXIST。
    mkdirSync(join(evalRoot, ".opencode"), { recursive: true });
    writeFileSync(join(evalRoot, ".opencode", "opencode.json"), '{"from":"eval-root"}\n');

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "opencode.json"), "utf-8"),
      '{"from":"eval-root"}\n',
    );
    assert.ok(existsSync(join(evalRoot, ".opencode", "skills", "sibling")));
  });
});

test("配置镜像在符号链接可用时为条目建链接", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法验证「优先链接」分支");
    return;
  }

  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const configSource = join(projectRoot, ".opencode", "opencode.json");
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(configSource, "{}\n");
    const skillSource = join(projectRoot, ".opencode", "skills", "sibling");
    writeSkill(join(projectRoot, ".opencode", "skills"), "sibling", "SIBLING_BODY\n");

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    const configTarget = join(evalRoot, ".opencode", "opencode.json");
    assert.ok(lstatSync(configTarget).isSymbolicLink());
    assert.equal(readFileSync(configTarget, "utf-8"), "{}\n");

    const skillTarget = join(evalRoot, ".opencode", "skills", "sibling");
    assert.ok(lstatSync(skillTarget).isSymbolicLink());
    assert.equal(readFileSync(join(skillTarget, "SKILL.md"), "utf-8"), "SIBLING_BODY\n");
    // 链接必须指向源，否则隔离根看到的是旧副本。
    assert.equal(readlinkSync(skillTarget).replaceAll("\\", "/").toLowerCase(), skillSource.replaceAll("\\", "/").toLowerCase());
  });
});

test("配置镜像在符号链接不可用时回退为递归拷贝", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(join(projectRoot, ".opencode", "opencode.json"), '{"copied":true}\n');
    writeSkill(join(projectRoot, ".opencode", "skills"), "sibling", "SIBLING_BODY\n");
    writeSkill(join(projectRoot, ".opencode", "skills"), "tested-skill", "TESTED_BODY\n");

    // 模拟「符号链接不可用」（Windows 未开管理员/开发者模式时 EPERM）。ESM 对内置模块
    // 的具名导入是内置门面的快照，改 `fs` 上的属性后必须再同步一次才生效。
    const originalSymlink = fs.symlinkSync;
    fs.symlinkSync = () => {
      const error = new Error("EPERM: operation not permitted, symlink");
      error.code = "EPERM";
      throw error;
    };
    syncBuiltinESMExports();
    try {
      symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
    } finally {
      fs.symlinkSync = originalSymlink;
      syncBuiltinESMExports();
    }

    const configTarget = join(evalRoot, ".opencode", "opencode.json");
    assert.equal(lstatSync(configTarget).isSymbolicLink(), false);
    assert.equal(readFileSync(configTarget, "utf-8"), '{"copied":true}\n');

    const siblingTarget = join(evalRoot, ".opencode", "skills", "sibling");
    assert.equal(lstatSync(siblingTarget).isSymbolicLink(), false);
    assert.equal(readFileSync(join(siblingTarget, "SKILL.md"), "utf-8"), "SIBLING_BODY\n");
    // 回退拷贝不得顺手把被测技能带进来。
    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "tested-skill")), false);
  });
});

// ---------------------------------------------------------------------------
// referencesSkillsRoot：`.opencode/skills` 根自身及其内部一律不镜像
// ---------------------------------------------------------------------------

test("referencesSkillsRoot 直接命中时，根配置引用 skills 下被测技能文件也不镜像", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    writeSkill(skillsRoot, "tested-skill", "TESTED_BODY\n");
    writeSkill(skillsRoot, "sibling", "SIBLING_BODY\n");
    writeFileSync(join(projectRoot, "notes.md"), "NOTES_BODY\n");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        instructions: [".opencode/skills/tested-skill/SKILL.md", "./notes.md"],
      }),
    );

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    // 技能目录镜像循环按名字跳过了被测技能；根配置引用也必须在规范化比较处被拦下，
    // 否则这条引用会凭空把它的 SKILL.md 拷进隔离根。
    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "tested-skill")), false);
    assert.equal(readFileSync(join(evalRoot, "notes.md"), "utf-8"), "NOTES_BODY\n");
  });
});

test("referencesSkillsRoot 按规范化路径识别指向 skills 的别名", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法构造别名");
    return;
  }

  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeSkill(join(projectRoot, ".opencode", "skills"), "victim-skill", "VICTIM_BODY\n");
    writeFileSync(join(projectRoot, ".opencode", "opencode.json"), "{}\n");
    // ① 根目录里一个指向 skills 的词法兄弟别名；② `.opencode/` 里一个指向 skills 的条目。
    symlinkSync(
      join(projectRoot, ".opencode", "skills"),
      join(projectRoot, "alias-skills"),
      "dir",
    );
    symlinkSync(
      join(projectRoot, ".opencode", "skills"),
      join(projectRoot, ".opencode", "alias-entry"),
      "dir",
    );
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ instructions: ["./alias-skills"] }),
    );
    writeFileSync(join(projectRoot, "shared.md"), "SHARED_BODY\n");
    writeFileSync(
      join(projectRoot, "opencode.jsonc"),
      JSON.stringify({ instructions: ["./shared.md"] }),
    );

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    assert.equal(existsSync(join(evalRoot, "alias-skills")), false);
    assert.equal(existsSync(join(evalRoot, ".opencode", "alias-entry")), false);
    // 合法条目仍照常镜像（守卫不能把 `.opencode` 下的东西整体扫出去）。
    assert.ok(existsSync(join(evalRoot, ".opencode", "opencode.json")));
    assert.equal(readFileSync(join(evalRoot, "shared.md"), "utf-8"), "SHARED_BODY\n");
  });
});

test("referencesSkillsRoot 不误判后缀相似名：skills2 目录照常镜像", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeSkill(join(projectRoot, ".opencode", "skills"), "tested-skill", "TESTED_BODY\n");
    mkdirSync(join(projectRoot, "skills2"), { recursive: true });
    writeFileSync(join(projectRoot, "skills2", "rules.md"), "SKILLS2_RULES\n");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ instructions: ["./skills2", "./skills2/rules.md"] }),
    );

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    // 纯前缀比较会把 `skills2` 误当成 `.opencode/skills` 的后代。
    assert.equal(readFileSync(join(evalRoot, "skills2", "rules.md"), "utf-8"), "SKILLS2_RULES\n");
  });
});

// ---------------------------------------------------------------------------
// isWithinExcludedSkill / isAncestorOfExcludedSkill：被测候选本体与其祖先
// ---------------------------------------------------------------------------

/**
 * 在评测根里递归查找内容包含 `needle` 的可读文件（符号链接按链接目标读）。
 *
 * @param root 起始目录
 * @param needle 要搜索的内容片段
 * @returns 命中的文件路径列表
 */
const findFilesContaining = (root, needle) => {
  const found = [];
  const walk = (base) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const child = join(base, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      const source = lstatSync(child).isSymbolicLink() ? readlinkSync(child) : child;
      try {
        if (readFileSync(source, "utf-8").includes(needle)) found.push(child);
      } catch {
        // 悬空链接或不可读文件：不计入命中，`assert` 仍会因其它路径失败。
      }
    }
  };
  walk(root);
  return found;
};

test("isWithinExcludedSkill：候选在 .opencode/skills 之外时，本体/别名/{file:} 引用都不镜像", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法构造候选别名");
    return;
  }

  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const secret = "CANDIDATE_BODY_SECRET";
    mkdirSync(join(projectRoot, "candidate"), { recursive: true });
    writeFileSync(
      join(projectRoot, "candidate", "SKILL.md"),
      ["---", "name: candidate", "description: Candidate under test.", "---", "", secret, ""].join("\n"),
    );
    writeFileSync(join(projectRoot, "notes.md"), "UNRELATED_NOTES\n");
    writeFileSync(
      join(projectRoot, "opencode.jsonc"),
      JSON.stringify({
        instructions: [
          "./candidate/SKILL.md",
          "./candidate",
          // 别名必须**被引用**才算真正进入镜像链：守卫要拿它跟候选的规范化路径比，
          // 否则 `candidate-alias` 根本不会被考虑，断言恒真、测不出守卫是否生效。
          "./candidate-alias",
          "{file:candidate/SKILL.md}",
          "./notes.md",
        ],
      }),
    );
    symlinkSync(join(projectRoot, "candidate"), join(projectRoot, "candidate-alias"), "dir");

    symlinkProjectOpenCodeConfig(
      projectRoot,
      evalRoot,
      "candidate",
      join(projectRoot, "candidate"),
    );

    assert.deepEqual(findFilesContaining(evalRoot, secret), []);
    assert.equal(existsSync(join(evalRoot, "candidate")), false);
    assert.equal(existsSync(join(evalRoot, "candidate-alias")), false);
    // 无关兄弟仍如实镜像（守卫只排除候选，不搞连坐）。
    assert.equal(readFileSync(join(evalRoot, "notes.md"), "utf-8"), "UNRELATED_NOTES\n");
  });
});

test("isAncestorOfExcludedSkill：候选的祖先目录引用被拒绝并给出告警", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const secret = "ANCESTOR_SECRET";
    mkdirSync(join(projectRoot, "skills", "candidate"), { recursive: true });
    writeFileSync(
      join(projectRoot, "skills", "candidate", "SKILL.md"),
      ["---", "name: candidate", "description: x", "---", "", secret, ""].join("\n"),
    );
    writeFileSync(
      join(projectRoot, "opencode.jsonc"),
      JSON.stringify({ instructions: ["./skills", "./notes.md"] }),
    );
    writeFileSync(join(projectRoot, "notes.md"), "UNRELATED_NOTES\n");

    const warnings = [];
    withStderrCapture((captured) => {
      symlinkProjectOpenCodeConfig(
        projectRoot,
        evalRoot,
        "candidate",
        join(projectRoot, "skills", "candidate"),
      );
      warnings.push(...captured);
    });

    assert.equal(existsSync(join(evalRoot, "skills")), false);
    assert.deepEqual(findFilesContaining(evalRoot, secret), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /containing the tested skill/);
    // 无关兄弟仍按相对位置镜像。
    assert.equal(readFileSync(join(evalRoot, "notes.md"), "utf-8"), "UNRELATED_NOTES\n");
  });
});

test("被测候选在 .opencode/skills 内时，本体与候选别名被排除、兄弟技能保留", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法构造候选别名");
    return;
  }

  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    writeSkill(skillsRoot, "candidate", "W1_CANDIDATE_SECRET\n");
    writeSkill(skillsRoot, "sibling", "SIBLING_BODY\n");
    symlinkSync(join(skillsRoot, "candidate"), join(skillsRoot, "candidate-alias"), "dir");

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "candidate", join(skillsRoot, "candidate"));

    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "candidate")), false);
    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "candidate-alias")), false);
    // 合法兄弟必须仍然镜像（不能一刀切排除整个 skills）。
    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "skills", "sibling", "SKILL.md"), "utf-8"),
      "SIBLING_BODY\n",
    );
  });
});

test("省略 excludedSkillPath 时按 .opencode/skills/<skillName> 推导候选并保留兄弟", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    writeSkill(skillsRoot, "candidate", "OMITTED_SECRET\n");
    writeSkill(skillsRoot, "sibling", "SIBLING_BODY\n");

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "candidate");

    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "candidate")), false);
    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "skills", "sibling", "SKILL.md"), "utf-8"),
      "SIBLING_BODY\n",
    );
  });
});

test("指向整个 skills 根的别名被排除，兄弟技能保留", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法构造整根别名");
    return;
  }

  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    writeSkill(skillsRoot, "candidate", "---\nname: candidate\n---\n");
    writeSkill(skillsRoot, "sibling", "SIBLING_BODY\n");
    // `.opencode/skills/whole -> .opencode/skills` 会把每个技能（含被测）带回来。
    symlinkSync(skillsRoot, join(skillsRoot, "whole"), "dir");

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "candidate");

    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "whole")), false);
    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "skills", "sibling", "SKILL.md"), "utf-8"),
      "SIBLING_BODY\n",
    );
  });
});

test("指向候选父目录的别名（祖先）被拒绝", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台不允许创建符号链接，无法构造父级别名");
    return;
  }

  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    const skillsRoot = join(projectRoot, ".opencode", "skills");
    writeSkill(join(skillsRoot, "nested"), "candidate", "PARENT_SECRET\n");
    writeSkill(skillsRoot, "sibling", "SIBLING_BODY\n");
    // `parent-alias -> nested` 是候选的祖先，拷贝它会连带候选一起带进来。
    symlinkSync(join(skillsRoot, "nested"), join(skillsRoot, "parent-alias"), "dir");

    symlinkProjectOpenCodeConfig(
      projectRoot,
      evalRoot,
      "candidate",
      join(skillsRoot, "nested", "candidate"),
    );

    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "parent-alias")), false);
    assert.equal(existsSync(join(evalRoot, ".opencode", "skills", "nested")), false);
    assert.equal(
      readFileSync(join(evalRoot, ".opencode", "skills", "sibling", "SKILL.md"), "utf-8"),
      "SIBLING_BODY\n",
    );
  });
});

test("JSONC 配置的行注释、块注释与尾逗号照常读出引用", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    mkdirSync(join(projectRoot, "rules"), { recursive: true });
    writeFileSync(join(projectRoot, "rules", "a.md"), "A_RULES\n");
    writeFileSync(join(projectRoot, "rules", "a.md.bak"), "BACKUP\n");
    writeFileSync(
      join(projectRoot, "opencode.jsonc"),
      [
        "/* 顶部块注释 */",
        "{",
        "  // 行注释",
        '  "instructions": ["./rules/*.md",],',
        "}",
        "",
      ].join("\n"),
    );

    const warnings = [];
    withStderrCapture((captured) => {
      symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
      warnings.push(...captured);
    });

    assert.deepEqual(warnings, []);
    assert.equal(readFileSync(join(evalRoot, "rules", "a.md"), "utf-8"), "A_RULES\n");
    // `*.md` 不得把 `a.md.bak` 也选进来。
    assert.equal(existsSync(join(evalRoot, "rules", "a.md.bak")), false);
  });
});

test("JSONC 配置里字符串内的 // 与 /* 不被当成注释剥掉", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    mkdirSync(join(projectRoot, "rules"), { recursive: true });
    mkdirSync(join(projectRoot, "docs"), { recursive: true });
    writeFileSync(join(projectRoot, "rules", "a.md"), "A_RULES\n");
    writeFileSync(join(projectRoot, "docs", "x.md"), "DOC_RULES\n");
    // 两处都是字符串**内部**的注释起始符：`./rules//a.md` 的 `//`、`./docs/*.md` 的 `/*`。
    // 任何「先剥注释再 JSON.parse」的实现都会从这里开始吞掉后面的内容（后者甚至吞到
    // 文件尾），把两条合法引用一起弄丢；JSONC 解析器则原样保留字符串。
    writeFileSync(
      join(projectRoot, "opencode.jsonc"),
      '{ "instructions": ["./rules//a.md", "./docs/*.md"] }\n',
    );

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    assert.equal(readFileSync(join(evalRoot, "rules", "a.md"), "utf-8"), "A_RULES\n");
    assert.equal(readFileSync(join(evalRoot, "docs", "x.md"), "utf-8"), "DOC_RULES\n");
  });
});

test("JSONC 配置里字符串的转义引号不会截断解析", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeFileSync(join(projectRoot, "notes.md"), "NOTES_BODY\n");
    writeFileSync(
      join(projectRoot, "opencode.jsonc"),
      '{ "description": "带 \\"引号\\" 与 // 的值", "instructions": ["./notes.md"] }\n',
    );

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    assert.equal(readFileSync(join(evalRoot, "notes.md"), "utf-8"), "NOTES_BODY\n");
  });
});

test("JSONC 配置完全无法解析时按无引用处理且不抛错", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeFileSync(join(projectRoot, "notes.md"), "NOTES_BODY\n");
    writeFileSync(join(projectRoot, "opencode.jsonc"), "not json at all\n");

    const warnings = [];
    withStderrCapture((captured) => {
      // 不抛错，也不产生任何「引用丢失」告警 —— 没有引用可丢。
      symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
      warnings.push(...captured);
    });

    assert.deepEqual(warnings, []);
    assert.equal(existsSync(join(evalRoot, "notes.md")), false);
    // 配置文档本身仍被镜像（镜像在前、解析在后）。
    assert.ok(existsSync(join(evalRoot, "opencode.jsonc")));
  });
});

test("JSONC 配置被截断时沿用 jsonc-parser 的尽力恢复结果", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeFileSync(join(projectRoot, "notes.md"), "NOTES_BODY\n");
    // 缺右括号：jsonc-parser 返回已解析出的部分对象，因此引用照常镜像。这条锁住的是
    // 上游「尽力恢复」的语义，不要改成「解析失败一律当无引用」。
    writeFileSync(join(projectRoot, "opencode.jsonc"), '{ "instructions": ["./notes.md"\n');

    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");

    assert.equal(readFileSync(join(evalRoot, "notes.md"), "utf-8"), "NOTES_BODY\n");
  });
});

// ---------------------------------------------------------------------------
// 配置引用展开：不支持的 glob 语法一律报出，且一条都不镜像
// ---------------------------------------------------------------------------

test("父目录 glob 被报告，且绝不把项目外材料拷进来", () => {
  // 引用的材料在项目之外：`../<outside>/*.md`。
  const outside = mkdtempSync(join(tmpdir(), "skill-eval-outside-"));
  try {
    const outsideName = basename(outside);
    writeFileSync(join(outside, "a.md"), "OUTSIDE_RULES\n");

    withProjectAndEvalRoots((projectRoot, evalRoot) => {
      writeFileSync(
        join(projectRoot, "opencode.json"),
        JSON.stringify({ instructions: [`../${outsideName}/*.md`] }),
      );

      const warnings = [];
      withStderrCapture((captured) => {
        symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
        warnings.push(...captured);
      });

      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(`../${outsideName}/*.md`));
      assert.match(warnings[0], /parent directory/);
      // 只有配置文档进评测根；项目外的材料既没被拷贝，也没被改动。
      assert.deepEqual(readdirSync(evalRoot), ["opencode.json"]);
      assert.equal(readFileSync(join(outside, "a.md"), "utf-8"), "OUTSIDE_RULES\n");
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("brace 交替被报告为不支持，且一条引用都不镜像", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    mkdirSync(join(projectRoot, "rules"), { recursive: true });
    writeFileSync(join(projectRoot, "rules", "a.md"), "A_RULES\n");
    writeFileSync(join(projectRoot, "rules", "b.md"), "B_RULES\n");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ instructions: ["rules/{a,b}.md"] }),
    );

    const warnings = [];
    withStderrCapture((captured) => {
      symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
      warnings.push(...captured);
    });

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("rules/{a,b}.md"));
    assert.match(warnings[0], /brace alternation/);
    assert.deepEqual(readdirSync(evalRoot), ["opencode.json"]);
  });
});

test("畸形字符类被报告而不是抛出", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    writeFileSync(join(projectRoot, "za.md"), "Z_RULES\n");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ instructions: ["[z-a].md"] }),
    );

    const warnings = [];
    withStderrCapture((captured) => {
      symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
      warnings.push(...captured);
    });

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("[z-a]"));
    assert.match(warnings[0], /malformed glob segment/);
    assert.deepEqual(readdirSync(evalRoot), ["opencode.json"]);
  });
});

test("** 递归仍被报告为不支持的边界", () => {
  withProjectAndEvalRoots((projectRoot, evalRoot) => {
    mkdirSync(join(projectRoot, "a", "b"), { recursive: true });
    writeFileSync(join(projectRoot, "a", "b", "deep.md"), "DEEP_RULES\n");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ instructions: ["a/**/*.md"] }),
    );

    const warnings = [];
    withStderrCapture((captured) => {
      symlinkProjectOpenCodeConfig(projectRoot, evalRoot, "tested-skill");
      warnings.push(...captured);
    });

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("a/**/*.md"));
    assert.match(warnings[0], /"\*\*" recursion/);
    assert.deepEqual(readdirSync(evalRoot), ["opencode.json"]);
  });
});

// ---------------------------------------------------------------------------
// 冲突守卫：枚举结果 -> 中止 / 放行
// ---------------------------------------------------------------------------

test("parseCliSkillList 从 JSON 数组里取出同名条目位置", () => {
  const stdout = JSON.stringify([
    { name: "demo-skill", location: "/skills/demo" },
    { name: "other-skill", location: "/skills/other" },
  ]);

  assert.deepEqual(findSkillConflicts(stdout, "demo-skill"), ["/skills/demo"]);
  assert.deepEqual(findSkillConflicts(stdout, "missing-skill"), []);
});

test("parseCliSkillList 对非 JSON / 非数组输出返回空冲突列表", () => {
  for (const stdout of ["not json", "{}", '"text"', "null", "42"]) {
    assert.deepEqual(findSkillConflicts(stdout, "demo-skill"), []);
  }
});

test("parseCliSkillList 丢弃无 name 的条目，缺位置记为 unknown location", () => {
  const stdout = JSON.stringify([{ location: "/no-name" }, null, "text", { name: "demo-skill" }]);

  assert.deepEqual(findSkillConflicts(stdout, "demo-skill"), ["unknown location"]);
});

test("findSkillConflictsInList 逐条列出命中位置", () => {
  assert.deepEqual(
    findSkillConflictsInList(
      [
        { name: "target", location: "/a" },
        { name: "target" },
        { name: "other", location: "/b" },
      ],
      "target",
    ),
    ["/a", "unknown location"],
  );
  assert.deepEqual(findSkillConflictsInList([{ name: "target", location: "   " }], "target"), [
    "unknown location",
  ]);
  assert.deepEqual(findSkillConflictsInList([], "target"), []);
});

test("createV2SkillEnumerator 把项目根作为枚举作用域并映射结果", async () => {
  const calls = [];
  const enumerate = createV2SkillEnumerator({
    skill: {
      list: async (input) => {
        calls.push(input);
        return {
          data: [{ name: "alpha", path: "/skills/alpha" }, { name: "beta" }, {}],
        };
      },
    },
  });

  assert.deepEqual(await enumerate("/project/location"), [
    { name: "alpha", location: "/skills/alpha" },
    { name: "beta", location: undefined },
  ]);
  // 作用域参数必须原样传下去，否则读到的是宿主进程的项目而不是被测项目。
  assert.deepEqual(calls, [{ location: { directory: "/project/location" } }]);
});

test("createV2SkillEnumerator 在 skill API 抛错时返回 null", async () => {
  const enumerate = createV2SkillEnumerator({
    skill: {
      list: async () => {
        throw new Error("server unavailable");
      },
    },
  });

  assert.equal(await enumerate("/project"), null);
});

test("createV2SkillEnumerator 在返回形状异常时返回 null", async () => {
  const enumerate = createV2SkillEnumerator({
    skill: { list: async () => ({ data: "not-an-array" }) },
  });
  const missingData = createV2SkillEnumerator({ skill: { list: async () => null } });

  assert.equal(await enumerate("/project"), null);
  assert.equal(await missingData("/project"), null);
});
