/**
 * `skill_zh install` 的白名单安装、幂等、元数据外置与用户改动保护（docs/SPEC.md R6.1-I1/I2/I5）。
 *
 * 全部用例：`os.tmpdir()` + `mkdtempSync`，并把 `HOME` / `USERPROFILE` 指向临时目录、
 * 用 `--dir` 指定安装根，**绝不写真实 `~/.config/opencode/skills`**；`SKILL_ZH_SKILL_SOURCE`
 * 只在本文件内指向临时技能目录，结束即还原。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";

import { runCommand } from "../dist/cli/dispatch.js";
import { parseArgs } from "../dist/cli/parse-args.js";
import { SKILL_NAME, STATE_DIR_NAME, STATE_FILE_NAME } from "../dist/lib/skill-install.js";

/** 统一成 `/` 分隔。 */
const toDisplay = (path) => path.replaceAll("\\", "/");

/**
 * 在临时根里执行用例：设置临时 HOME / USERPROFILE，结束后还原并递归删除。
 *
 * @param {(root: string) => unknown} fn 用例体
 * @returns 用例体返回值
 */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "skill-creator-install-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");

  const cleanup = () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  };

  try {
    const result = fn(root);
    return result instanceof Promise ? result.finally(cleanup) : (cleanup(), result);
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * 分发上下文：项目目录即临时根。
 *
 * @param root 临时根
 * @returns 上下文对象
 */
const ctxOf = (root) => ({ directory: root, worktree: root });

/**
 * 写文件（自动建父目录）。
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
 * 造一个带白名单外条目的随包技能目录。
 *
 * @param root 临时根
 * @returns 技能目录绝对路径
 */
function writeSource(root) {
  const sourceDir = join(root, "bundle", "skill");
  writeFile(
    root,
    "bundle/skill/SKILL.md",
    ["---", `name: ${SKILL_NAME}`, "description: 安装测试技能", "---", "", "BUNDLED V1", ""].join("\n"),
  );
  writeFile(root, "bundle/skill/agents/analyzer.md", "agent\n");
  writeFile(root, "bundle/skill/references/schemas.md", "schemas\n");
  writeFile(root, "bundle/skill/templates/eval-review.html", "<html></html>\n");
  writeFile(root, "bundle/skill/dist/index.js", "build\n");
  writeFile(root, "bundle/skill/test/x.test.js", "test\n");
  return sourceDir;
}

/**
 * 在 `SKILL_ZH_SKILL_SOURCE` 指向临时技能目录的前提下执行用例。
 *
 * @param {string} sourceDir 随包技能目录
 * @param {() => unknown} fn 用例体
 * @returns 用例体返回值
 */
function withSource(sourceDir, fn) {
  const previous = process.env.SKILL_ZH_SKILL_SOURCE;
  process.env.SKILL_ZH_SKILL_SOURCE = sourceDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.SKILL_ZH_SKILL_SOURCE;
    else process.env.SKILL_ZH_SKILL_SOURCE = previous;
  }
}

/**
 * 递归列出普通文件（相对 POSIX 路径）。
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
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 运行 install 命令。
 *
 * @param root 项目根
 * @param skillsRoot 安装根
 * @param extra 额外参数
 * @returns 分发结果
 */
function runInstall(root, skillsRoot, extra = "") {
  return runCommand(
    parseArgs(`install --dir "${toDisplay(skillsRoot)}"${extra === "" ? "" : ` ${extra}`}`),
    ctxOf(root),
  );
}

test("首次安装：只写白名单、状态文件外置，输出目标与清单", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");

    withSource(sourceDir, () => {
      const result = runInstall(root, skillsRoot);
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes("安装：已安装"));

      const target = join(skillsRoot, SKILL_NAME);
      assert.deepEqual(listFiles(target), [
        "SKILL.md",
        "agents/analyzer.md",
        "references/schemas.md",
        "templates/eval-review.html",
      ]);
      assert.ok(!existsSync(join(target, "dist")));
      assert.ok(!existsSync(join(target, "test")));
      assert.ok(result.output.includes("跳过（白名单外）：dist/  test/"));

      for (const entry of readdirSync(target)) {
        assert.ok(!entry.startsWith("."), `技能目录出现点开头条目：${entry}`);
        assert.ok(!entry.endsWith(".user-backup"), `技能目录出现备份：${entry}`);
      }

      const stateFile = join(skillsRoot, STATE_DIR_NAME, STATE_FILE_NAME);
      assert.ok(existsSync(stateFile));
      assert.ok(result.output.includes(toDisplay(stateFile)));
    });
  });
});

test("幂等：重复安装报「已是最新」，状态与文件不变", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");

    withSource(sourceDir, () => {
      assert.equal(runInstall(root, skillsRoot).ok, true);
      const stateFile = join(skillsRoot, STATE_DIR_NAME, STATE_FILE_NAME);
      const before = readFileSync(stateFile, "utf-8");
      const filesBefore = listFiles(join(skillsRoot, SKILL_NAME));

      const second = runInstall(root, skillsRoot);
      assert.equal(second.ok, true, second.output);
      assert.ok(second.output.includes("已是最新"), second.output);
      assert.equal(readFileSync(stateFile, "utf-8"), before);
      assert.deepEqual(listFiles(join(skillsRoot, SKILL_NAME)), filesBefore);
    });
  });
});

