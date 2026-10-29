/**
 * `lib/skill-install` 的安装语义（docs/SPEC.md R6.1 的 I1 / I2 / I5）。
 *
 * 全部用例在 `os.tmpdir()` 的私有目录里跑，`skillsRoot` 也指向临时目录，**不会**触碰真实的
 * `~/.config/opencode/skills`；每个用例在 `finally` 里递归清理。
 *
 * 这里测的是安装器本体（白名单、状态外置、幂等、清理、用户改动保护）；
 * 命令行输出与冲突探测分别由 `cli-install` / `lib-install-conflict` 覆盖。
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";

import {
  installBundledSkill,
  listSkillBundle,
  readInstallState,
  resetStartupInstallForTests,
  scheduleStartupSkillInstall,
  SKILL_NAME,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
} from "../dist/lib/skill-install.js";

/**
 * 在临时根里执行回调，结束后递归删除。
 *
 * @param {(root: string) => unknown} callback 用例体
 * @returns 用例体返回值
 */
function withTempRoot(callback) {
  const root = mkdtempSync(join(tmpdir(), "osc-skill-install-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  try {
    return callback(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 按相对路径写一个技能目录。
 *
 * @param root 容器目录
 * @param name 目录名
 * @param files 相对路径 → 内容
 * @returns 技能目录绝对路径
 */
function writeBundle(root, name, files) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * 生成一份最小 SKILL.md。
 *
 * @param body 正文
 * @returns 文件内容
 */
function skillMd(body = "v1") {
  return ["---", `name: ${SKILL_NAME}`, "description: Test bundle.", "---", "", body, ""].join("\n");
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
      else if (entry.isFile()) out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** 临时技能根（`skills/`）。 */
const skillsRootOf = (root) => join(root, "opencode", "skills");

test("I1/I2：只拷白名单条目，元数据写在技能目录外", () => {
  withTempRoot((root) => {
    const sourceDir = writeBundle(root, "bundle", {
      "SKILL.md": skillMd(),
      "agents/analyzer.md": "agent\n",
      "references/ref.md": "ref\n",
      "templates/page.html": "<html></html>\n",
      "dist/index.js": "build\n",
      "bin/run.js": "bin\n",
      "test/x.test.js": "test\n",
      "node_modules/pkg/index.js": "dep\n",
      ".git/config": "[core]\n",
      "notes.md": "not whitelisted\n",
    });
    const skillsRoot = skillsRootOf(root);
    const result = installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" });

    const target = join(skillsRoot, SKILL_NAME);
    const expected = listSkillBundle(sourceDir).files.map((file) => file.relativePath).sort();
    assert.deepEqual(listFiles(target), expected);
    assert.ok(!existsSync(join(target, "dist")));
    assert.ok(!existsSync(join(target, "bin")));
    assert.ok(!existsSync(join(target, "test")));
    assert.ok(!existsSync(join(target, "node_modules")));
    assert.ok(!existsSync(join(target, "notes.md")));

    // 技能目录内没有点开头条目、没有安装器元数据。
    for (const entry of readdirSync(target)) {
      assert.ok(!entry.startsWith("."), `技能目录出现点开头条目：${entry}`);
      assert.ok(!entry.endsWith(".user-backup"), `技能目录出现备份：${entry}`);
    }

    const stateFile = join(skillsRoot, STATE_DIR_NAME, STATE_FILE_NAME);
    assert.ok(existsSync(stateFile), "状态文件未写到技能目录外");
    const state = readInstallState(stateFile);
    assert.equal(state.packageVersion, "1.0.0");
    assert.equal(typeof state.files["agents/analyzer.md"], "string");
    assert.equal(result.status, "installed");
  });
});

test("I1：源目录只有 skill.md（小写）时也落成 SKILL.md，agents 目录大小写同样归一", () => {
  withTempRoot((root) => {
    const sourceDir = writeBundle(root, "bundle", {
      "skill.md": skillMd(),
      "AGENTS/helper.md": "helper\n",
    });
    const target = join(skillsRootOf(root), SKILL_NAME);
    installBundledSkill({ sourceDir, skillsRoot: skillsRootOf(root), packageVersion: "1.0.0" });

    assert.ok(existsSync(join(target, "SKILL.md")));
    assert.ok(existsSync(join(target, "agents", "helper.md")));
    assert.deepEqual(listFiles(target), ["SKILL.md", "agents/helper.md"]);
  });
});

test("幂等：重复安装不重复写、不产生残留、状态文件不变", () => {
  withTempRoot((root) => {
    const sourceDir = writeBundle(root, "bundle", {
      "SKILL.md": skillMd(),
      "references/ref.md": "ref\n",
    });
    const skillsRoot = skillsRootOf(root);
    installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" });

    const stateFile = join(skillsRoot, STATE_DIR_NAME, STATE_FILE_NAME);
    const before = readFileSync(stateFile, "utf-8");
    const mtimeBefore = statSync(join(skillsRoot, SKILL_NAME, "SKILL.md")).mtimeMs;

    const second = installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" });

    assert.equal(second.status, "up-to-date");
    assert.equal(second.changed, false);
    assert.ok(second.files.every((file) => file.action === "same"));
    assert.equal(readFileSync(stateFile, "utf-8"), before);
    assert.equal(statSync(join(skillsRoot, SKILL_NAME, "SKILL.md")).mtimeMs, mtimeBefore);
  });
});

test("I5：本地改过 SKILL.md 默认不覆盖；--force 才覆盖并备份到状态目录", () => {
  withTempRoot((root) => {
    const sourceDir = writeBundle(root, "bundle", {
      "SKILL.md": skillMd("bundled"),
      "agents/helper.md": "helper\n",
    });
    const skillsRoot = skillsRootOf(root);
    installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" });

    const targetSkill = join(skillsRoot, SKILL_NAME, "SKILL.md");
    writeFileSync(targetSkill, "USER CUSTOM\n");

    const skipped = installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" });
    assert.equal(skipped.userModified, true);
    assert.equal(skipped.status, "kept-user");
    assert.equal(readFileSync(targetSkill, "utf-8"), "USER CUSTOM\n");
    assert.ok(skipped.files.find((file) => file.relativePath === "SKILL.md").action === "keep-user");

    const forced = installBundledSkill({
      sourceDir,
      skillsRoot,
      packageVersion: "1.0.0",
      force: true,
    });
    assert.equal(readFileSync(targetSkill, "utf-8"), skillMd("bundled"));
    assert.ok(forced.backupPath !== null);
    assert.equal(readFileSync(forced.backupPath, "utf-8"), "USER CUSTOM\n");
    // 备份在状态目录内，技能目录里没有 .bak / .user-backup。
    assert.ok(forced.backupPath.startsWith(join(skillsRoot, STATE_DIR_NAME)));
    assert.ok(!listFiles(join(skillsRoot, SKILL_NAME)).some((file) => file.includes(".bak")));

    const state = readInstallState(join(skillsRoot, STATE_DIR_NAME, STATE_FILE_NAME));
    assert.match(state.lastBackup, /^SKILL\.md\.bak-/);
  });
});

test("升级只删「旧状态记录 + 未改动 + 新包不再提供」的文件，用户文件保留", () => {
  withTempRoot((root) => {
    const skillsRoot = skillsRootOf(root);
    const v1 = writeBundle(root, "v1", {
      "SKILL.md": skillMd("v1"),
      "references/old.md": "old\n",
      "references/keep.md": "keep\n",
    });
    installBundledSkill({ sourceDir: v1, skillsRoot, packageVersion: "1.0.0" });

    const target = join(skillsRoot, SKILL_NAME);
    writeFileSync(join(target, "references", "user.md"), "user\n");

    const v2 = writeBundle(root, "v2", {
      "SKILL.md": skillMd("v2"),
      "references/keep.md": "keep\n",
    });
    const result = installBundledSkill({ sourceDir: v2, skillsRoot, packageVersion: "2.0.0" });

    assert.deepEqual(result.removed, ["references/old.md"]);
    assert.ok(!existsSync(join(target, "references", "old.md")));
    assert.equal(readFileSync(join(target, "references", "user.md"), "utf-8"), "user\n");
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf-8"), skillMd("v2"));
    assert.equal(result.status, "upgraded");
  });
});

test("源目录缺 SKILL.md 时拒绝安装，且不创建目标目录", () => {
  withTempRoot((root) => {
    const sourceDir = writeBundle(root, "bundle", { "references/ref.md": "ref\n" });
    const skillsRoot = skillsRootOf(root);

    assert.throws(
      () => installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" }),
      /缺少 SKILL\.md/,
    );
    assert.ok(!existsSync(join(skillsRoot, SKILL_NAME)));
  });
});

test("C12：只写自己的技能目录与状态目录，不碰同级技能", () => {
  withTempRoot((root) => {
    const skillsRoot = skillsRootOf(root);
    const sibling = join(skillsRoot, "opencode-skill-creator");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "SKILL.md"), "upstream english\n");

    const sourceDir = writeBundle(root, "bundle", { "SKILL.md": skillMd() });
    installBundledSkill({ sourceDir, skillsRoot, packageVersion: "1.0.0" });

    assert.equal(readFileSync(join(sibling, "SKILL.md"), "utf-8"), "upstream english\n");
    assert.ok(existsSync(join(skillsRoot, SKILL_NAME, "SKILL.md")));
  });
});

test("启动钩子：测试环境默认跳过；取消测试标记后无冲突时静默安装一次", async () => {
  const root = mkdtempSync(join(tmpdir(), "osc-skill-startup-"));
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SOURCE: process.env.SKILL_ZH_SKILL_SOURCE,
    TEST: process.env.NODE_TEST_CONTEXT,
  };
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  const wait = () => new Promise((resolveTick) => setTimeout(resolveTick, 50));

  try {
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = join(root, "home");
    process.env.SKILL_ZH_SKILL_SOURCE = writeBundle(root, "bundle", { "SKILL.md": skillMd() });
    const target = join(root, "home", ".config", "opencode", "skills", SKILL_NAME, "SKILL.md");

    // 测试环境（NODE_TEST_CONTEXT 存在）一律不调度，避免写真实 HOME。
    resetStartupInstallForTests();
    scheduleStartupSkillInstall({ logInfo: () => {}, logError: () => {} });
    await wait();
    assert.equal(existsSync(target), false);

    // 模拟真实启动：无冲突、目标不存在 → 后台完成一次安装。
    delete process.env.NODE_TEST_CONTEXT;
    resetStartupInstallForTests();
    const logs = [];
    scheduleStartupSkillInstall({ logInfo: (message) => logs.push(message), logError: () => {} });
    await wait();
    assert.equal(existsSync(target), true);
    assert.ok(logs.some((line) => line.includes("启动静默安装完成")));
  } finally {
    restore("HOME", previous.HOME);
    restore("USERPROFILE", previous.USERPROFILE);
    restore("SKILL_ZH_SKILL_SOURCE", previous.SOURCE);
    restore("NODE_TEST_CONTEXT", previous.TEST);
    resetStartupInstallForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
