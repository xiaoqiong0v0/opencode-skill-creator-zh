/**
 * 随包技能的安装器。
 *
 * 迁自上游 `plugin/lib/skill-install.ts`（基线 `d4383924`），**行为与上游等价**：
 * 把随包技能目录拷进 `<configDir>/opencode/skills/<SKILL_NAME>`，并用一份内部清单
 * （相对 POSIX 路径 → 安装时内容 sha256）记录「本安装器拷过哪些文件」。升级时只删除
 * 同时满足以下条件的文件：清单里有、磁盘上内容未被改动、新包已不再提供；用户自建、
 * 未被记录、本地改过的文件一律保留。
 *
 * 安装目标完全由调用方传入的 `configDir` 推导，所以测试只给临时目录即可，不会写真实
 * 用户目录。
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** 本包装载后在 opencode 里使用的技能名（也是安装目录名）。 */
export const SKILL_NAME = "opencode-skill-creator";

/** 上游历史技能名；带本安装器版本标记的同名目录会被归档改名。 */
export const LEGACY_SKILL_NAME = "skill-creator";

/** 技能目录内的安装版本标记文件（记录最近一次成功安装的包版本）。 */
export const INSTALL_VERSION_FILE = ".opencode-skill-creator-version";

/**
 * 托管技能目录的属主清单文件名。
 *
 * 只记录本安装器从随包目录拷来的文件及其内容哈希，供后续升级删除「新包已不再提供」
 * 的旧文件，而不用猜用户写了什么。属内部元数据，不是对外工具契约。
 */
export const INSTALL_MANIFEST_FILE = ".opencode-skill-creator-manifest.json";

/**
 * 托管技能目录内的保留根路径：无论清单里记录了什么，本安装器都不得把它们的归属权
 * 收回、也不得删除。它们是用户可能改过的 `SKILL.md`、它的备份、版本标记与属主清单
 * 本身。保护按文件名判断而非哈希比对，所以伪造清单也无法删掉它们。
 */
const RESERVED_ROOT_PATHS: ReadonlySet<string> = new Set([
  "SKILL.md",
  "SKILL.md.user-backup",
  INSTALL_VERSION_FILE,
  INSTALL_MANIFEST_FILE,
]);

/**
 * 保留集合的小写视图。
 *
 * 在不区分大小写的文件系统（macOS/Windows 默认）上，`skill.md` 与 `SKILL.md` 指向同一
 * 个文件，只做精确匹配会被「清单里换个大小写」绕过。统一按 ASCII 小写比较，任何大小写
 * 变体都受保护，与宿主文件系统是否区分大小写无关。
 */
const RESERVED_ROOT_PATHS_LOWER: ReadonlySet<string> = new Set(
  [...RESERVED_ROOT_PATHS].map((name) => name.toLowerCase()),
);

/** `ensureBundledSkillInstalled` 的入参。 */
export interface EnsureBundledSkillInstalledOptions {
  /** 随包技能目录（技能骨架的真源）。不存在时整个安装直接跳过。 */
  bundledSkillDir: string;
  /** opencode 配置根目录（安装目标是其下的 `opencode/skills`）。 */
  configDir: string;
  /** 当前包的版本号；与磁盘上的版本标记不同即触发升级。 */
  packageVersion: string;
  /** 备用目录时间戳生成器，默认用 `YYYYMMDD-HHmmss` 形式的 UTC 时间。 */
  backupTimestamp?: () => string;
  /** 错误上报回调：安装失败不抛异常，而是走这里（避免拖垮插件启动）。 */
  onError?: (message: string, error: unknown) => void;
}

/** 属主清单的结构（`schema` 固定为 1）。 */
interface SkillInstallManifest {
  schema: 1;
  packageVersion: string;
  /** 相对 POSIX 路径 → 安装时该文件的 sha256 十六进制值。 */
  files: Record<string, string>;
}

/**
 * 判断 `rel` 是否为保留根路径（任意 ASCII 大小写变体）。
 *
 * @param rel 相对 POSIX 路径
 * @returns 属于保留根路径时返回 `true`
 */
function isReservedRootPath(rel: string): boolean {
  return RESERVED_ROOT_PATHS_LOWER.has(rel.toLowerCase());
}