test("I5：本地改过 SKILL.md 时默认不覆盖，并提示 --force", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");
    const targetSkill = join(skillsRoot, SKILL_NAME, "SKILL.md");

    withSource(sourceDir, () => {
      runInstall(root, skillsRoot);
      writeFileSync(targetSkill, "USER LOCAL EDIT\n");

      const result = runInstall(root, skillsRoot);
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes("保留本地 SKILL.md"));
      assert.ok(result.output.includes("skill_zh install --force"));
      assert.ok(result.output.includes("本地改动："));
      assert.equal(readFileSync(targetSkill, "utf-8"), "USER LOCAL EDIT\n");

      const stateFile = join(skillsRoot, STATE_DIR_NAME, STATE_FILE_NAME);
      const state = JSON.parse(readFileSync(stateFile, "utf-8"));
      assert.equal(state.lastBackup, null);
    });
  });
});

test("I5：--force 覆盖并备份到状态目录，技能目录内不留备份", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");
    const targetSkill = join(skillsRoot, SKILL_NAME, "SKILL.md");

    withSource(sourceDir, () => {
      runInstall(root, skillsRoot);
      writeFileSync(targetSkill, "USER LOCAL EDIT\n");

      const result = runInstall(root, skillsRoot, "--force");
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes("备份："));
      assert.equal(readFileSync(targetSkill, "utf-8"), readFileSync(join(sourceDir, "SKILL.md"), "utf-8"));

      const stateDir = join(skillsRoot, STATE_DIR_NAME);
      const state = JSON.parse(readFileSync(join(stateDir, STATE_FILE_NAME), "utf-8"));
      assert.match(state.lastBackup, /^SKILL\.md\.bak-/);
      assert.equal(readFileSync(join(stateDir, state.lastBackup), "utf-8"), "USER LOCAL EDIT\n");
      assert.ok(!readdirSync(join(skillsRoot, SKILL_NAME)).some((name) => name.includes(".bak")));
    });
  });
});

test("--dry-run 只报告，不写盘", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");

    withSource(sourceDir, () => {
      const result = runInstall(root, skillsRoot, "--dry-run");
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes("预览（未写盘）"));
      assert.ok(result.output.includes("将写入"));
      assert.ok(!existsSync(skillsRoot), "dry-run 不应创建安装根");
    });
  });
});

test("--dir 空值拒绝，~ 会展开到 home", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);

    withSource(sourceDir, () => {
      for (const args of ['install --dir ""', "install --dir="]) {
        const result = runCommand(parseArgs(args), ctxOf(root));
        assert.equal(result.ok, false, result.output);
        assert.equal(result.output.split("\n")[0], "错误：参数 --dir 不能为空");
      }

      const result = runCommand(parseArgs('install --dir "~/skills"'), ctxOf(root));
      assert.equal(result.ok, true, result.output);
      assert.ok(existsSync(join(root, "home", "skills", SKILL_NAME, "SKILL.md")), result.output);
    });
  });
});

test("旧版元数据：版本/清单清理，用户备份迁移到状态目录", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");
    const target = join(skillsRoot, SKILL_NAME);
    const stateDir = join(skillsRoot, STATE_DIR_NAME);

    withSource(sourceDir, () => {
      runInstall(root, skillsRoot);
      writeFile(target, ".opencode-skill-creator-version", "0.0.1\n");
      writeFile(target, ".opencode-skill-creator-manifest.json", "{}\n");
      writeFile(target, "SKILL.md.user-backup", "LEGACY HISTORY\n");

      const result = runInstall(root, skillsRoot);
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes("清理旧版元数据"));
      assert.ok(result.output.includes("迁移旧版备份"));
      assert.ok(!existsSync(join(target, ".opencode-skill-creator-version")));
      assert.ok(!existsSync(join(target, ".opencode-skill-creator-manifest.json")));
      assert.ok(!existsSync(join(target, "SKILL.md.user-backup")));

      const migrated = readdirSync(stateDir).filter((name) => name.startsWith("SKILL.md.user-backup.bak-"));
      assert.equal(migrated.length, 1);
      assert.equal(readFileSync(join(stateDir, migrated[0]), "utf-8"), "LEGACY HISTORY\n");
    });
  });
});

test("旧版用户备份与包内 SKILL.md 一致时直接清理，不迁移", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");
    const target = join(skillsRoot, SKILL_NAME);

    withSource(sourceDir, () => {
      runInstall(root, skillsRoot);
      writeFile(target, "SKILL.md.user-backup", readFileSync(join(sourceDir, "SKILL.md"), "utf-8"));

      const result = runInstall(root, skillsRoot);
      assert.equal(result.ok, true, result.output);
      assert.ok(!existsSync(join(target, "SKILL.md.user-backup")));
      assert.ok(!result.output.includes("迁移旧版备份"));
    });
  });
});

test("--dry-run 对旧版元数据只报「将清理 / 将迁移」，不改盘", () => {
  withTempRoot((root) => {
    const sourceDir = writeSource(root);
    const skillsRoot = join(root, "skills");
    const target = join(skillsRoot, SKILL_NAME);

    withSource(sourceDir, () => {
      runInstall(root, skillsRoot);
      writeFile(target, ".opencode-skill-creator-version", "0.0.1\n");
      writeFile(target, "SKILL.md.user-backup", "LEGACY HISTORY\n");

      const result = runInstall(root, skillsRoot, "--dry-run");
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes("将清理旧版元数据"));
      assert.ok(result.output.includes("将迁移旧版备份"));
      assert.ok(!result.output.includes("已清理"));
      assert.ok(!result.output.includes("已保存"));
      assert.ok(existsSync(join(target, ".opencode-skill-creator-version")));
      assert.ok(existsSync(join(target, "SKILL.md.user-backup")));
    });
  });
});
