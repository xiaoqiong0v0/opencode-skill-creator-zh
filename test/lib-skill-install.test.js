/**
 * `lib/skill-install` 的安装/升级语义（迁自上游 `test/skill-install.test.ts`，基线
 * `d4383924`）。
 *
 * 全部用例都在 `os.tmpdir()` + `mkdtempSync` 建的私有目录里跑，`configDir` 也指向该临时
 * 目录，因此**不会**触碰真实的 `~/.config/opencode/skills`；每个用例在 `finally` 里递归
 * 清理。依赖符号链接的用例在平台建不出链接时显式 skip（Windows 需管理员或开发者模式）。
 *
 * 上游事实（保留以解释断言口径）：属主清单（P42-04 系列）只记录「本安装器拷过的文件 +
 * 内容哈希」，升级只删「已记录、未改动、新包不再提供」的文件；保留根路径按任意 ASCII
 * 大小写变体保护；prune 全程 lstat、不跟随符号链接。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

import {
  ensureBundledSkillInstalled,
  INSTALL_MANIFEST_FILE,
  INSTALL_VERSION_FILE,
  LEGACY_SKILL_NAME,
  SKILL_NAME,
} from "../dist/lib/skill-install.js";

/**
 * 在临时目录里执行回调，结束后递归删除。
 *
 * @param {function(string): void} callback 接收临时目录路径的回调
 * @returns {void}
 */
function withTempDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), "osc-skill-install-"));
  try {
    callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 造一个最小随包技能目录（`SKILL.md` + `agents/helper.md`）。
 *
 * @param {string} root 容器目录
 * @returns {string} 随包技能目录路径
 */
function createBundledSkill(root) {
  const bundledSkillDir = join(root, "bundled-skill");
  mkdirSync(join(bundledSkillDir, "agents"), { recursive: true });
  writeFileSync(
    join(bundledSkillDir, "SKILL.md"),
    [
      "---",
      `name: ${SKILL_NAME}`,
      "description: Test bundled OpenCode skill creator.",
      "---",
      "",
      "# OpenCode Skill Creator",
      "",
    ].join("\n"),
  );
  writeFileSync(join(bundledSkillDir, "agents", "helper.md"), "helper\n");
  return bundledSkillDir;
}

/**
 * 在临时根下按「相对路径 → 内容」写一个随包目录。
 *
 * @param {string} root 容器目录
 * @param {string} name 随包目录名
 * @param {Record<string, string>} files 相对路径到内容的映射
 * @returns {string} 随包目录路径
 */
function writeBundle(root, name, files) {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * 生成一份最小 `SKILL.md` 内容。
 *
 * @param {string} name frontmatter 里的技能名
 * @returns {string} 文件内容
 */
function skillMd(name) {
  return ["---", `name: ${name}`, "description: Test bundle.", "---", "", "# T", ""].join(
    "\n",
  );
}

/**
 * 计算字符串的 sha256 十六进制摘要。
 *
 * @param {string} text 原文
 * @returns {string} 摘要
 */
function hashText(text) {
  return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

/**
 * 探测当前平台能否创建符号链接。
 *
 * @returns {boolean} 能创建时返回 `true`
 */
function detectSymlinkSupport() {
  const root = mkdtempSync(join(tmpdir(), "osc-symlink-probe-"));
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

test("ensureBundledSkillInstalled 按 opencode 专用名安装随包技能", () => {
  withTempDir((root) => {
    const bundledSkillDir = createBundledSkill(root);
    const configDir = join(root, "config");

    ensureBundledSkillInstalled({ bundledSkillDir, configDir, packageVersion: "1.2.3" });

    const installedSkillDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const legacySkillDir = join(configDir, "opencode", "skills", LEGACY_SKILL_NAME);

    assert.equal(existsSync(join(installedSkillDir, "SKILL.md")), true);
    assert.match(
      readFileSync(join(installedSkillDir, "SKILL.md"), "utf-8"),
      new RegExp(`name: ${SKILL_NAME}`),
    );
    assert.equal(
      readFileSync(join(installedSkillDir, INSTALL_VERSION_FILE), "utf-8"),
      "1.2.3\n",
    );
    assert.equal(existsSync(legacySkillDir), false);
  });
});

test("ensureBundledSkillInstalled 归档带版本标记的旧版目录，让通用技能名不再被加载", () => {
  withTempDir((root) => {
    const bundledSkillDir = createBundledSkill(root);
    const configDir = join(root, "config");
    const skillsRoot = join(configDir, "opencode", "skills");
    const legacySkillDir = join(skillsRoot, LEGACY_SKILL_NAME);
    mkdirSync(legacySkillDir, { recursive: true });
    writeFileSync(join(legacySkillDir, INSTALL_VERSION_FILE), "0.1.0\n");
    writeFileSync(join(legacySkillDir, "SKILL.md"), "legacy custom skill\n");

    ensureBundledSkillInstalled({
      bundledSkillDir,
      configDir,
      packageVersion: "1.2.3",
      backupTimestamp: () => "20260516-153045",
    });

    const installedSkillDir = join(skillsRoot, SKILL_NAME);
    const backupDir = join(
      skillsRoot,
      `${LEGACY_SKILL_NAME}.opencode-skill-creator-backup-20260516-153045`,
    );

    assert.equal(existsSync(join(installedSkillDir, "SKILL.md")), true);
    assert.equal(existsSync(legacySkillDir), false);
    assert.equal(existsSync(join(backupDir, "SKILL.md")), false);
    assert.equal(
      readFileSync(join(backupDir, "SKILL.md.backup"), "utf-8"),
      "legacy custom skill\n",
    );
  });
});

test("ensureBundledSkillInstalled 不碰没有版本标记的旧版目录（第三方技能）", () => {
  withTempDir((root) => {
    const bundledSkillDir = createBundledSkill(root);
    const configDir = join(root, "config");
    const skillsRoot = join(configDir, "opencode", "skills");
    const legacySkillDir = join(skillsRoot, LEGACY_SKILL_NAME);
    mkdirSync(legacySkillDir, { recursive: true });
    writeFileSync(join(legacySkillDir, "SKILL.md"), "third-party skill\n");

    ensureBundledSkillInstalled({ bundledSkillDir, configDir, packageVersion: "1.2.3" });

    assert.equal(readFileSync(join(legacySkillDir, "SKILL.md"), "utf-8"), "third-party skill\n");
    assert.equal(existsSync(join(skillsRoot, SKILL_NAME, "SKILL.md")), true);
  });
});

test("ensureBundledSkillInstalled 在同名时间戳备份已存在时仍会归档旧版目录", () => {
  withTempDir((root) => {
    const bundledSkillDir = createBundledSkill(root);
    const configDir = join(root, "config");
    const skillsRoot = join(configDir, "opencode", "skills");
    const legacySkillDir = join(skillsRoot, LEGACY_SKILL_NAME);
    const existingBackupDir = join(
      skillsRoot,
      `${LEGACY_SKILL_NAME}.opencode-skill-creator-backup-20260516-153045`,
    );
    mkdirSync(legacySkillDir, { recursive: true });
    mkdirSync(existingBackupDir, { recursive: true });
    writeFileSync(join(legacySkillDir, INSTALL_VERSION_FILE), "0.1.0\n");
    writeFileSync(join(legacySkillDir, "SKILL.md"), "legacy custom skill\n");
    writeFileSync(join(existingBackupDir, "SKILL.md.backup"), "older backup\n");

    ensureBundledSkillInstalled({
      bundledSkillDir,
      configDir,
      packageVersion: "1.2.3",
      backupTimestamp: () => "20260516-153045",
    });

    const collisionBackupDir = join(
      skillsRoot,
      `${LEGACY_SKILL_NAME}.opencode-skill-creator-backup-20260516-153045-1`,
    );

    assert.equal(existsSync(legacySkillDir), false);
    assert.equal(
      readFileSync(join(existingBackupDir, "SKILL.md.backup"), "utf-8"),
      "older backup\n",
    );
    assert.equal(
      readFileSync(join(collisionBackupDir, "SKILL.md.backup"), "utf-8"),
      "legacy custom skill\n",
    );
  });
});

test("ensureBundledSkillInstalled 安装失败只上报、不抛异常", () => {
  withTempDir((root) => {
    // 随包目录给成一个普通文件：`copyDirRecursive` 会抛错。
    const bundledSkillDir = join(root, "not-a-directory");
    const errors = [];
    writeFileSync(bundledSkillDir, "not a directory");

    assert.doesNotThrow(() => {
      ensureBundledSkillInstalled({
        bundledSkillDir,
        configDir: join(root, "config"),
        packageVersion: "1.2.3",
        onError: (message, error) => errors.push({ message, error }),
      });
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Failed to install opencode-skill-creator skill");
    assert.ok(errors[0].error instanceof Error);
  });
});

test("ensureBundledSkillInstalled 在继续安装前上报用户技能备份失败", () => {
  withTempDir((root) => {
    const bundledSkillDir = createBundledSkill(root);
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const userSkillFile = join(skillsDir, "SKILL.md");
    const userSkillBackup = join(skillsDir, "SKILL.md.user-backup");
    const errors = [];

    mkdirSync(dirname(userSkillFile), { recursive: true });
    writeFileSync(userSkillFile, "user-customized skill\n");
    // 备份目标位置先占成一个目录，让 `copyFileSync` 必然失败（EISDIR）。
    mkdirSync(userSkillBackup);

    ensureBundledSkillInstalled({
      bundledSkillDir,
      configDir,
      packageVersion: "1.2.3",
      onError: (message, error) => errors.push({ message, error }),
    });

    assert.equal(errors.length, 1);
    assert.equal(
      errors[0].message,
      `Failed to back up existing user skill file before updating ${SKILL_NAME}`,
    );
    assert.ok(errors[0].error instanceof Error);
    assert.equal(basename(userSkillBackup), "SKILL.md.user-backup");
    assert.equal(readFileSync(userSkillFile, "utf-8"), "user-customized skill\n");
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "1.2.3\n");
  });
});

// ---------------------------------------------------------------------------
// P42-04：安装器记录「从随包目录拷来的文件及其哈希」的内部属主清单，升级时只删除
// 「已记录、磁盘上未被改动、新包不再提供」的文件。用户自建、未跟踪、本地改过的文件
// 一律保留；没有清单的旧版安装什么都不删；格式非法/恶意的元数据既不能删到托管目录之外，
// 也不能顺着符号链接删。
//
// 全部夹具都用临时目录下的私有 `configDir`，从不使用真实的全局安装目录。
// ---------------------------------------------------------------------------

test("P42-04: 新包不再提供、且内容未改动的已记录文件在升级时被删除", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const siblingSkillDir = join(configDir, "opencode", "skills", "unrelated-skill");
    mkdirSync(siblingSkillDir, { recursive: true });
    writeFileSync(join(siblingSkillDir, "SKILL.md"), "third-party\n");

    const v1 = writeBundle(root, "bundle-v1", {
      "SKILL.md": skillMd(SKILL_NAME),
      "agents/helper.md": "helper\n",
      "removed-in-v2.md": "stale\n",
    });
    const v2 = writeBundle(root, "bundle-v2", {
      "SKILL.md": skillMd(SKILL_NAME),
      "agents/helper.md": "helper\n",
    });

    ensureBundledSkillInstalled({ bundledSkillDir: v1, configDir, packageVersion: "1.0.0" });
    assert.equal(existsSync(join(skillsDir, "removed-in-v2.md")), true);
    // 用户自己加的文件（从未被记录）必须在升级后存活。
    writeFileSync(join(skillsDir, "user-notes.md"), "keep me\n");

    ensureBundledSkillInstalled({ bundledSkillDir: v2, configDir, packageVersion: "2.0.0" });

    // 被记录、未改动、新包已丢弃的文件被删除……
    assert.equal(existsSync(join(skillsDir, "removed-in-v2.md")), false);
    // ……而当前包文件、用户自建文件、同级技能目录都还在。
    assert.equal(readFileSync(join(skillsDir, "agents", "helper.md"), "utf-8"), "helper\n");
    assert.equal(readFileSync(join(skillsDir, "user-notes.md"), "utf-8"), "keep me\n");
    assert.equal(readFileSync(join(siblingSkillDir, "SKILL.md"), "utf-8"), "third-party\n");
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "2.0.0\n");
    assert.equal(existsSync(join(skillsDir, INSTALL_MANIFEST_FILE)), true);
  });
});

test("P42-04: 在丢弃前被本地改动过的已记录文件保留", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const v1 = writeBundle(root, "bundle-v1", {
      "SKILL.md": skillMd(SKILL_NAME),
      "removed-in-v2.md": "stale\n",
    });
    const v2 = writeBundle(root, "bundle-v2", {
      "SKILL.md": skillMd(SKILL_NAME),
    });

    ensureBundledSkillInstalled({ bundledSkillDir: v1, configDir, packageVersion: "1.0.0" });
    // 用户改了插件自己的文件：内容已不是记录的字节。
    writeFileSync(join(skillsDir, "removed-in-v2.md"), "locally edited\n");

    ensureBundledSkillInstalled({ bundledSkillDir: v2, configDir, packageVersion: "2.0.0" });

    // 哈希不匹配 → 永不删除。
    assert.equal(
      readFileSync(join(skillsDir, "removed-in-v2.md"), "utf-8"),
      "locally edited\n",
    );
  });
});