/**
 * 递归复制目录（覆盖同名文件）。
 *
 * @param src 源目录
 * @param dest 目标目录；不存在时递归创建
 * @returns 无返回值
 */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 计算文件的 sha256 十六进制摘要。
 *
 * @param path 文件路径
 * @returns 摘要字符串
 */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 读取 `lstat`，失败（不存在、无权限等）时返回 `null`。
 *
 * 用 `lstat` 而非 `stat`：符号链接本身必须被看见，不能被跟随。
 *
 * @param path 目标路径
 * @returns 成功时为文件状态，失败为 `null`
 */
function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * 读取真实路径，失败时返回 `null`。
 *
 * @param path 目标路径
 * @returns 成功时为规范化后的真实路径，失败为 `null`
 */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 计算文件 sha256，读取失败时返回 `null`。
 *
 * @param path 文件路径
 * @returns 成功时为摘要，失败为 `null`
 */
function trySha256File(path: string): string | null {
  try {
    return sha256File(path);
  } catch {
    return null;
  }
}

/**
 * 判断 `rel` 是否为安全、非空、无 `..`／绝对路径／盘符／反斜杠的相对 POSIX 路径。
 *
 * 用来在清单元数据被改动或恶意构造时先行拒绝，避免它指向托管目录之外的文件。
 *
 * @param rel 待检查的取值（可能来自外部 JSON）
 * @returns 合法时返回 `true` 并收窄为 `string`
 */
function isSafeRelativePath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.includes("\\")) return false;
  if (isAbsolute(rel)) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  return rel
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 读取并校验属主清单；缺失或格式非法时返回 `null`（即「什么都不知道，什么也不删」）。
 *
 * `files` 必须是 path→hash 的普通对象：数组形式的元数据（其数字下标 `"0"`、`"1"` 也能
 * 通过相对路径检查）属于非法格式，一律拒绝，从而不会误删名为数字的用户文件。
 *
 * @param skillsDir 托管技能目录
 * @returns 合法时返回清单，否则 `null`
 */
function readManifest(skillsDir: string): SkillInstallManifest | null {
  const manifestPath = join(skillsDir, INSTALL_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.schema !== 1) return null;
    const files = record.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    const checked: Record<string, string> = {};
    for (const [rel, hash] of Object.entries(files as Record<string, unknown>)) {
      if (!isSafeRelativePath(rel) || typeof hash !== "string") return null;
      checked[rel] = hash;
    }
    return {
      schema: 1,
      packageVersion:
        typeof record.packageVersion === "string" ? record.packageVersion : "",
      files: checked,
    };
  } catch {
    return null;
  }
}

/**
 * 写属主清单（两空格缩进 + 结尾换行）。
 *
 * @param skillsDir 托管技能目录
 * @param manifest 要写入的清单
 * @returns 无返回值
 */
function writeManifest(skillsDir: string, manifest: SkillInstallManifest): void {
  writeFileSync(
    join(skillsDir, INSTALL_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * 遍历目录，返回其普通文件的相对 POSIX 路径集合（排除保留根路径）。
 *
 * 这是「本安装器拷来的文件」的唯一真源：随包文件列表与暂存目录清单都由它派生，因此
 * 受保护的文件名永远不会被登记为属主。
 *
 * @param root 遍历根目录
 * @returns 相对 POSIX 路径集合
 */
function listRegularFilesExcludingReserved(root: string): Set<string> {
  const files = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        if (isReservedRootPath(rel)) continue;
        files.add(rel);
      }
    }
  };
  walk(root);
  return files;
}

/**
 * 随包技能目录里实际提供的普通文件（排除保留根路径）。
 *
 * @param bundledSkillDir 随包技能目录
 * @returns 相对 POSIX 路径集合
 */
function listBundleFiles(bundledSkillDir: string): Set<string> {
  return listRegularFilesExcludingReserved(bundledSkillDir);
}

/**
 * 为暂存目录构造属主清单。
 *
 * @param tmpInstallDir 暂存安装目录
 * @param packageVersion 当前包版本
 * @returns 待写入的属主清单
 */
function buildManifest(
  tmpInstallDir: string,
  packageVersion: string,
): SkillInstallManifest {
  const files: Record<string, string> = {};
  for (const rel of listRegularFilesExcludingReserved(tmpInstallDir)) {
    files[rel] = sha256File(join(tmpInstallDir, rel));
  }
  return { schema: 1, packageVersion, files };
}

