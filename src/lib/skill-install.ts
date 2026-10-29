/**
 * 随包技能的安装器（docs/SPEC.md R6.1 的 I1–I5）。
 *
 * 与前身（上游 `d4383924` 的 `plugin/lib/skill-install.ts`）的区别是**四条硬约束**：
 *   1. 白名单拷贝：只写 `SKILL.md`、`agents/**`、`references/**`、`templates/**`；
 *   2. 元数据外置：版本、属主清单、用户改动备份只写 `skills/.skill-zh-state/<name>.json`；
 *   3. 安装前只读探测同名技能（`.claude` / `.agents` / OpenCode 配置目录 / `skills.paths`）；
 *   4. 用户改过的 `SKILL.md` 默认不覆盖，`--force` 才覆盖且先备份到状态目录。
 *
 * 安装是**纯同步**的：整个写盘过程在一个同步片段里完成，因此启动钩子的后台安装与用户
 * 显式调用的 `install` 不会在同一进程内交错（见 docs/ASYNC.md 的「启动静默安装」）。
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
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

import { debugLog } from "./debug.js";

/** 本包装载后在 opencode 里使用的技能名，也是安装目录名与技能 frontmatter 的 `name`。 */
export const SKILL_NAME = "opencode-skill-creator-zh";

/** 技能本体文件名；比较一律不区分大小写（Windows/macOS 上 `skill.md` 是同一个文件）。 */
export const SKILL_MD_FILE = "SKILL.md";

/** 允许进入安装目标 / 导出产物的顶层目录（白名单，比较不区分大小写）。 */
export const SKILL_CONTENT_DIRS = ["agents", "references", "templates"] as const;

/** 安装状态目录名（与技能目录平级，位于 `skills/` 下）。 */
export const STATE_DIR_NAME = ".skill-zh-state";

/** 状态文件名（一技能一 json）。 */
export const STATE_FILE_NAME = `${SKILL_NAME}.json`;

/** 默认技能根目录（`~/.config/opencode/skills`）相对 home 的路径。 */
const DEFAULT_SKILLS_SUBDIR = [".config", "opencode", "skills"] as const;

/** 旧版安装器写在技能目录内的版本标记 / 属主清单文件名；升级时清理，保证 I2。 */
export const LEGACY_METADATA_FILES = [
  ".opencode-skill-creator-version",
  ".opencode-skill-creator-manifest.json",
] as const;

/** 旧版安装器写在技能目录内的用户改动备份名。 */
export const LEGACY_USER_BACKUP_FILE = "SKILL.md.user-backup";

/** 白名单目录的小写集合，避免每次比较都 lower-case 一遍常量。 */
const WHITELIST_DIR_SET: ReadonlySet<string> = new Set(SKILL_CONTENT_DIRS.map((name) => name.toLowerCase()));

/** 包根下的随包技能目录（`dist/lib/` 与 `src/lib/` 相对包根层数相同）。 */
const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../../skill/", import.meta.url));

/** 包根 `package.json`（用于读取当前包版本）。 */
const PACKAGE_JSON_PATH = fileURLToPath(new URL("../../package.json", import.meta.url));

/** 环境变量真值判定：`1` / `true` / 其它非空值视为开启，`0` / `false` 视为关闭。 */
const FALSE_ENV_VALUES: ReadonlySet<string> = new Set(["0", "false", "off", "no"]);

/** 白名单内的一个源文件。 */
export interface SkillBundleFile {
  /** 源文件绝对路径。 */
  sourcePath: string;
  /** 目标目录里的相对 POSIX 路径（顶层 `skill.md` 规范成 `SKILL.md`）。 */
  relativePath: string;
  /** 字节数。 */
  size: number;
  /** 内容 sha256。 */
  sha256: string;
}

/** 白名单列举结果。 */
export interface SkillBundleListing {
  /** 白名单内的文件（按相对路径排序）。 */
  files: SkillBundleFile[];
  /** 被跳过的顶层条目（目录带尾 `/`），供输出与调试点名。 */
  skipped: string[];
  /** 源目录是否提供了 `SKILL.md`（任意大小写）。 */
  hasSkillMd: boolean;
}

/** 状态文件结构：版本 + 属主文件哈希 + 最近一次用户改动备份位置。 */
export interface SkillInstallState {
  schema: 1;
  name: string;
  packageVersion: string;
  installedAt: string;
  /** 相对 POSIX 路径 → 随包内容的 sha256（不是磁盘现状）。 */
  files: Record<string, string>;
  /** 最近一次 `--force` 备份的相对位置（相对状态目录）；没有则为 `null`。 */
  lastBackup: string | null;
}

/** 单个文件在本次安装中的处置。 */
export type SkillFileAction = "write" | "same" | "keep-user";

/** 单个文件的处置记录。 */
export interface SkillFileResult {
  relativePath: string;
  size: number;
  action: SkillFileAction;
}

/** 同名技能探测来源。 */
export type SkillConflictSource = "claude" | "agents" | "opencode" | "project-opencode" | "skills.paths";

/** 一条同名技能探测结果。 */
export interface SkillConflict {
  /** 同名技能目录的绝对路径。 */
  path: string;
  /** 发现来源。 */
  source: SkillConflictSource;
  /** 来源的可读名称。 */
  sourceLabel: string;
  /** 该来源当前是否被环境变量关闭（关闭时不算冲突）。 */
  enabled: boolean;
  /** 是否按扫描顺序最后命中（即当前生效的那份）。 */
  effective: boolean;
}