test("P42-04: 没有清单的旧版安装什么都不删，并从此开始记录", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    // 模拟「清单机制之前」的安装：磁盘上有文件，没有清单。
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), skillMd(SKILL_NAME));
    writeFileSync(join(skillsDir, INSTALL_VERSION_FILE), "0.0.1\n");
    writeFileSync(join(skillsDir, "ancient-untracked.md"), "keep me\n");
    assert.equal(existsSync(join(skillsDir, INSTALL_MANIFEST_FILE)), false);

    const bundle = writeBundle(root, "bundle", {
      "SKILL.md": skillMd(SKILL_NAME),
      "agents/helper.md": "helper\n",
    });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "9.9.9" });

    // 没有清单 → 不会猜哪个文件过期 → 任意文件存活。
    assert.equal(readFileSync(join(skillsDir, "ancient-untracked.md"), "utf-8"), "keep me\n");
    // 之后开始记录，供下次升级使用。
    assert.equal(existsSync(join(skillsDir, INSTALL_MANIFEST_FILE)), true);
  });
});

test("P42-04: 不安全的或格式非法的清单元数据无法删到托管目录之外", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台无法创建符号链接（Windows 需管理员或开发者模式）");
    return;
  }
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const outsideTarget = join(root, "outside-target.txt");
    writeFileSync(outsideTarget, "OUTSIDE\n");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), skillMd(SKILL_NAME));
    writeFileSync(join(skillsDir, INSTALL_VERSION_FILE), "0.0.1\n");

    // 目录内一个指向目录外文件的符号链接，且记录的哈希与目标一致：此时只有「lstat +
    // 不跟随符号链接」这条规则能阻止它被删除（删掉就等于删了目录外的文件）。
    const outsideHash = hashText(readFileSync(outsideTarget, "utf-8"));
    symlinkSync(outsideTarget, join(skillsDir, "linked.md"), "file");

    writeFileSync(
      join(skillsDir, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        packageVersion: "0.0.1",
        files: {
          "../evil.txt": outsideHash,
          "/abs/evil.txt": outsideHash,
          "nested/../../evil2.txt": outsideHash,
          "linked.md": outsideHash,
          "missing.md": outsideHash,
        },
      }),
    );

    const bundle = writeBundle(root, "bundle", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "2.0.0" });

    // 目录外文件未被触碰，也没有出现逃逸路径。
    assert.equal(readFileSync(outsideTarget, "utf-8"), "OUTSIDE\n");
    assert.equal(existsSync(join(root, "evil.txt")), false);
    assert.equal(existsSync(join(root, "config", "opencode", "skills", "evil.txt")), false);
    // 符号链接未被跟随：目标与链接本身都还在。
    assert.equal(lstatSync(join(skillsDir, "linked.md")).isSymbolicLink(), true);
    assert.equal(existsSync(join(skillsDir, "missing.md")), false);
    // 干净升级之后，非法清单被替换成合法清单。
    const manifest = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.files["linked.md"], undefined);
  });
});