/**
 * 删除本安装器曾记录、但新包已不再提供的文件。
 *
 * 只有当下列条件**全部**满足时才删：
 *   - 不是保留根路径（任何大小写变体都不删）；
 *   - 出现在旧清单里；
 *   - 磁盘上的内容仍与记录的哈希一致（未被用户改动）；
 *   - 新包里已经没有这个文件；
 *   - 托管目录根与叶子之上的每一级父目录都不是符号链接（内外部别名都不能重定向删除）；
 *   - 磁盘上的叶子是普通文件（不跟随符号链接、不删目录）；
 *   - 它的真实路径仍在托管技能目录内。
 *
 * 其它情况——未跟踪/用户自建文件、本地改动过的已记录文件、没有清单的旧版安装——一律保留。
 *
 * @param skillsDir 托管技能目录
 * @param oldManifest 升级前的属主清单（`null` 表示无清单，直接不删）
 * @param newBundleFiles 新随包目录提供的文件集合
 * @returns 无返回值
 */
function pruneStaleManagedFiles(
  skillsDir: string,
  oldManifest: SkillInstallManifest | null,
  newBundleFiles: ReadonlySet<string>,
): void {
  if (!oldManifest) return;

  // 托管目录根自身不能是符号链接：若是，其下每个路径都会解析到别处，不得做任何删除。
  const rootStats = tryLstat(skillsDir);
  if (!rootStats) return;
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return;

  const canonicalRoot = tryRealpath(skillsDir) ?? skillsDir;
  const isInside = (child: string): boolean => {
    const rel = relative(canonicalRoot, child);
    if (rel === "" || isAbsolute(rel)) return false;
    return rel !== ".." && !rel.startsWith(`..${sep}`);
  };

  for (const [rel, recordedHash] of Object.entries(oldManifest.files)) {
    if (!isSafeRelativePath(rel)) continue;
    if (isReservedRootPath(rel)) continue; // 保留名（任意大小写）永不删除
    if (newBundleFiles.has(rel)) continue;

    // 叶子之上的任何一级目录都不能是符号链接（逐级 lstat；不跟随）。
    const segments = rel.split("/");
    let ancestor = skillsDir;
    let ancestorIsSymlink = false;
    for (let i = 0; i < segments.length - 1; i++) {
      ancestor = join(ancestor, segments[i]);
      const stats = tryLstat(ancestor);
      if (!stats) {
        // 父目录缺失 → 无法判断路径是否被重定向，保守放弃。
        ancestorIsSymlink = true;
        break;
      }
      if (stats.isSymbolicLink()) {
        ancestorIsSymlink = true;
        break;
      }
    }
    if (ancestorIsSymlink) continue;

    const target = join(skillsDir, rel);
    const targetStats = tryLstat(target);
    if (!targetStats) continue; // 已经不在了
    if (!targetStats.isFile()) continue; // 不跟随符号链接，也不删目录

    const canonicalTarget = tryRealpath(target);
    if (!canonicalTarget) continue;
    if (!isInside(canonicalTarget)) continue;

    const onDiskHash = trySha256File(target);
    if (!onDiskHash) continue;
    if (onDiskHash !== recordedHash) continue; // 本地改过 → 保留

    rmSync(target, { force: true });
  }
}

/**
 * 默认备份目录时间戳：UTC 的 `YYYYMMDD-HHmmss`（去掉分隔符与毫秒）。
 *
 * @returns 时间戳字符串
 */
function defaultBackupTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

/**
 * 找一个未被占用的旧版技能备份目录名。
 *
 * @param skillsRoot 技能根目录（备份与技能目录同级）
 * @param timestamp 时间戳（由 `backupTimestamp` 提供）
 * @returns 可用的备份目录绝对路径
 */
function uniqueBackupDir(skillsRoot: string, timestamp: string): string {
  const base = join(
    skillsRoot,
    `${LEGACY_SKILL_NAME}.opencode-skill-creator-backup-${timestamp}`,
  );
  if (!existsSync(base)) return base;

  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }

  throw new Error("Could not find an available legacy skill backup path");
}

/**
 * 归档「带本安装器版本标记」的旧版技能目录。
 *
 * 先把 `SKILL.md` 改名为 `SKILL.md.backup`（使旧目录即使被加载也不再是一个有效技能），
 * 再整体改名到带时间戳的备份目录。没有版本标记的目录视为第三方技能，原样保留。
 *
 * @param args 技能根目录、旧版技能目录与时间戳生成器
 * @returns 无返回值
 */