/** `installBundledSkill` 的入参。 */
export interface InstallBundledSkillOptions {
  /** 随包技能目录（白名单源）。 */
  sourceDir: string;
  /** 技能根目录；缺省 `~/.config/opencode/skills`。 */
  skillsRoot?: string;
  /** 当前包版本；缺省读包根 `package.json`。 */
  packageVersion?: string;
  /** `--force`：覆盖用户改过的 `SKILL.md`（先备份到状态目录）。 */
  force?: boolean;
  /** `--dry-run`：只计算处置，不写盘。 */
  dryRun?: boolean;
  /** 单个项目目录（兼容旧调用）。 */
  projectDir?: string;
  /** 项目目录列表（通常是 `directory` → `worktree`）；启动钩子没有上下文时不传。 */
  projectDirs?: string[];
  /** home 目录覆盖（测试用）；缺省 `os.homedir()`。 */
  homeDir?: string;
  /** 环境变量覆盖（测试用）；缺省 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 时间戳生成器（备份文件名用）；缺省 ISO 时间的紧凑形式。 */
  now?: () => string;
}

/** 安装结果。 */
export interface SkillInstallResult {
  /** 目标技能目录。 */
  targetDir: string;
  /** 状态目录。 */
  stateDir: string;
  /** 状态文件。 */
  stateFile: string;
  /** 当前包版本。 */
  packageVersion: string;
  /** 安装前的版本（没有状态文件时为空串）。 */
  previousVersion: string;
  /** 目标 `SKILL.md` 是否被本地改过。 */
  userModified: boolean;
  /** 本次是否真的写了盘。 */
  changed: boolean;
  /** 处置结论：`dry-run` / `up-to-date` / `installed` / `upgraded`。 */
  status: "dry-run" | "up-to-date" | "kept-user" | "installed" | "upgraded";
  /** 白名单文件的处置清单。 */
  files: SkillFileResult[];
  /** 白名单外被跳过的顶层条目。 */
  skipped: string[];
  /** 同名技能探测结果（含被环境变量关闭的来源）。 */
  conflicts: SkillConflict[];
  /** `--force` 的备份绝对路径。 */
  backupPath: string | null;
  /** 从旧状态清单里清理掉的文件（相对路径）。 */
  removed: string[];
  /** 清理掉的旧版安装器元数据（相对路径）。 */
  cleanedMetadata: string[];
  /** 从技能目录迁到状态目录的旧版备份（源与目标绝对路径）。 */
  migratedBackups: Array<{ from: string; to: string }>;
}

/** `detectSkillConflicts` 的入参。 */
export interface DetectSkillConflictsOptions {
  /** 要探测的技能名（目录名）。 */
  name: string;
  /** home 目录；缺省 `os.homedir()`。 */
  homeDir?: string;
  /** 单个项目目录（兼容旧调用）；等价于 `projectDirs: [projectDir]`。 */
  projectDir?: string;
  /** 项目目录列表（通常是 `directory` → `worktree`）；逐层向上探测。 */
  projectDirs?: string[];
  /** 环境变量；缺省 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 需要排除的自身目录（安装目标本身不算冲突）。 */
  excludeDir?: string;
}

/** 一个候选探测位置。 */
interface ConflictCandidate {
  path: string;
  source: SkillConflictSource;
  label: string;
  enabled: boolean;
}

/**
 * 判断环境变量是否开启。
 *
 * @param value 环境变量取值
 * @returns 非空且不是 `0`/`false`/`off`/`no` 时为 `true`
 */
function isEnvEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return !FALSE_ENV_VALUES.has(normalized);
}

/**
 * 把路径统一成 `/` 分隔，供输出与状态文件使用。
 *
 * @param path 任意文件系统路径
 * @returns 用 `/` 分段的路径文本
 */
export function toDisplayPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * 读取包版本。
 *
 * @returns `package.json` 的 `version`；读取失败时为 `0.0.0`
 */
export function readPackageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { version?: unknown }).version === "string") {
      return (parsed as { version: string }).version;
    }
  } catch {
    // 读不到版本不阻断安装：退回 0.0.0，下一次成功安装会更新状态。
  }
  return "0.0.0";
}

/**
 * 定位随包技能目录。
 *
 * 默认用 `import.meta.url` 找包内 `skill/`（**不依赖 cwd**）；`SKILL_ZH_SKILL_SOURCE`
 * 仅供本地开发 / 测试指向待验证的技能目录。
 *
 * @returns 随包技能目录绝对路径
 */
export function resolveBundledSkillDir(): string {
  const override = process.env.SKILL_ZH_SKILL_SOURCE;
  return override ? resolve(override) : BUNDLED_SKILL_DIR;
}

/**
 * 默认技能根目录。
 *
 * @param home home 目录
 * @returns `<home>/.config/opencode/skills`
 */
export function defaultSkillsRoot(home: string): string {
  return join(home, ...DEFAULT_SKILLS_SUBDIR);
}

/**
 * 判断相对 POSIX 路径是否命中白名单（不区分大小写）。
 *
 * @param relativePath 相对 POSIX 路径
 * @returns 顶层 `SKILL.md`（任意大小写）或 `agents/`、`references/`、`templates/` 下时为 `true`
 */
export function isWhitelistedSkillPath(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").toLowerCase().split("/");
  if (segments.length === 1 && segments[0] === SKILL_MD_FILE.toLowerCase()) return true;
  if (segments.length < 2) return false;
  return WHITELIST_DIR_SET.has(segments[0] ?? "");
}