test("P42-04: 用户改过的 SKILL.md 与其备份在升级后保留，同时新包文件照常安装", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const v1 = writeBundle(root, "bundle-v1", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: v1, configDir, packageVersion: "1.0.0" });

    // 用户改了已安装的 SKILL.md。
    writeFileSync(join(skillsDir, "SKILL.md"), "USER CUSTOM\n");

    const v2 = writeBundle(root, "bundle-v2", {
      "SKILL.md": skillMd("bundle-name"),
      "new-in-v2.md": "new\n",
    });
    ensureBundledSkillInstalled({ bundledSkillDir: v2, configDir, packageVersion: "2.0.0" });

    // 用户的 SKILL.md 保留（不被随包副本覆盖），备份与它内容一致，新包文件照常落地。
    assert.equal(readFileSync(join(skillsDir, "SKILL.md"), "utf-8"), "USER CUSTOM\n");
    assert.equal(
      readFileSync(join(skillsDir, "SKILL.md.user-backup"), "utf-8"),
      "USER CUSTOM\n",
    );
    assert.equal(readFileSync(join(skillsDir, "new-in-v2.md"), "utf-8"), "new\n");
    // 被保留的用户文件不会被登记为插件属主。
    const manifest = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(manifest.files["SKILL.md"], undefined);
  });
});