function archiveLegacySkill(args: {
  skillsRoot: string;
  legacySkillDir: string;
  backupTimestamp: () => string;
}): void {
  const legacyVersionFile = join(args.legacySkillDir, INSTALL_VERSION_FILE);
  if (!existsSync(legacyVersionFile)) return;

  const backupDir = uniqueBackupDir(args.skillsRoot, args.backupTimestamp());

  const backupSkillFile = join(args.legacySkillDir, "SKILL.md");
  if (existsSync(backupSkillFile)) {
    renameSync(backupSkillFile, join(args.legacySkillDir, "SKILL.md.backup"));
  }

  renameSync(args.legacySkillDir, backupDir);
}

/**
 * 确保随包技能已按当前包版本安装到 opencode 的全局技能目录。
 *
 * 安装失败不抛异常（插件启动时调用，不能因此中断 opencode），一律交给 `onError`。
 * 版本一致且 `SKILL.md` 存在时不做任何拷贝，只处理旧版目录归档。
 *
 * @param options 随包目录、配置根目录、包版本与错误回调
 * @returns 无返回值
 */
export function ensureBundledSkillInstalled(
  options: EnsureBundledSkillInstalledOptions,
): void {
  const skillsRoot = join(options.configDir, "opencode", "skills");
  const skillsDir = join(skillsRoot, SKILL_NAME);
  const legacySkillDir = join(skillsRoot, LEGACY_SKILL_NAME);
  const marker = join(skillsDir, "SKILL.md");
  const versionFile = join(skillsDir, INSTALL_VERSION_FILE);
  const userSkillFile = join(skillsDir, "SKILL.md");
  const userSkillBackup = join(skillsDir, "SKILL.md.user-backup");

  if (!existsSync(options.bundledSkillDir)) return;

  let installedVersion = "";
  if (existsSync(versionFile)) {
    try {
      installedVersion = readFileSync(versionFile, "utf-8").trim();
    } catch {
      installedVersion = "";
    }
  }

  const shouldInstall = !existsSync(marker) || installedVersion !== options.packageVersion;
  const tmpInstallDir = `${skillsDir}.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    if (shouldInstall) {
      // 先快照旧的属主清单：清单缺失/格式非法时等于「无清单」（旧版安装），不删任何东西。
      const oldManifest = readManifest(skillsDir);

      copyDirRecursive(options.bundledSkillDir, tmpInstallDir);

      if (existsSync(userSkillFile)) {
        try {
          copyFileSync(userSkillFile, userSkillBackup);
        } catch (error) {
          options.onError?.(
            `Failed to back up existing user skill file before updating ${SKILL_NAME}`,
            error,
          );
        }

        try {
          // 用户改过的 SKILL.md 优先：拷进暂存目录，覆盖随包版本。
          copyFileSync(userSkillFile, join(tmpInstallDir, "SKILL.md"));
        } catch {
          // 拷贝失败就退回随包 SKILL.md。
        }
      }

      const newManifest = buildManifest(tmpInstallDir, options.packageVersion);
      // 「过期」只按新随包目录判定，不看暂存副本（暂存副本里可能有用户覆盖的 SKILL.md）。
      const newBundleFiles = listBundleFiles(options.bundledSkillDir);

      if (!existsSync(skillsDir)) {
        renameSync(tmpInstallDir, skillsDir);
      } else {
        // 只删「曾记录 + 未改动 + 新包不再提供」的文件；用户自建、未跟踪、本地改动过的
        // 文件都不碰；旧版安装（无清单）什么都不删。
        pruneStaleManagedFiles(skillsDir, oldManifest, newBundleFiles);
        copyDirRecursive(tmpInstallDir, skillsDir);
      }

      // 先写属主清单，再推进版本标记：清单写失败时版本标记仍停在上一次成功的版本，
      // 错误也会被上报，于是「失败的升级」不会冒充成新版本。（这是尽力而为的写入顺序，
      // 不是两文件的原子事务：两次写入之间仍可能被打断。）
      writeManifest(skillsDir, newManifest);
      writeFileSync(versionFile, `${options.packageVersion}\n`);
    }

    if (existsSync(legacySkillDir)) {
      archiveLegacySkill({
        skillsRoot,
        legacySkillDir,
        backupTimestamp: options.backupTimestamp ?? defaultBackupTimestamp,
      });
    }
  } catch (error) {
    options.onError?.("Failed to install opencode-skill-creator skill", error);
  } finally {
    if (existsSync(tmpInstallDir)) {
      rmSync(tmpInstallDir, { recursive: true, force: true });
    }
  }
}