/**
 * 递归列举白名单目录下的普通文件。
 *
 * @param dir 当前目录绝对路径
 * @param prefix 目标相对路径前缀（顶层目录已规范成小写白名单名）
 * @param files 收集结果
 * @param skipped 被跳过的非普通文件（符号链接等）
 */
function walkWhitelistDir(
  dir: string,
  prefix: string,
  files: Array<{ sourcePath: string; relativePath: string }>,
  skipped: string[],
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      walkWhitelistDir(abs, rel, files, skipped);
      continue;
    }
    if (entry.isFile()) {
      files.push({ sourcePath: abs, relativePath: rel });
      continue;
    }
    skipped.push(toDisplayPath(rel));
  }
}

/**
 * 按白名单列举技能目录里的文件。
 *
 * 白名单外的顶层条目只记录、不进入结果；顶层 `skill.md` 的任意大小写都规范成
 * `SKILL.md` 落盘（Windows/macOS 上二者是同一个文件）。
 *
 * @param sourceDir 技能目录
 * @returns 文件清单 + 跳过清单
 * @throws 目录不存在时抛错
 */
export function listSkillBundle(sourceDir: string): SkillBundleListing {
  const stats = statSync(sourceDir);
  if (!stats.isDirectory()) throw new Error(`技能目录不是目录：${toDisplayPath(sourceDir)}`);

  const rawFiles: Array<{ sourcePath: string; relativePath: string }> = [];
  const skipped: string[] = [];
  let hasSkillMd = false;

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const abs = join(sourceDir, entry.name);
    const lowerName = entry.name.toLowerCase();

    if (entry.isFile() && isWhitelistedSkillPath(entry.name)) {
      hasSkillMd = true;
      rawFiles.push({ sourcePath: abs, relativePath: SKILL_MD_FILE });
      continue;
    }
    if (entry.isDirectory() && WHITELIST_DIR_SET.has(lowerName)) {
      walkWhitelistDir(abs, lowerName, rawFiles, skipped);
      continue;
    }
    skipped.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }

  const files: SkillBundleFile[] = rawFiles
    .map((file) => {
      const statsOfFile = statSync(file.sourcePath);
      return {
        ...file,
        size: statsOfFile.size,
        sha256: sha256File(file.sourcePath),
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return { files, skipped: skipped.sort(), hasSkillMd };
}

/**
 * 计算文件的 sha256 十六进制摘要。
 *
 * @param path 文件路径
 * @returns 摘要字符串
 */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 计算文件 sha256，读取失败时返回 `null`。
 *
 * @param path 文件路径
 * @returns 摘要或 `null`
 */
function trySha256File(path: string): string | null {
  try {
    return sha256File(path);
  } catch {
    return null;
  }
}

/**
 * 读取 `lstat`，失败时返回 `null`。
 *
 * @param path 目标路径
 * @returns 文件状态或 `null`
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
 * @returns 真实路径或 `null`
 */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * 判断相对路径是否安全（无 `..`、非绝对、无反斜杠）。
 *
 * @param rel 待检查取值（可能来自外部 JSON）
 * @returns 合法时返回 `true` 并收窄为 `string`
 */
export function isSafeRelativePath(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.includes("\\")) return false;
  if (isAbsolute(rel)) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  return rel.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 读取状态文件；缺失或格式非法时返回 `null`。
 *
 * @param stateFile 状态文件路径
 * @returns 合法状态或 `null`
 */
export function readInstallState(stateFile: string): SkillInstallState | null {
  if (!existsSync(stateFile)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.schema !== 1 || record.name !== SKILL_NAME) return null;
    const files = record.files;
    if (!files || typeof files !== "object" || Array.isArray(files)) return null;
    const checked: Record<string, string> = {};
    for (const [rel, hash] of Object.entries(files as Record<string, unknown>)) {
      if (!isSafeRelativePath(rel) || typeof hash !== "string") return null;
      checked[rel] = hash;
    }
    return {
      schema: 1,
      name: SKILL_NAME,
      packageVersion: typeof record.packageVersion === "string" ? record.packageVersion : "",
      installedAt: typeof record.installedAt === "string" ? record.installedAt : "",
      files: checked,
      lastBackup: typeof record.lastBackup === "string" ? record.lastBackup : null,
    };
  } catch {
    return null;
  }
}

/**
 * 原子写状态文件（先写临时文件再 rename，避免半截 JSON）。
 *
 * @param stateFile 状态文件路径
 * @param state 状态内容
 */
function writeInstallState(stateFile: string, state: SkillInstallState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  renameSync(tmp, stateFile);
}

/**
 * 比较两份属主清单是否一致。
 *
 * @param a 旧清单
 * @param b 新清单
 * @returns 键值完全一致时为 `true`
 */
function sameFileMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * 生成默认备份时间戳（`YYYYMMDD-HHmmss`，UTC）。
 *
 * @returns 时间戳字符串
 */
function defaultTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
}

/**
 * 在状态目录里找一个未被占用的备份文件名。
 *
 * @param stateDir 状态目录
 * @param timestamp 时间戳
 * @returns 可用的备份绝对路径
 */
function uniqueBackupPath(stateDir: string, fileName: string): string {
  const base = join(stateDir, fileName);
  if (!existsSync(base)) return base;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("找不到可用的备份文件名");
}

/** 旧版元数据的处置计划。 */
interface LegacyMetadataPlan {
  /** 可直接删除的文件（相对技能目录）。 */
  remove: string[];
  /** 需要迁到状态目录的备份。 */
  migrate: Array<{ from: string; to: string }>;
}