test("archiveLegacySkill 先把旧版 SKILL.md 改名再移动旧版目录（失败时版本标记不前移）", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const v1 = writeBundle(root, "bundle-v1", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: v1, configDir, packageVersion: "1.0.0" });

    // 坏包（该是目录的位置放了个文件）让拷贝必然抛错。
    const brokenBundle = join(root, "broken-bundle");
    writeFileSync(brokenBundle, "not a directory");
    const errors = [];

    assert.doesNotThrow(() => {
      ensureBundledSkillInstalled({
        bundledSkillDir: brokenBundle,
        configDir,
        packageVersion: "2.0.0",
        onError: (message, error) => errors.push({ message, error }),
      });
    });

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Failed to install opencode-skill-creator skill");
    // 版本标记仍停在上一次成功的安装。
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "1.0.0\n");
  });
});

// ---------------------------------------------------------------------------
// P42-04 修正：属主元数据必须先于版本标记写入。元数据写失败时必须守住旧版本并上报；
// 移除这个「属主障碍」后重试，升级才能完成。
// ---------------------------------------------------------------------------

test("P42-04c1: 清单写入失败时守住旧版本并上报，障碍移除后重试才完成升级", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const bundle = writeBundle(root, "bundle", {
      "SKILL.md": skillMd(SKILL_NAME),
      "agents/helper.md": "helper\n",
    });

    // 首次安装正常提交版本与清单。
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "1.0.0" });
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "1.0.0\n");

    // 造一个人为的「属主障碍」：清单文件位置换成目录，写入必然失败（EISDIR）。
    rmSync(join(skillsDir, INSTALL_MANIFEST_FILE), { force: true });
    mkdirSync(join(skillsDir, INSTALL_MANIFEST_FILE));

    const errors = [];
    assert.doesNotThrow(() => {
      ensureBundledSkillInstalled({
        bundledSkillDir: bundle,
        configDir,
        packageVersion: "2.0.0",
        onError: (message, error) => errors.push({ message, error }),
      });
    });

    // 升级没有假装成新版本。
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "Failed to install opencode-skill-creator skill");
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "1.0.0\n");

    // 移除障碍后重试：升级干净提交。
    rmSync(join(skillsDir, INSTALL_MANIFEST_FILE), { recursive: true, force: true });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "2.0.0" });
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "2.0.0\n");
    const manifest = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(manifest.schema, 1);
    assert.equal(manifest.packageVersion, "2.0.0");
  });
});

test("P42-04c2: 与随包内容完全相同的用户 SKILL.md 仍不进属主清单", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const bundle = writeBundle(root, "bundle", {
      "SKILL.md": skillMd(SKILL_NAME),
      "agents/helper.md": "helper\n",
    });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "1.0.0" });

    // 安装后的 SKILL.md 与随包副本逐字节相同，但仍不得登记为插件属主。
    const manifest = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(manifest.files["SKILL.md"], undefined);
    assert.equal(manifest.files[INSTALL_VERSION_FILE], undefined);
    assert.equal(manifest.files[INSTALL_MANIFEST_FILE], undefined);
    assert.equal(typeof manifest.files["agents/helper.md"], "string");

    // 之后新包不再提供 SKILL.md，升级也不能删掉已安装的 SKILL.md（它从未被登记）。
    const v2 = writeBundle(root, "bundle2", { "agents/helper.md": "helper2\n" });
    ensureBundledSkillInstalled({ bundledSkillDir: v2, configDir, packageVersion: "2.0.0" });
    assert.equal(existsSync(join(skillsDir, "SKILL.md")), true);
  });
});

test("P42-04c3: 伪造清单把保留路径连同匹配哈希一起记录，也无法删除它们", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const bundle = writeBundle(root, "bundle", { "agents/helper.md": "helper\n" });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "1.0.0" });

    // 用哨兵内容替换已安装的 SKILL.md / 备份，并在**格式合法**的清单里记录全部保留路径
    // （哈希与实际内容匹配）。
    writeFileSync(join(skillsDir, "SKILL.md"), "USER SKILL SENTINEL\n");
    writeFileSync(join(skillsDir, "SKILL.md.user-backup"), "USER BACKUP SENTINEL\n");
    const versionContent = readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8");
    writeFileSync(
      join(skillsDir, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        packageVersion: "1.0.0",
        files: {
          "SKILL.md": hashText("USER SKILL SENTINEL\n"),
          "SKILL.md.user-backup": hashText("USER BACKUP SENTINEL\n"),
          [INSTALL_VERSION_FILE]: hashText(versionContent),
        },
      }),
    );

    // 用既不提供 SKILL.md 也不提供备份的新包升级。
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "2.0.0" });

    // 保留文件全部存活（SKILL.md 不被剪除；备份按既有契约从当前用户 SKILL.md 刷新，而不是
    // 被删除），伪造条目被忽略。
    assert.equal(readFileSync(join(skillsDir, "SKILL.md"), "utf-8"), "USER SKILL SENTINEL\n");
    assert.equal(
      readFileSync(join(skillsDir, "SKILL.md.user-backup"), "utf-8"),
      "USER SKILL SENTINEL\n",
    );
    assert.equal(existsSync(join(skillsDir, INSTALL_VERSION_FILE)), true);
    assert.equal(existsSync(join(skillsDir, INSTALL_MANIFEST_FILE)), true);
    // 重写后的清单是干净的（没有保留路径条目）。
    const rewritten = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(rewritten.files["SKILL.md"], undefined);
    assert.equal(rewritten.files["SKILL.md.user-backup"], undefined);
  });
});

// ---------------------------------------------------------------------------
// P42-04 修正：prune 不得跟随符号链接——托管目录根不行，任何中间目录也不行。全部用
// 真实文件系统，不做 mock。
// ---------------------------------------------------------------------------

test("P42-04c4: 目录内祖先符号链接别名不会被穿透删除", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台无法创建符号链接（Windows 需管理员或开发者模式）");
    return;
  }
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const bundleV1 = writeBundle(root, "v1", {
      "SKILL.md": skillMd(SKILL_NAME),
      "agents/helper.md": "helper\n",
    });
    ensureBundledSkillInstalled({ bundledSkillDir: bundleV1, configDir, packageVersion: "1.0.0" });

    // 真实子目录里放一个物理哨兵文件，再造祖先符号链接 `sub -> real`：若跟随，清单里记录
    // 的 `sub/sentinel.md` 会删到真实文件。
    mkdirSync(join(skillsDir, "real"), { recursive: true });
    const physical = join(skillsDir, "real", "sentinel.md");
    writeFileSync(physical, "PHYSICAL SENTINEL\n");
    symlinkSync(join(skillsDir, "real"), join(skillsDir, "sub"), "dir");
    writeFileSync(
      join(skillsDir, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        packageVersion: "1.0.0",
        files: { "sub/sentinel.md": hashText("PHYSICAL SENTINEL\n") },
      }),
    );

    const bundleV2 = writeBundle(root, "v2", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: bundleV2, configDir, packageVersion: "2.0.0" });

    // 祖先符号链接被识别；物理哨兵存活，别名本身也没被删除。
    assert.equal(readFileSync(physical, "utf-8"), "PHYSICAL SENTINEL\n");
    assert.equal(lstatSync(join(skillsDir, "sub")).isSymbolicLink(), true);
  });
});

test("P42-04c5: 指向根外部的符号链接别名目标永不被删除", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台无法创建符号链接（Windows 需管理员或开发者模式）");
    return;
  }
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const bundle = writeBundle(root, "bundle", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "1.0.0" });

    const outside = join(root, "outside.md");
    writeFileSync(outside, "OUTSIDE SENTINEL\n");
    symlinkSync(outside, join(skillsDir, "external.md"), "file");
    writeFileSync(
      join(skillsDir, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        packageVersion: "1.0.0",
        files: { "external.md": hashText("OUTSIDE SENTINEL\n") },
      }),
    );

    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "2.0.0" });

    assert.equal(readFileSync(outside, "utf-8"), "OUTSIDE SENTINEL\n");
    assert.equal(lstatSync(join(skillsDir, "external.md")).isSymbolicLink(), true);
  });
});

test("P42-04c6: 托管目录自身是符号链接时不做任何 prune（即使其真实根在外部）", (t) => {
  if (!SYMLINK_SUPPORTED) {
    t.skip("当前平台无法创建符号链接（Windows 需管理员或开发者模式）");
    return;
  }
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsRoot = join(configDir, "opencode", "skills");
    const skillsDir = join(skillsRoot, SKILL_NAME);
    mkdirSync(skillsRoot, { recursive: true });

    // 托管目录本身是指向外部真实目录的符号链接，外部目录里放着可被匹配清单命中的哨兵。
    const external = join(root, "external-real");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "sentinel.md"), "EXTERNAL ROOT SENTINEL\n");
    symlinkSync(external, skillsDir, "dir");

    // 像一份旧安装：目标目录里有版本标记与清单。
    writeFileSync(join(external, INSTALL_VERSION_FILE), "0.0.1\n");
    writeFileSync(
      join(external, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        packageVersion: "0.0.1",
        files: { "sentinel.md": hashText("EXTERNAL ROOT SENTINEL\n") },
      }),
    );

    const bundle = writeBundle(root, "bundle", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "2.0.0" });

    // 目录根是符号链接 ⇒ 每个路径都解析到别处 ⇒ 不做任何 prune。
    assert.equal(readFileSync(join(external, "sentinel.md"), "utf-8"), "EXTERNAL ROOT SENTINEL\n");
    assert.equal(lstatSync(skillsDir).isSymbolicLink(), true);
  });
});