/**
 * 规划旧版元数据处置：版本标记 / 清单直接清理；用户备份只有在内容等于当前 SKILL.md
 * 或包内 SKILL.md 时才删，否则先迁到状态目录，避免丢掉用户历史改动。
 *
 * @param targetDir 目标技能目录
 * @param stateDir 状态目录
 * @param bundleSkillPath 包内 SKILL.md 路径（没有时为 `undefined`）
 * @param timestamp 迁移文件名用的时间戳
 * @returns 清理与迁移计划
 */
function planLegacyMetadata(
  targetDir: string,
  stateDir: string,
  bundleSkillPath: string | undefined,
  timestamp: string,
): LegacyMetadataPlan {
  const remove: string[] = [];
  const migrate: Array<{ from: string; to: string }> = [];

  for (const name of LEGACY_METADATA_FILES) {
    const stats = tryLstat(join(targetDir, name));
    if (stats && !stats.isDirectory()) remove.push(name);
  }

  const backupPath = join(targetDir, LEGACY_USER_BACKUP_FILE);
  const backupStats = tryLstat(backupPath);
  if (!backupStats || !backupStats.isFile()) return { remove, migrate };

  const backupHash = trySha256File(backupPath);
  const currentHash = trySha256File(join(targetDir, SKILL_MD_FILE));
  const bundleHash = bundleSkillPath === undefined ? null : trySha256File(bundleSkillPath);
  if (backupHash !== null && (backupHash === currentHash || backupHash === bundleHash)) {
    remove.push(LEGACY_USER_BACKUP_FILE);
    return { remove, migrate };
  }

  migrate.push({
    from: backupPath,
    to: uniqueBackupPath(stateDir, `${LEGACY_USER_BACKUP_FILE}.bak-${timestamp}`),
  });
  return { remove, migrate };
}

/**
 * 确保目标目录存在且自身不是符号链接（避免写穿到别处）。
 *
 * @param dir 目标目录
 */