// ---------------------------------------------------------------------------
// P42-04R3 修正：保留根路径要在**任意 ASCII 大小写变体**下受保护，而不只是清单里记录的
// 那种拼写。在不区分大小写的文件系统（macOS/Windows 默认）上，`skill.md` 与 `SKILL.md`
// 是同一个文件，只按精确匹配的守卫会被「清单里换大小写」绕过。
//
// 这条回归用例不依赖文件系统 mock：先写规范路径；若变体路径没解析到同一个文件（即宿主
// 区分大小写），就把变体也写成一个独立普通文件。两种情况下两个受保护路径都必须存活。
// ---------------------------------------------------------------------------

/**
 * 判断两个路径是否指向同一个磁盘文件（用于区分大小写的宿主上会返回 `false`）。
 *
 * @param {string} a 路径一
 * @param {string} b 路径二
 * @returns {boolean} 内容完全一致时返回 `true`
 */
function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

test("P42-04R3: 伪造清单无法用大小写变体剪除保留根路径", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    const bundle = writeBundle(root, "bundle", { "agents/helper.md": "helper\n" });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "1.0.0" });

    // 用户哨兵 SKILL.md；升级时备份会从它刷新，所以变体条目记录的哈希对应刷新后的内容。
    writeFileSync(join(skillsDir, "SKILL.md"), "USER CUSTOM SKILL\n");
    const canonicalBackup = join(skillsDir, "SKILL.md.user-backup");
    writeFileSync(canonicalBackup, "USER CUSTOM SKILL\n");

    const variantBackup = join(skillsDir, "SKILL.MD.USER-BACKUP");
    const variantIsDistinct = !sameFile(canonicalBackup, variantBackup);
    if (variantIsDistinct) {
      // 区分大小写的宿主：把变体也写成独立普通文件，让「修复前」的 prune 在这里同样会删它。
      writeFileSync(variantBackup, "USER CUSTOM SKILL\n");
    }

    writeFileSync(
      join(skillsDir, INSTALL_MANIFEST_FILE),
      JSON.stringify({
        schema: 1,
        packageVersion: "1.0.0",
        files: { "SKILL.MD.USER-BACKUP": hashText("USER CUSTOM SKILL\n") },
      }),
    );

    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "2.0.0" });

    // 规范保留路径带着用户内容存活……
    assert.equal(existsSync(canonicalBackup), true);
    assert.equal(readFileSync(canonicalBackup, "utf-8"), "USER CUSTOM SKILL\n");
    // ……大小写变体也存活（macOS 上是同一文件，Linux 上是独立文件）。
    assert.equal(existsSync(variantBackup), true);
    if (variantIsDistinct) {
      assert.equal(readFileSync(variantBackup, "utf-8"), "USER CUSTOM SKILL\n");
    }
    // 重写后的清单是干净的：保留路径的变体没有被记录。
    const rewritten = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(rewritten.files["SKILL.MD.USER-BACKUP"], undefined);
  });
});

test("P42-04R3: 随包目录里的保留名大小写变体既不登记也不剪除", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);

    // 一个（少见的）随包目录：带了保留备份名的大小写变体，外加一个真正属主的文件。
    const bundleV1 = writeBundle(root, "bundle-v1", {
      "SKILL.MD.USER-BACKUP": "BUNDLED VARIANT\n",
      "agents/helper.md": "helper\n",
      "dropped-in-v2.md": "stale\n",
    });
    ensureBundledSkillInstalled({ bundledSkillDir: bundleV1, configDir, packageVersion: "1.0.0" });

    // 保留名变体永远不得被登记为属主（也就永远不会被剪除）。
    const manifest1 = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(manifest1.files["SKILL.MD.USER-BACKUP"], undefined);
    assert.equal(manifest1.files["SKILL.md.user-backup"], undefined);
    // 真正属主的文件照常被登记（对照项：遍历器仍然记录非保留文件）。
    assert.equal(typeof manifest1.files["agents/helper.md"], "string");

    // 之后的新包既丢掉变体，也丢掉那个属主文件。
    const bundleV2 = writeBundle(root, "bundle-v2", { "agents/helper.md": "helper\n" });
    ensureBundledSkillInstalled({ bundledSkillDir: bundleV2, configDir, packageVersion: "2.0.0" });

    // 真正属主、未改动、已丢弃的文件被剪除（对照项）……
    assert.equal(existsSync(join(skillsDir, "dropped-in-v2.md")), false);
    // ……但保留名变体既不被登记也不被剪除（在允许独立大小写文件的系统上它是独立文件；
    // 在 macOS 上它只是 SKILL.md 的别名，由既有契约保留）。
    const variantAfter = join(skillsDir, "SKILL.MD.USER-BACKUP");
    const canonicalAfter = join(skillsDir, "SKILL.md.user-backup");
    assert.equal(existsSync(variantAfter) || existsSync(canonicalAfter), true);
  });
});