function ensureSafeDirectory(dir: string): void {
  const stats = tryLstat(dir);
  if (stats) {
    if (stats.isSymbolicLink()) throw new Error(`目标目录是符号链接，拒绝写入：${toDisplayPath(dir)}`);
    if (!stats.isDirectory()) throw new Error(`目标路径不是目录：${toDisplayPath(dir)}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
}

/**
 * 确保相对目录在目标根内逐级存在，且没有任何一级是符号链接。
 *
 * @param root 目标根
 * @param relativeDir 相对目录（可为空串）
 */
function ensureRelativeDirectory(root: string, relativeDir: string): void {
  if (relativeDir === "") return;
  let current = root;
  for (const segment of relativeDir.split("/")) {
    current = join(current, segment);
    const stats = tryLstat(current);
    if (!stats) {
      mkdirSync(current);
      continue;
    }
    if (stats.isSymbolicLink()) throw new Error(`目标子目录是符号链接，拒绝写入：${toDisplayPath(current)}`);
    if (!stats.isDirectory()) throw new Error(`目标子路径不是目录：${toDisplayPath(current)}`);
  }
}

/**
 * 写一个白名单文件到目标目录。
 *
 * @param root 目标技能目录
 * @param file 源文件信息
 */
function writeBundleFile(root: string, file: SkillBundleFile): void {
  const segments = file.relativePath.split("/");
  const relativeDir = segments.slice(0, -1).join("/");
  ensureRelativeDirectory(root, relativeDir);
  const dest = join(root, file.relativePath);
  const stats = tryLstat(dest);
  if (stats?.isSymbolicLink()) rmSync(dest, { force: true });
  if (stats?.isDirectory()) throw new Error(`目标位置是目录，拒绝覆盖：${toDisplayPath(dest)}`);
  copyFileSync(file.sourcePath, dest);
}

/**
 * 把路径规范成可比较的形式：存在则 realpath；不存在则对最近存在的祖先取 realpath，
 * 再拼回剩余段（这样 tmpdir 有符号链接时，不存在的子路径也能正确判定归属）。
 *
 * Windows 默认不区分大小写，比较前统一小写。
 *
 * @param path 任意路径
 * @returns 规范化后的绝对路径
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const remainder: string[] = [];
  let current = absolute;

  while (true) {
    const real = tryRealpath(current);
    if (real !== null) {
      const rebuilt = remainder.length > 0 ? join(real, ...remainder.reverse()) : real;
      return process.platform === "win32" ? rebuilt.toLowerCase() : rebuilt;
    }
    const parent = dirname(current);
    if (parent === current) {
      return process.platform === "win32" ? absolute.toLowerCase() : absolute;
    }
    remainder.push(basename(current));
    current = parent;
  }
}

/**
 * 判断 `child` 是否在 `parent` 内（含相等）。
 *
 * Windows 默认不区分大小写，比较前统一小写，避免 `C:\A` 与 `c:\a` 误判。
 *
 * @param parent 父目录
 * @param child 子路径
 * @returns 在内部或相等时为 `true`
 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

/**
 * 从旧状态清单里删除「新包已不再提供且未被用户改动」的文件。
 *
 * @param targetDir 目标技能目录
 * @param oldState 旧状态（`null` 时不删任何东西）
 * @param bundlePaths 新包提供的相对路径集合
 * @param dryRun 只计算不删除
 * @returns 被删除（或将要删除）的相对路径
 */
function pruneStaleFiles(
  targetDir: string,
  oldState: SkillInstallState | null,
  bundlePaths: ReadonlySet<string>,
  dryRun: boolean,
): string[] {
  if (!oldState) return [];
  const rootStats = tryLstat(targetDir);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) return [];
  const rootReal = tryRealpath(targetDir);
  const removed: string[] = [];

  for (const [rel, recordedHash] of Object.entries(oldState.files)) {
    if (!isSafeRelativePath(rel)) continue;
    if (rel.toLowerCase() === SKILL_MD_FILE.toLowerCase()) continue; // 技能本体永不自动删
    if (bundlePaths.has(rel)) continue;

    const segments = rel.split("/");
    let ancestor = targetDir;
    let blocked = false;
    for (let index = 0; index < segments.length - 1; index += 1) {
      ancestor = join(ancestor, segments[index] ?? "");
      const stats = tryLstat(ancestor);
      if (!stats || stats.isSymbolicLink()) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    const target = join(targetDir, rel);
    const stats = tryLstat(target);
    if (!stats || !stats.isFile()) continue;
    const real = tryRealpath(target);
    if (!real || !rootReal || !isPathInside(rootReal, real)) continue;
    if (trySha256File(target) !== recordedHash) continue; // 用户改过 → 保留

    removed.push(rel);
    if (!dryRun) rmSync(target, { force: true });
  }

  return removed;
}

/**
 * 删除 prune 之后留下的空目录（只到目标技能目录为止，不向上越界）。
 *
 * @param targetDir 目标技能目录
 * @param removed 被删除文件的相对路径
 */
function removeEmptyParentDirs(targetDir: string, removed: string[]): void {
  const dirs = new Set<string>();
  for (const rel of removed) {
    let dir = dirname(rel).replaceAll("\\", "/");
    while (dir !== "." && dir !== "/" && dir !== "") {
      if (!isSafeRelativePath(dir)) break;
      dirs.add(dir);
      dir = dirname(dir).replaceAll("\\", "/");
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)) {
    try {
      rmdirSync(join(targetDir, dir));
    } catch {
      // 目录非空或已不存在：保留，不做强制删除。
    }
  }
}

/**
 * 读取 opencode 配置里的 `skills.paths`。
 *
 * @param configFiles 候选配置文件
 * @returns 解析出的路径（已相对配置文件目录解析）
 */
function readConfiguredSkillPaths(configFiles: string[]): string[] {
  const paths: string[] = [];
  for (const configFile of configFiles) {
    if (!existsSync(configFile)) continue;
    try {
      const parsed: unknown = parseJsonc(readFileSync(configFile, "utf-8"));
      if (!parsed || typeof parsed !== "object") continue;
      const skills = (parsed as { skills?: unknown }).skills;
      if (!skills || typeof skills !== "object") continue;
      const configured = (skills as { paths?: unknown }).paths;
      if (!Array.isArray(configured)) continue;
      for (const entry of configured) {
        if (typeof entry !== "string" || entry.trim() === "") continue;
        paths.push(resolve(dirname(configFile), entry));
      }
    } catch {
      // 配置损坏时按「没有配置」处理：探测是只读辅助信息，不阻断安装。
    }
  }
  return paths;
}

/** 同名技能递归扫描的最大深度（skills/<任意层级>/SKILL.md）。 */
const MAX_SKILL_SCAN_DEPTH = 6;

/** 单个来源最多检查的目录项，避免 skills.paths 指到超大目录时卡住安装。 */
const MAX_SKILL_SCAN_ENTRIES = 2000;

/**
 * 读取 SKILL.md frontmatter 里的 `name`。
 *
 * @param skillMdPath SKILL.md 绝对路径
 * @returns name 值；没有 frontmatter / 没有 name / 读不到时为 `null`
 */
function readSkillFrontmatterName(skillMdPath: string): string | null {
  try {
    const content = readFileSync(skillMdPath, "utf-8").replace(/\r\n/g, "\n");
    if (!content.startsWith("---")) return null;
    for (const line of content.split("\n").slice(1)) {
      if (line.trim() === "---") break;
      const match = /^name\s*:\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // 读不到就当没有 frontmatter：目录名匹配仍然有效。
  }
  return null;
}

/**
 * 在某个 skills 根下递归找同名技能（目录名或 frontmatter `name` 命中）。
 *
 * 对应 opencode 的 `skills/<任意层级>/SKILL.md`：不是只扫一层，也不只看目录名。
 *
 * @param root skills 根目录
 * @param name 目标技能名
 * @param source 来源分类
 * @param label 来源可读名称
 * @param enabled 该来源当前是否被环境变量关闭
 * @returns 命中的候选（每个 SKILL.md 至多一条）
 */
function collectSameNameSkills(
  root: string,
  name: string,
  source: SkillConflictSource,
  label: string,
  enabled: boolean,
): ConflictCandidate[] {
  if (!existsSync(root)) return [];
  const target = name.toLowerCase();
  const found: ConflictCandidate[] = [];
  let visited = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SKILL_SCAN_DEPTH || visited > MAX_SKILL_SCAN_ENTRIES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SKILL_SCAN_ENTRIES) return;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== SKILL_MD_FILE.toLowerCase()) continue;
      const frontmatterName = readSkillFrontmatterName(abs);
      const dirName = basename(dir);
      if (dirName.toLowerCase() === target || frontmatterName?.toLowerCase() === target) {
        found.push({ path: dir, source, label, enabled });
      }
    }
  };

  walk(root, 0);
  return found;
}

/**
 * 收集项目目录链：每个起点逐层向上到文件系统根，去重后保持「近 → 远」顺序。
 *
 * @param projectDirs 起点（通常是 `directory` 与 `worktree`）
 * @returns 目录链（近的在前）
 */
function collectProjectLevels(projectDirs: string[]): string[] {
  const levels: string[] = [];
  const seen = new Set<string>();
  for (const start of projectDirs) {
    if (start.trim() === "") continue;
    let dir = resolve(start);
    while (true) {
      const key = process.platform === "win32" ? dir.toLowerCase() : dir;
      if (!seen.has(key)) {
        seen.add(key);
        levels.push(dir);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return levels;
}

/**
 * 探测同名技能。
 *
 * 只读：不创建、不修改、不删除任何探测目录。环境变量关闭的来源仍会出现在结果里，
 * 但 `enabled=false`，调用方应把它当作「不算冲突」。
 *
 * @param options 名称、home、项目目录、环境变量与自身排除目录
 * @returns 已存在的同名技能（按扫描顺序）
 */
export function detectSkillConflicts(options: DetectSkillConflictsOptions): SkillConflict[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const projectDirs = [
    ...(options.projectDirs ?? []),
    ...(options.projectDir === undefined ? [] : [options.projectDir]),
  ];
  const levels = collectProjectLevels(projectDirs);

  const disableExternal = isEnvEnabled(env.OPENCODE_DISABLE_EXTERNAL_SKILLS);
  const disableClaude =
    disableExternal ||
    isEnvEnabled(env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) ||
    isEnvEnabled(env.OPENCODE_DISABLE_CLAUDE_CODE);

  const candidates: ConflictCandidate[] = [];
  const addSource = (
    root: string,
    source: SkillConflictSource,
    label: string,
    enabled: boolean,
  ): void => {
    candidates.push(...collectSameNameSkills(root, options.name, source, label, enabled));
  };

  // 扫描顺序 = opencode 的覆盖顺序：外部 .claude → .agents → config → skills.paths。
  // 用户级先、项目逐层后；同名时后扫描的生效。
  addSource(join(home, ".claude", "skills"), "claude", "外部 .claude（用户级）", !disableClaude);
  for (const level of levels) {
    addSource(join(level, ".claude", "skills"), "claude", "外部 .claude（项目逐层）", !disableClaude);
  }
  addSource(join(home, ".agents", "skills"), "agents", "外部 .agents（用户级）", !disableExternal);
  for (const level of levels) {
    addSource(join(level, ".agents", "skills"), "agents", "外部 .agents（项目逐层）", !disableExternal);
  }

  const opencodeRoot = join(home, ".config", "opencode");
  addSource(join(opencodeRoot, "skills"), "opencode", "OpenCode 用户级 skills/", true);
  addSource(join(opencodeRoot, "skill"), "opencode", "OpenCode 用户级 skill/", true);
  for (const level of levels) {
    addSource(join(level, ".opencode", "skills"), "project-opencode", "OpenCode 项目级 skills/", true);
    addSource(join(level, ".opencode", "skill"), "project-opencode", "OpenCode 项目级 skill/", true);
  }

  const configFiles: string[] = [
    join(opencodeRoot, "opencode.json"),
    join(opencodeRoot, "opencode.jsonc"),
  ];
  for (const level of levels) {
    configFiles.push(
      join(level, "opencode.json"),
      join(level, "opencode.jsonc"),
      join(level, ".opencode", "opencode.json"),
      join(level, ".opencode", "opencode.jsonc"),
    );
  }
  const configuredPaths = [...new Set(readConfiguredSkillPaths([...new Set(configFiles)]))];
  for (const configuredPath of configuredPaths) {
    addSource(configuredPath, "skills.paths", "skills.paths 配置", true);
  }

  const exclude = options.excludeDir === undefined ? null : canonicalPath(options.excludeDir);
  const seen = new Set<string>();
  const conflicts: SkillConflict[] = [];

  for (const candidate of candidates) {
    const key = canonicalPath(candidate.path);
    if (exclude !== null && key === exclude) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({
      path: candidate.path,
      source: candidate.source,
      sourceLabel: candidate.label,
      enabled: candidate.enabled,
      effective: false,
    });
  }

  const active = conflicts.filter((conflict) => conflict.enabled);
  const winner = active.at(-1);
  if (winner) winner.effective = true;

  return conflicts;
}

/**
 * 判断是否有「当前生效」的同名技能冲突。
 *
 * @param conflicts 探测结果
 * @returns 至少一条 `enabled` 时为 `true`
 */
export function hasActiveSkillConflict(conflicts: SkillConflict[]): boolean {
  return conflicts.some((conflict) => conflict.enabled);
}

/**
 * 生成用户改动摘要（字节数 + 首个差异行）。
 *
 * @param localPath 磁盘上的 SKILL.md
 * @param bundledPath 包内 SKILL.md
 * @returns 一句话摘要
 */
export function summarizeSkillMdDiff(localPath: string, bundledPath: string): string {
  try {
    const local = readFileSync(localPath, "utf-8");
    const bundled = readFileSync(bundledPath, "utf-8");
    const localLines = local.replaceAll("\r\n", "\n").split("\n");
    const bundledLines = bundled.replaceAll("\r\n", "\n").split("\n");
    let firstDiff = 0;
    const max = Math.max(localLines.length, bundledLines.length);
    for (let index = 0; index < max; index += 1) {
      if ((localLines[index] ?? "") !== (bundledLines[index] ?? "")) {
        firstDiff = index + 1;
        break;
      }
    }
    const localBytes = Buffer.byteLength(local, "utf-8");
    const bundledBytes = Buffer.byteLength(bundled, "utf-8");
    const where = firstDiff === 0 ? "行内容一致，仅换行/编码不同" : `首个差异在第 ${firstDiff} 行`;
    return `本地 ${localBytes} 字节 / 包内 ${bundledBytes} 字节，${where}`;
  } catch {
    return "无法读取本地或包内 SKILL.md，按本地已改动处理";
  }
}

/**
 * 安装（或预览安装）随包技能。
 *
 * 默认不覆盖本地改过的 `SKILL.md`；`force` 时先备份到状态目录再覆盖。辅助文件
 * （`agents/`、`references/`、`templates/`）始终随包更新（内容一致时跳过写入）。
 *
 * @param options 源目录、技能根、版本、开关与测试覆盖项
 * @returns 安装结果
 * @throws 源目录缺 `SKILL.md`、目标目录是符号链接等不可继续的情况
 */
export function installBundledSkill(options: InstallBundledSkillOptions): SkillInstallResult {
  const sourceDir = resolve(options.sourceDir);
  const home = options.homeDir ?? homedir();
  const skillsRoot = resolve(options.skillsRoot ?? defaultSkillsRoot(home));
  const targetDir = join(skillsRoot, SKILL_NAME);
  const stateDir = join(skillsRoot, STATE_DIR_NAME);
  const stateFile = join(stateDir, STATE_FILE_NAME);
  const packageVersion = options.packageVersion ?? readPackageVersion();
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const bundle = listSkillBundle(sourceDir);
  if (!bundle.hasSkillMd) {
    throw new Error(`随包技能目录缺少 SKILL.md：${toDisplayPath(sourceDir)}`);
  }

  for (const skipped of bundle.skipped) {
    debugLog(`[skill_zh:debug] install 跳过白名单外条目：${skipped}`);
  }

  const oldState = readInstallState(stateFile);
  const previousVersion = oldState?.packageVersion ?? "";
  const bundleSkill = bundle.files.find((file) => file.relativePath === SKILL_MD_FILE);
  const targetSkillPath = join(targetDir, SKILL_MD_FILE);
  const diskSkillHash = trySha256File(targetSkillPath);

  // 用户改动判定：有状态时以「上次安装的包内容哈希」为准；没有状态时退回与当前包比较。
  const recordedSkillHash = oldState?.files[SKILL_MD_FILE];
  const userModified =
    diskSkillHash !== null &&
    (recordedSkillHash !== undefined
      ? diskSkillHash !== recordedSkillHash
      : bundleSkill !== undefined && diskSkillHash !== bundleSkill.sha256);

  const conflicts = detectSkillConflicts({
    name: SKILL_NAME,
    homeDir: home,
    projectDir: options.projectDir,
    projectDirs: options.projectDirs,
    env: options.env,
    excludeDir: targetDir,
  });

  const keepUserSkill = userModified && !force;
  const files: SkillFileResult[] = bundle.files.map((file) => {
    const isSkillMd = file.relativePath === SKILL_MD_FILE;
    if (isSkillMd && keepUserSkill) {
      return { relativePath: file.relativePath, size: file.size, action: "keep-user" };
    }
    const existingHash = trySha256File(join(targetDir, file.relativePath));
    return {
      relativePath: file.relativePath,
      size: file.size,
      action: existingHash === file.sha256 ? "same" : "write",
    };
  });

  const bundlePaths = new Set(bundle.files.map((file) => file.relativePath));
  const removed = pruneStaleFiles(targetDir, oldState, bundlePaths, true);
  const timestamp = (options.now ?? defaultTimestamp)();
  const legacyPlan = planLegacyMetadata(targetDir, stateDir, bundleSkill?.sourcePath, timestamp);
  const cleanedMetadata = legacyPlan.remove;
  const migratedBackups = legacyPlan.migrate;
  const backupPath =
    userModified && force && diskSkillHash !== null && existsSync(targetSkillPath)
      ? uniqueBackupPath(stateDir, `${SKILL_MD_FILE}.bak-${timestamp}`)
      : null;

  const hasWrites = files.some((file) => file.action === "write");
  const needsWork =
    hasWrites ||
    removed.length > 0 ||
    cleanedMetadata.length > 0 ||
    migratedBackups.length > 0 ||
    backupPath !== null ||
    !existsSync(targetSkillPath);
  const changed = needsWork;

  let status: SkillInstallResult["status"];
  if (dryRun) status = "dry-run";
  else if (!changed) status = keepUserSkill ? "kept-user" : "up-to-date";
  else status = previousVersion !== "" && previousVersion !== packageVersion ? "upgraded" : "installed";

  if (!dryRun && changed) {
    ensureSafeDirectory(targetDir);

    // 先备份用户版本，再覆盖：备份失败时宁可不覆盖，也不静默丢掉用户改动。
    if (backupPath !== null) {
      mkdirSync(stateDir, { recursive: true });
      copyFileSync(targetSkillPath, backupPath);
    }

    for (const [index, file] of bundle.files.entries()) {
      if (files[index]?.action !== "write") continue;
      writeBundleFile(targetDir, file);
    }

    for (const name of cleanedMetadata) {
      rmSync(join(targetDir, name), { force: true });
    }

    for (const migration of migratedBackups) {
      mkdirSync(stateDir, { recursive: true });
      try {
        renameSync(migration.from, migration.to);
      } catch {
        copyFileSync(migration.from, migration.to);
        rmSync(migration.from, { force: true });
      }
    }

    for (const rel of removed) {
      rmSync(join(targetDir, rel), { force: true });
    }
    removeEmptyParentDirs(targetDir, removed);
  }

  // 状态文件的属主清单始终记录「随包内容哈希」，所以用户改过 SKILL.md 后会被持续识别为改动，
  // 直到用户恢复原内容或显式 --force。
  const nextFiles: Record<string, string> = {};
  for (const file of bundle.files) nextFiles[file.relativePath] = file.sha256;
  const latestMigration = migratedBackups.at(-1);
  const lastBackup =
    backupPath !== null
      ? relative(stateDir, backupPath).split(sep).join("/")
      : latestMigration !== undefined
        ? relative(stateDir, latestMigration.to).split(sep).join("/")
        : (oldState?.lastBackup ?? null);
  const stateChanged =
    oldState === null ||
    oldState.packageVersion !== packageVersion ||
    !sameFileMap(oldState.files, nextFiles) ||
    oldState.lastBackup !== lastBackup;
  const shouldWriteState = stateChanged || !existsSync(stateFile);

  if (!dryRun && shouldWriteState) {
    writeInstallState(stateFile, {
      schema: 1,
      name: SKILL_NAME,
      packageVersion,
      installedAt: stateChanged ? new Date().toISOString() : (oldState?.installedAt ?? new Date().toISOString()),
      files: nextFiles,
      lastBackup,
    });
  }

  return {
    targetDir,
    stateDir,
    stateFile,
    packageVersion,
    previousVersion,
    userModified,
    changed,
    status,
    files,
    skipped: bundle.skipped,
    conflicts,
    backupPath,
    removed,
    cleanedMetadata,
    migratedBackups,
  };
}

/** 启动自动安装被关闭时使用的环境变量（显式 opt-out）。 */
export const NO_STARTUP_INSTALL_ENV = "SKILL_ZH_NO_STARTUP_INSTALL";

/**
 * 启动安装应被跳过的原因。
 *
 * 两种情形：① 用户显式设置 `SKILL_ZH_NO_STARTUP_INSTALL=1`；② 跑在 `node --test` 下
 * （Node 给测试子进程注入 `NODE_TEST_CONTEXT`），测试不该写真实 HOME。
 *
 * @param env 环境变量（测试用；缺省 `process.env`）
 * @returns 跳过原因；不应跳过时为 `null`
 */
export function startupInstallSkipReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[NO_STARTUP_INSTALL_ENV] === "1") {
    return `已按 ${NO_STARTUP_INSTALL_ENV}=1 关闭启动自动安装`;
  }
  if (env.NODE_TEST_CONTEXT !== undefined) return "测试环境（NODE_TEST_CONTEXT）不写盘";
  return null;
}

/**
 * 是否禁止启动时静默安装（测试 / 用户显式关闭）。
 *
 * @returns 需要跳过时为 `true`
 */
export function isStartupInstallDisabled(): boolean {
  return startupInstallSkipReason() !== null;
}

/** 每个进程只调度一次启动安装。 */
let startupInstallScheduled = false;

/**
 * 插件启动时调度一次静默安装（不阻塞启动）。
 *
 * 只有「无生效冲突 + 目标不存在或版本不同 + 用户未改过 SKILL.md」才真正写盘；
 * 其它情况只记日志。耗时操作放到 `setImmediate`，且整个安装是同步片段。
 *
 * @param hooks 日志与错误回调（便于测试与统一日志出口）
 */
export function scheduleStartupSkillInstall(hooks: {
  logInfo: (message: string) => void;
  logError: (message: string, error: unknown) => void;
}): void {
  if (startupInstallScheduled) return;
  startupInstallScheduled = true;

  // 关闭时必须留下一条日志：用户要能确认「没写盘」是主动关闭而不是安装失败。
  const skipReason = startupInstallSkipReason();
  if (skipReason !== null) {
    hooks.logInfo(`启动安装跳过：${skipReason}`);
    return;
  }

  setImmediate(() => {
    try {
      const sourceDir = resolveBundledSkillDir();
      const skillsRoot = defaultSkillsRoot(homedir());
      const plan = installBundledSkill({ sourceDir, skillsRoot, dryRun: true });

      if (hasActiveSkillConflict(plan.conflicts)) {
        hooks.logInfo(`启动安装跳过：检测到同名技能冲突（${plan.conflicts.filter((item) => item.enabled).length} 处），运行 skill_zh install --dry-run 查看`);
        return;
      }
      if (plan.userModified) {
        hooks.logInfo("启动安装跳过：本地 SKILL.md 有改动，运行 skill_zh install --dry-run 查看");
        return;
      }
      // 启动时只在「目标不存在或版本不同」时动手；同版本缺文件的情况交给用户显式 install。
      const targetExists = existsSync(join(plan.targetDir, SKILL_MD_FILE));
      if (targetExists && plan.previousVersion === plan.packageVersion) {
        hooks.logInfo(`启动安装跳过：已是最新（${plan.packageVersion}）`);
        return;
      }
      if (!plan.changed) {
        hooks.logInfo(`启动安装跳过：没有需要写入的变化（${plan.packageVersion}）`);
        return;
      }

      const result = installBundledSkill({ sourceDir, skillsRoot, force: false });
      hooks.logInfo(`已自动安装技能到 ${toDisplayPath(result.targetDir)}（${result.packageVersion}）`);
    } catch (error) {
      hooks.logError("启动静默安装失败", error);
    }
  }).unref?.();
}

/**
 * 测试辅助：重置「本进程已调度启动安装」标记。
 *
 * 只给单测用；生产路径每个进程只调度一次。
 */
export function resetStartupInstallForTests(): void {
  startupInstallScheduled = false;
}