// ---------------------------------------------------------------------------
// P42-04S2 修正：`files` 必须是 path→hash 的普通对象。数组属于非法元数据：它的数字下标
// （"0"、"1"……）能通过相对路径检查，会被当成属主文件，于是「格式合法、哈希匹配的数组」
// 可能删掉恰好叫数字的真实用户文件。非法元数据必须什么都不删。
// ---------------------------------------------------------------------------

test("P42-04S2: 数组清单属于非法元数据，删不掉名为数字的用户文件", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    // 旧版安装：用户文件名字面量就是 "0"，清单的 `files` 却是数组（非法），里面放着它的哈希。
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), skillMd(SKILL_NAME));
    writeFileSync(join(skillsDir, "0"), "CUSTOM ZERO\n");
    writeFileSync(
      join(skillsDir, INSTALL_MANIFEST_FILE),
      JSON.stringify({ schema: 1, packageVersion: "old", files: [hashText("CUSTOM ZERO\n")] }),
    );
    writeFileSync(join(skillsDir, INSTALL_VERSION_FILE), "old\n");

    const bundle = writeBundle(root, "bundle", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: bundle, configDir, packageVersion: "new" });

    // 非法元数据什么都不删：数字命名的用户文件逐字节存活。
    assert.equal(existsSync(join(skillsDir, "0")), true);
    assert.equal(readFileSync(join(skillsDir, "0"), "utf-8"), "CUSTOM ZERO\n");
    // 正常升级仍然完成，并写出对象形式的清单。
    const rewritten = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(Array.isArray(rewritten.files), false);
    assert.equal(typeof rewritten.files, "object");
    assert.equal(readFileSync(join(skillsDir, INSTALL_VERSION_FILE), "utf-8"), "new\n");
  });
});

test("P42-04S2: 合法对象清单里名为数字的路径仍属主、仍会被剪除", () => {
  withTempDir((root) => {
    const configDir = join(root, "config");
    const skillsDir = join(configDir, "opencode", "skills", SKILL_NAME);
    // v1 带一个名为 "0" 的插件属主文件，它**会**被记录（对象形式的清单）。
    const v1 = writeBundle(root, "bundle-v1", {
      "SKILL.md": skillMd(SKILL_NAME),
      "0": "OWNED ZERO\n",
    });
    ensureBundledSkillInstalled({ bundledSkillDir: v1, configDir, packageVersion: "1.0.0" });
    const manifest1 = JSON.parse(readFileSync(join(skillsDir, INSTALL_MANIFEST_FILE), "utf-8"));
    assert.equal(typeof manifest1.files["0"], "string");

    // v2 丢弃它；真正属主、未改动、已丢弃的文件会被剪除。
    const v2 = writeBundle(root, "bundle-v2", { "SKILL.md": skillMd(SKILL_NAME) });
    ensureBundledSkillInstalled({ bundledSkillDir: v2, configDir, packageVersion: "2.0.0" });
    assert.equal(existsSync(join(skillsDir, "0")), false);
  });
});

test("源文件里旧版 SKILL.md 的改名先于目录移动（顺序回归）", () => {
  // 这是一个源码形状断言（上游同名用例即如此）：顺序颠倒会让旧目录在被改名关闭之前先被
  // 搬走，旧技能名仍可能被加载。
  const source = readFileSync(new URL("../src/lib/skill-install.ts", import.meta.url), "utf-8");
  const disableSkillIndex = source.indexOf(
    'renameSync(backupSkillFile, join(args.legacySkillDir, "SKILL.md.backup"))',
  );
  const moveDirectoryIndex = source.indexOf("renameSync(args.legacySkillDir, backupDir)");

  assert.ok(disableSkillIndex >= 0);
  assert.ok(moveDirectoryIndex >= 0);
  assert.ok(disableSkillIndex < moveDirectoryIndex);
});
