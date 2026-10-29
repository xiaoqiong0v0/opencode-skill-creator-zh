/**
 * 触发率评测：检验一组 query 能否让 OpenCode 真正调用（读取）某个技能。
 *
 * 移植自上游 `scripts/run_eval.py`（TypeScript 版基线 `d4383924`）。
 *
 * 用 Node 的 `child_process` 调 `opencode run`：每条 query 都会在 `.opencode/skills/`
 * 下临时创建一个技能，使其出现在 available_skills 列表里；随后扫描输出中是否出现该
 * 临时技能名，据此判定是否触发。
 *
 * 配置文档（`opencode.json` / `opencode.jsonc`）用 `jsonc-parser` 的 `parse` 解析，与
 * 上游一致：注释、尾逗号与字符串里的 `//`、`/*` 都按 JSONC 语法处理，不会被误当成
 * 注释剥掉；解析不出对象时按「无引用」处理，不抛错。
 */

import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import { debugLog } from "./debug.js";
import { buildOpencodeEnv, isFailedProcess, runProcess } from "./process.js";
import type { RunProcessResult } from "./process.js";

/** 合法技能名：小写字母/数字组成的 kebab-case。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 项目可能放在根目录的配置文档；存在几个就镜像几个。 */
const ROOT_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * 镜像时的单文件字节上限（J1）。
 *
 * 符号链接不可用时降级为逐文件拷贝；超过该上限的文件（二进制、数据集、构建产物）
 * 一律跳过，避免把几十 MB 的内容搬进隔离根。
 */
export const MAX_MIRROR_FILE_BYTES = 2 * 1024 * 1024;

/** 技能目录镜像白名单（与安装器共用同一份口径，比较不区分大小写）。 */
const SKILL_MIRROR_WHITELIST = ["SKILL.md", "agents", "references", "templates"] as const;

/** 无论镜像范围如何都跳过的目录名：依赖、构建产物与版本库。 */
const ALWAYS_SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", ".git"]);

/** 镜像范围：`config` 为配置面（逐文件镜像整个条目），`skill` 为技能白名单。 */
type MirrorScope = "config" | "skill";

/**
 * 构造一个 AbortError 形状的错误，使取消能与真正的阴性结果或查询失败区分开。
 * 调用方绝不能把被取消的运行当成一次普通的失败查询。
 *
 * @param message 错误文案
 * @returns `name` 为 `AbortError` 的错误对象
 */
export function abortError(message = "skill evaluation aborted by the caller"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * 判断错误是否表示「调用方取消」。
 *
 * @param error 任意错误值
 * @returns 是 `AbortError`（按 `name` 或 `code === "ABORT_ERR"`）时返回 `true`
 */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || (error as { code?: string }).code === "ABORT_ERR")
  );
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 评测集中的一条 query 及其期望（是否应当触发）。 */
export interface EvalItem {
  query: string;
  should_trigger: boolean;
}

/** 聚合后的单条 query 评测结果。 */
export interface EvalResultItem {
  query: string;
  should_trigger: boolean;
  trigger_rate: number;
  triggers: number;
  runs: number;
  successful_runs: number;
  errors: number;
  pass: boolean;
}

/** 一次完整评测的输出（JSON 字段名保持英文，供下游脚本消费）。 */
export interface EvalOutput {
  skill_name: string;
  description: string;
  results: EvalResultItem[];
  warnings: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    run_errors: number;
    queries_with_errors: number;
  };
  /** 本次评测所有镜像的汇总（条目数 / 字节数 / 跳过数）；未做镜像时缺省。 */
  mirror?: MirrorSummary;
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 所有 should-trigger 条目都 0 触发且无运行错误时给出的提示。 */
const ALL_ZERO_WARNING =
  "All should-trigger queries produced 0 triggers with no run errors. Check that trigger evals are using an agent that exposes skill tool events, such as the build agent.";

/**
 * 构造 `opencode run` 的参数列表。
 *
 * @param query 要执行的 query
 * @param opts 代理与模型（`agent` 缺省为 `build`）
 * @returns 命令与参数数组，可直接交给 `runProcess`
 */
export function buildOpenCodeRunCommand(
  query: string,
  opts: { agent?: string; model?: string },
): string[] {
  const cmd = [
    "opencode",
    "run",
    "--format",
    "json",
    "--agent",
    opts.agent ?? "build",
  ];
  if (opts.model) cmd.push("--model", opts.model);
  cmd.push(query);
  return cmd;
}

/**
 * 根据聚合结果给出评测告警。
 *
 * 全部 should-trigger 查询都是 0 触发且没有运行错误时，通常说明评测所用 agent 不暴露
 * 技能工具事件（例如停了 skill 工具），此时提示换用 build 之类的 agent。
 *
 * @param results 聚合后的逐条结果
 * @returns 告警文案列表（无告警时为空数组）
 */
export function buildEvalWarnings(results: EvalResultItem[]): string[] {
  const shouldTriggerResults = results.filter((r) => r.should_trigger);
  if (shouldTriggerResults.length === 0) return [];

  const allZeroWithoutErrors = shouldTriggerResults.every(
    (r) => r.triggers === 0 && r.errors === 0,
  );
  return allZeroWithoutErrors ? [ALL_ZERO_WARNING] : [];
}

/** 枚举出的一条已安装技能。 */
export interface EnumeratedSkill {
  name: string;
  location?: string;
}

/**
 * 枚举某个项目已安装的技能。
 *
 * 机制不可用时返回 `null`，让调用方明确失败，而不是悄悄跳过冲突守卫。
 */
export type SkillEnumerator = (
  projectRoot: string,
) => Promise<EnumeratedSkill[] | null>;

/**
 * 解析 `opencode debug skill` 的 JSON 输出。
 *
 * @param stdoutText 子进程 stdout 原文
 * @returns 技能列表；不是 JSON 数组（或解析失败）时返回 `null`
 */
function parseCliSkillList(stdoutText: string): EnumeratedSkill[] | null {
  try {
    const parsed = JSON.parse(stdoutText) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== "string") return [];
      return [
        {
          name: record.name,
          location:
            typeof record.location === "string" ? record.location : undefined,
        },
      ];
    });
  } catch {
    return null;
  }
}

/**
 * 在技能列表里找出与被测技能同名的条目所在位置。
 *
 * 由 V1 的 CLI JSON 解析与 V2 的 `ctx.skill.list` 两条路径共用。
 *
 * @param skills 已安装技能列表
 * @param skillName 被测技能的基础名
 * @returns 命中位置列表；位置缺失时为 `"unknown location"`
 */
export function findSkillConflictsInList(
  skills: readonly EnumeratedSkill[],
  skillName: string,
): string[] {
  return skills
    .filter((entry) => entry.name === skillName)
    .map((entry) =>
      typeof entry.location === "string" && entry.location.trim()
        ? entry.location
        : "unknown location",
    );
}

/**
 * 解析 `opencode debug skill` 的输出并找出同名条目位置。
 *
 * @param stdoutText 子进程 stdout 原文
 * @param skillName 被测技能的基础名
 * @returns 命中位置列表；输出不可解析时为空数组
 */
export function findSkillConflicts(
  stdoutText: string,
  skillName: string,
): string[] {
  const skills = parseCliSkillList(stdoutText);
  if (skills === null) return [];
  return findSkillConflictsInList(skills, skillName);
}

/**
 * V1 枚举器：`opencode debug skill` 会打印一个技能 JSON 数组。
 *
 * OpenCode V2 移除了该子命令，因此在那里返回 `null`，由 V2 工具路径改用
 * `ctx.skill.list`。
 *
 * @param projectRoot 项目根目录
 * @returns 技能列表；子进程失败或无法启动时返回 `null`
 */
export const cliInstalledSkillEnumerator: SkillEnumerator = async (
  projectRoot,
) => {
  let result: RunProcessResult;
  try {
    result = await runProcess(["opencode", "debug", "skill"], {
      cwd: projectRoot,
      // 与评测运行同一套环境契约：把 PWD 钉到被检查的项目，避免调用方陈旧的 PWD
      // 把检查指到别处。
      env: buildOpencodeEnv(projectRoot),
      timeoutMs: 10_000,
    });
  } catch {
    return null;
  }

  if (isFailedProcess(result)) return null;
  return parseCliSkillList(result.stdout);
};

/**
 * 用 `ctx.skill.list()` 构造 V2 枚举器。
 *
 * 枚举范围绑定到调用方传入的项目根，因此每个插件实例读的都是自己所在位置的技能。
 * 任何失败都返回 `null`，让冲突守卫明确中止而不是悄悄跳过。
 *
 * @param ctx 含 `skill.list()` 的 OpenCode 上下文
 * @returns 绑定到 `ctx` 的技能枚举器
 */
export function createV2SkillEnumerator(ctx: {
  skill: {
    list(input?: { location?: { directory?: string } }): Promise<unknown>;
  };
}): SkillEnumerator {
  return async (projectRoot: string) => {
    try {
      const output = (await ctx.skill.list({
        location: { directory: projectRoot },
      })) as {
        data?: readonly { name?: unknown; path?: unknown }[];
      };
      if (!output || !Array.isArray(output.data)) return null;
      return output.data.flatMap((entry) => {
        if (!entry || typeof entry.name !== "string") return [];
        return [
          {
            name: entry.name,
            location: typeof entry.path === "string" ? entry.path : undefined,
          },
        ];
      });
    } catch {
      return null;
    }
  };
}

/**
 * opencode 自身的运行时目录与用户配置目录：它们不是项目根。
 *
 * 上游 `findProjectRoot()` 只要向上命中 `.opencode` 就返回，于是在 home 之下调用时会把
 * `~/.opencode`（缓存 / 插件数据 / `skills/`）当成项目根 —— 这正是「镜像了错的项目」
 * 的实证来源（见 `docs/design/技能评测隔离问题.md` 坑 B）。
 *
 * @returns 需要跳过的目录绝对路径列表
 */
function runtimeDirectories(home: string): string[] {
  return [join(home, ".opencode"), join(home, ".config", "opencode")];
}

/**
 * 判断候选目录是否是 opencode 运行时/配置目录（含其内部路径）。
 *
 * 用户主目录本身也一并判为「不是项目根」：`~/.opencode/skills` 是运行时目录里的用户级
 * 技能，把它当项目根会镜像来路不明的技能（这正是坑 B 的实证症状）。
 *
 * @param candidate 候选项目根
 * @returns 命中运行时目录时返回 `true`
 */
function isRuntimeDirectory(candidate: string, home: string): boolean {
  const canonicalCandidate = canonicalizeForExclusion(candidate);
  const canonicalHome = canonicalizeForExclusion(home);
  if (canonicalCandidate === canonicalHome) return true;
  return runtimeDirectories(home).some((runtimeDir) => {
    const canonicalRuntime = canonicalizeForExclusion(runtimeDir);
    return (
      canonicalCandidate === canonicalRuntime ||
      isInsidePath(canonicalRuntime, canonicalCandidate)
    );
  });
}

/**
 * 校验候选目录是否具备「项目形态」：含 `.opencode/skills`、`.claude/skills` 或项目配置文档。
 *
 * 只有 `.opencode/` 而无 `skills`/项目配置的目录不算项目（可能是临时目录或运行时目录
 * 的残留），不能作为镜像来源。
 *
 * @param candidate 候选项目根
 * @returns 具备项目形态时返回 `true`
 */
function hasProjectShape(candidate: string): boolean {
  return (
    existsSync(join(candidate, ".opencode", "skills")) ||
    ROOT_CONFIG_FILES.some((name) => existsSync(join(candidate, name)))
  );
}

/**
 * 独立 CLI 场景的兜底取根：从起点逐级向上找**具备项目形态**的目录。
 *
 * 这是唯一保留「向上查找」的地方，仅供进程里拿不到 `ToolContext` 的独立 CLI 使用；
 * 插件路径（`eval` / `optimize` handler）必须直接用 `DispatchContext.directory` /
 * `worktree`，不得调用本函数（见 `docs/SPEC.md` R6.2-J2）。
 *
 * 加固点：① 跳过 `~/.opencode`、`~/.config/opencode` 等运行时目录；② 命中后校验项目
 * 形态；③ 调试开关下打印实际命中的根与来源。一路不命中时回退起点。
 *
 * @param cwd 起始目录；缺省为 `process.cwd()`（仅本兜底函数允许读进程 cwd）
 * @param homeOverride 用户主目录（测试用；缺省 `os.homedir()`）
 * @returns 命中到的项目根，或回退的起始目录
 */
export function findProjectRoot(cwd?: string, homeOverride?: string): string {
  const start = resolve(cwd ?? process.cwd());
  const home = homeOverride ?? homedir();
  let current = start;
  const { root } = parse(current);

  while (true) {
    // 用户主目录及其上层不是项目根：从 home 下的临时目录调用时，向上会先命中 home
    // （其 .opencode/skills 是运行时目录），这里直接停止，避免把 home 当项目。
    if (canonicalizeForExclusion(current) === canonicalizeForExclusion(home)) break;
    if (hasProjectShape(current) && !isRuntimeDirectory(current, home)) {
      debugLog(`[skill_zh:debug] 项目根（向上命中）：${current}`);
      return current;
    }
    const parent = dirname(current);
    if (parent === current || parent === root) break;
    current = parent;
  }

  debugLog(`[skill_zh:debug] 未命中项目形态，回退当前目录：${start}`);
  return start;
}

// ---------------------------------------------------------------------------
// 镜像清单（J1 / J5）
// ---------------------------------------------------------------------------

/** 镜像条目：相对评测根的路径、类型与字节数。 */
export interface MirrorEntry {
  /** 相对评测根的路径（`/` 分隔）。 */
  path: string;
  /** 条目类型：符号链接 / 普通文件 / 目录。 */
  kind: "symlink" | "file" | "dir";
  /** 文件字节数；符号链接与目录为 0。 */
  bytes: number;
}

/** 被跳过的镜像条目及原因。 */
export interface MirrorSkip {
  /** 相对评测根的路径（`/` 分隔）。 */
  path: string;
  /** 跳过原因（中文，可直接给用户看）。 */
  reason: string;
}

/** 一次镜像的清单（`SKILL_ZH_DEBUG=1` 时逐条打印）。 */
export interface MirrorReport {
  entries: MirrorEntry[];
  skipped: MirrorSkip[];
  totalBytes: number;
}

/** 多次镜像聚合后的汇总（默认只输出这一行）。 */
export interface MirrorSummary {
  /** 条目数。 */
  entries: number;
  /** 文件总字节数。 */
  bytes: number;
  /** 跳过条目数。 */
  skipped: number;
}

/**
 * 隔离根准备失败（镜像或写入 deny 配置）。
 *
 * 这类失败发生在每条 query 的「准备阶段」，与「某条 query 跑挂了」不同：它意味着
 * 隔离环境本身不可信，必须中止整个评测（J7），绝不能计入 `errored` 后继续出报告。
 */
export class IsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationError";
  }
}

/** 镜像过程共享的上下文。 */
interface MirrorContext {
  evalRoot: string;
  report: MirrorReport;
}

/**
 * 新建一份空的镜像清单。
 *
 * @param evalRoot 隔离评测根（用于计算相对路径）
 * @returns 空清单
 */
function createMirrorContext(evalRoot: string): MirrorContext {
  return { evalRoot, report: { entries: [], skipped: [], totalBytes: 0 } };
}

/**
 * 把绝对目标路径折算成相对评测根的 `/` 分隔路径。
 *
 * @param ctx 镜像上下文
 * @param target 目标绝对路径
 * @returns 相对路径
 */
function mirrorRelativePath(ctx: MirrorContext, target: string): string {
  return relative(ctx.evalRoot, target).replaceAll("\\", "/");
}

/**
 * 记一条已镜像条目。
 *
 * @param ctx 镜像上下文
 * @param target 目标绝对路径
 * @param kind 条目类型
 * @param bytes 字节数（非文件传 0）
 */
function recordMirrorEntry(
  ctx: MirrorContext,
  target: string,
  kind: MirrorEntry["kind"],
  bytes: number,
): void {
  ctx.report.entries.push({ path: mirrorRelativePath(ctx, target), kind, bytes });
  if (kind === "file") ctx.report.totalBytes += bytes;
}

/**
 * 记一条跳过条目，并在调试模式下点名原因与大小。
 *
 * @param ctx 镜像上下文
 * @param target 目标绝对路径
 * @param reason 跳过原因
 * @param bytes 文件字节数（未知时为 0）
 */
function recordMirrorSkip(
  ctx: MirrorContext,
  target: string,
  reason: string,
  bytes = 0,
): void {
  const path = mirrorRelativePath(ctx, target);
  ctx.report.skipped.push({ path, reason });
  debugLog(
    `[skill_zh:debug] 跳过镜像 ${path}：${reason}${bytes > 0 ? `（${bytes} 字节）` : ""}`,
  );
}

/**
 * 打印一份镜像清单（仅 `SKILL_ZH_DEBUG=1`；默认由调用方只输出一行汇总）。
 *
 * @param ctx 镜像上下文
 */
function printMirrorReport(ctx: MirrorContext): void {
  for (const entry of ctx.report.entries) {
    debugLog(
      `[skill_zh:debug] 镜像 ${entry.path}（${entry.kind}，${entry.bytes} 字节）`,
    );
  }
  debugLog(
    `[skill_zh:debug] 镜像合计 ${ctx.report.entries.length} 个条目，${ctx.report.totalBytes} 字节，跳过 ${ctx.report.skipped.length} 项`,
  );
}

/**
 * 判断技能目录根层的条目是否在镜像白名单内（比较不区分大小写）。
 *
 * @param name 条目名
 * @returns 在白名单内时返回 `true`
 */
function isSkillWhitelistEntry(name: string): boolean {
  const lower = name.toLowerCase();
  return SKILL_MIRROR_WHITELIST.some((allowed) => allowed.toLowerCase() === lower);
}

/**
 * 降级路径：逐文件拷贝一个条目（**绝不对目录做整目录递归拷贝**，门禁见 SPEC R6.2-J1）。
 *
 * 规则（J1）：
 * - 目录：递归遍历，逐文件拷贝；`node_modules/`、`dist/`、`.git/` 与符号链接条目跳过；
 * - 技能范围（`scope === "skill"`）：根层只放行 `SKILL.md` / `agents` / `references` /
 *   `templates`，其余条目记录跳过原因；
 * - 文件：超过 {@link MAX_MIRROR_FILE_BYTES} 跳过并记录。
 *
 * @param ctx 镜像上下文
 * @param source 源路径
 * @param target 目标路径
 * @param scope 镜像范围
 * @param depth 相对技能根的深度（技能范围用；根层为 0）
 */
function mirrorByFileCopy(
  ctx: MirrorContext,
  source: string,
  target: string,
  scope: MirrorScope,
  depth: number,
): void {
  if (existsSync(target)) return;

  // 入口本身可能是符号链接（例如根配置引用了一个别名）：statSync 会跟随它，把外部
  // 目录/文件整棵拷进来。入口先按 lstat 判定，符号链接一律跳过并记录原因（J1）。
  try {
    if (lstatSync(source).isSymbolicLink()) {
      recordMirrorSkip(ctx, target, "符号链接条目，降级路径不跟随");
      return;
    }
  } catch {
    recordMirrorSkip(ctx, target, "源不存在或不可读");
    return;
  }

  let stats;
  try {
    stats = statSync(source);
  } catch {
    recordMirrorSkip(ctx, target, "源不存在或不可读");
    return;
  }

  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    recordMirrorEntry(ctx, target, "dir", 0);

    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const childSource = join(source, entry.name);
      const childTarget = join(target, entry.name);

      // 符号链接条目在降级路径不跟随：可能是环，也可能把隔离范围外的内容带进来。
      if (entry.isSymbolicLink()) {
        recordMirrorSkip(ctx, childTarget, "符号链接条目，降级路径不跟随");
        continue;
      }
      if (entry.isDirectory() && ALWAYS_SKIPPED_DIRS.has(entry.name)) {
        recordMirrorSkip(ctx, childTarget, "依赖/构建产物/版本库目录，不镜像");
        continue;
      }
      if (scope === "skill" && depth === 0 && !isSkillWhitelistEntry(entry.name)) {
        recordMirrorSkip(
          ctx,
          childTarget,
          "不在技能白名单（SKILL.md / agents / references / templates）",
        );
        continue;
      }
      mirrorByFileCopy(ctx, childSource, childTarget, scope, depth + 1);
    }
    return;
  }

  if (scope === "skill" && depth === 0) {
    recordMirrorSkip(ctx, target, "不在技能白名单（SKILL.md / agents / references / templates）");
    return;
  }
  if (!stats.isFile()) {
    recordMirrorSkip(ctx, target, "不是常规文件");
    return;
  }
  if (stats.size > MAX_MIRROR_FILE_BYTES) {
    recordMirrorSkip(
      ctx,
      target,
      `超过单文件上限 ${MAX_MIRROR_FILE_BYTES} 字节`,
      stats.size,
    );
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  recordMirrorEntry(ctx, target, "file", stats.size);
}

/**
 * 把项目的配置条目镜像进评测根：优先建符号链接（开销小、不拷贝），并显式传 type
 * 让目录链接正确解析。符号链接不可用时（Windows 未开管理员/开发者模式会以 EPERM
 * 拒绝）降级为**逐文件**镜像，绝不做整目录递归拷贝。幂等：目标已存在时原样保留。
 *
 * @param source 源路径（文件或目录）
 * @param target 评测根内的目标路径
 * @param isDirectory 源是否为目录（决定符号链接的 type）
 * @param scope 镜像范围（`config` 配置面 / `skill` 技能白名单）
 * @param ctx 镜像上下文
 */
function linkOrCopyConfigEntry(
  source: string,
  target: string,
  isDirectory: boolean,
  scope: MirrorScope,
  ctx: MirrorContext,
): void {
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  try {
    symlinkSync(source, target, isDirectory ? "dir" : "file");
    recordMirrorEntry(ctx, target, "symlink", 0);
  } catch {
    if (!existsSync(target)) mirrorByFileCopy(ctx, source, target, scope, 0);
  }
}

/**
 * 判断 `child` 是否严格位于 `parent` 之内（不接受前缀相似的兄弟名）。
 *
 * @param parent 父目录
 * @param child 待判定的路径
 * @returns 严格位于其内返回 `true`；相等或越界返回 `false`
 */
function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "" || isAbsolute(rel)) return false;
  // 只拒绝真正的越界（`..` 本身或 `..` 之下的段）。单纯 startsWith("..") 会误杀
  // `..notes.md` 这类合法文件名。
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * 为技能排除守卫规范化路径：解析符号链接，使 `alias-skills -> .opencode/skills`
 * 这类别名无法靠纯词法比较把真实技能偷渡回隔离的评测根。
 *
 * `isInsidePath` 只比较路径字符串，因此会被别名骗过。
 *
 * @param path 待规范化的路径
 * @returns 解析后的真实路径；解析失败（如路径不存在）时返回绝对路径形式
 */
function canonicalizeForExclusion(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * 判断 `absolute` 是否就是规范的 `.opencode/skills` 目录本身，或位于其内部。
 *
 * realpath 失败时仍按词法形式再判一次，因此守卫失败时是「关闭」的（被禁止的路径
 * 依然被排除），而不是放行。
 *
 * @param skillsRoot 项目的 `.opencode/skills` 目录
 * @param absolute 待判定的绝对路径
 * @returns 命中（或无法判定）时返回 `true`
 */
function referencesSkillsRoot(skillsRoot: string, absolute: string): boolean {
  const canonicalRoot = canonicalizeForExclusion(skillsRoot);
  const canonicalAbsolute = canonicalizeForExclusion(absolute);
  if (
    canonicalAbsolute === canonicalRoot ||
    isInsidePath(canonicalRoot, canonicalAbsolute)
  ) {
    return true;
  }
  return absolute === skillsRoot || isInsidePath(skillsRoot, absolute);
}

/**
 * 判断 `absolute` 是否就是被测技能自己的目录、或其后代（按规范化路径比较，别名/
 * 符号链接绕不过去）。
 *
 * `excludedSkillPath` 是本次评测的候选技能：它的原始 `SKILL.md` 绝不能进入隔离的
 * 评测根，否则完整正文会泄漏进「只看 description」的评测。未传 -> 不做额外排除
 * （向后兼容）。
 *
 * @param excludedSkillPath 被测技能目录；`undefined` 表示不排除
 * @param absolute 待判定的绝对路径
 * @returns 相等或位于其内时返回 `true`
 */
function isWithinExcludedSkill(
  excludedSkillPath: string | undefined,
  absolute: string,
): boolean {
  if (!excludedSkillPath) return false;
  const canonicalExcluded = canonicalizeForExclusion(excludedSkillPath);
  const canonicalAbsolute = canonicalizeForExclusion(absolute);
  return (
    canonicalAbsolute === canonicalExcluded ||
    isInsidePath(canonicalExcluded, canonicalAbsolute)
  );
}

/**
 * 判断 `absolute` 是否是被测技能目录的祖先（按规范化路径比较）。
 *
 * 镜像这样的引用会把整个父目录（含被测技能）拷进评测根，把候选的正文又带回去。
 * 调用方必须用准确的诊断拒绝它，而不是照抄父目录树。
 *
 * @param excludedSkillPath 被测技能目录；`undefined` 表示不排除
 * @param absolute 待判定的绝对路径
 * @returns 是其祖先时返回 `true`
 */
function isAncestorOfExcludedSkill(
  excludedSkillPath: string | undefined,
  absolute: string,
): boolean {
  if (!excludedSkillPath) return false;
  const canonicalExcluded = canonicalizeForExclusion(excludedSkillPath);
  const canonicalAbsolute = canonicalizeForExclusion(absolute);
  return isInsidePath(canonicalAbsolute, canonicalExcluded);
}

/**
 * 收集根配置文档引用的本地路径（`instructions` 条目与 `{file:...}` 替换）。
 *
 * 每个条目原样返回，调用方据此区分字面路径与 glob；绝对路径、URL 与 `~` 开头的
 * 路径都不属于项目本地，直接跳过。
 *
 * @param projectRoot 项目根目录
 * @param configFileName 根配置文档文件名
 * @returns 项目相对的引用路径列表
 */
function collectRelativeConfigRefs(projectRoot: string, configFileName: string): string[] {
  const text = readFileSync(join(projectRoot, configFileName), "utf-8");
  const data = parseJsonc(text) as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return [];

  const referenced: string[] = [];
  const pushLocal = (value: unknown): void => {
    if (typeof value !== "string" || !value) return;
    // `{file:...}` 是替换包装而不是路径，下面 `fromFiles` 会且只会把它规范化成内部
    // 路径一次；若在这里把原始包装喂给 glob 判定，就会为一个受支持的引用误报
    // 「brace alternation ... not supported」。
    if (/^\{file:.+\}$/.test(value)) return;
    if (value.startsWith("/") || value.startsWith("~") || value.includes("://")) return;
    referenced.push(value);
  };

  if (Array.isArray(data.instructions)) data.instructions.forEach(pushLocal);

  const fromFiles = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^\{file:(.+)\}$/.exec(value);
      if (match) pushLocal(match[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(fromFiles);
    else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(fromFiles);
    }
  };
  fromFiles(data);

  return referenced;
}

/**
 * 用 Node fs 展开 glob 模式，返回项目相对匹配项；只用 `node >=18` 上保证存在的 API。
 *
 * 故意不用 `fs.globSync`：它只在 Node 22+ 存在，导入会让插件在 Node 18/20 上任何
 * 工具跑起来之前就崩。
 *
 * 支持的语法：字面目录、`*`、`?`、`[...]`/`[!...]` 字符类；每个段都停在单层目录。
 * 该子集之外 —— `**` 递归、`..` 父目录引用、brace 交替 —— 一律在 stderr 报出并展开
 * 为空，因此重要的配置引用绝不会被悄悄丢掉。
 *
 * @param projectRoot 项目根目录
 * @param pattern 项目相对的 glob 模式
 * @returns 匹配到的项目相对路径列表
 */
function expandConfigGlob(projectRoot: string, pattern: string): string[] {
  const segments = pattern.split("/").filter((part) => part !== "" && part !== ".");
  if (segments.some((segment) => segment === "..")) {
    // 越出项目根的引用无法镜像成兄弟节点。报出来，而不是悄悄丢掉被引用的文件。
    console.error(
      `skill_eval: instruction pattern "${pattern}" references a parent directory (".."), which the isolated eval-root mirror cannot mirror; move the reference inside the project if eval runs must see it.`,
    );
    return [];
  }
  if (segments.some((segment) => segment.includes("{") || segment.includes("}"))) {
    console.error(
      `skill_eval: instruction pattern "${pattern}" uses brace alternation, which the isolated eval-root mirror does not support; list one explicit file or glob per entry such as "dir/a.md", "dir/b.md", or "dir/*.md".`,
    );
    return [];
  }
  if (segments.some((segment) => segment.includes("**"))) {
    console.error(
      `skill_eval: instruction pattern "${pattern}" uses "**" recursion, which the isolated eval-root mirror does not support; list explicit files or a single-directory glob such as "dir/*.md".`,
    );
    return [];
  }

  let bases: string[] = [""];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const next: string[] = [];
    const hasGlob = /[*?[]/.test(segment);
    for (const base of bases) {
      const dirAbsolute = base ? join(projectRoot, base) : projectRoot;
      if (!existsSync(dirAbsolute)) continue;
      let entries: string[];
      try {
        entries = readdirSync(dirAbsolute);
      } catch {
        continue;
      }
      let matcher: RegExp | null;
      if (hasGlob) {
        try {
          matcher = globSegmentToRegExp(segment);
        } catch (error) {
          // 畸形 glob（如 `[z-a]`、未闭合的 `[`）不能抛出镜像流程，也不能悄悄展开为空。
          console.error(
            `skill_eval: instruction pattern "${pattern}" contains an unsupported or malformed glob segment "${segment}" (${error instanceof Error ? error.message : String(error)}); the reference is not mirrored into the isolated eval root.`,
          );
          return [];
        }
      } else {
        matcher = null;
      }
      for (const entry of entries) {
        if (matcher ? !matcher.test(entry) : entry !== segment) continue;
        const childRelative = base ? `${base}/${entry}` : entry;
        const childAbsolute = join(projectRoot, childRelative);
        // 中间段必须是目录；**最后一段**的匹配结果可以是文件也可以是目录（最后一段
        // 命名的目录按目录链接镜像）。这里比较的是位置而不是段值：`a/a/*.md` 这类
        // 重复目录名，最后一段与更早的一段取值相同。
        if (index !== segments.length - 1) {
          try {
            if (!statSync(childAbsolute).isDirectory()) continue;
          } catch {
            continue;
          }
          next.push(childRelative);
        } else {
          next.push(childRelative);
        }
      }
    }
    bases = next;
    if (bases.length === 0) break;
  }
  return bases;
}

/**
 * 把单个 glob 路径段（`a*b?c[de]`）编译成完全锚定的 RegExp。
 *
 * 返回的模式始终覆盖整段（`^...$`），绝不部分匹配。畸形的字符类会抛出，由调用方
 * 报出。
 *
 * @param segment 单个路径段
 * @returns 锚定到整段的匹配器
 * @throws 字符类未闭合或不合法时抛出错误
 */
function globSegmentToRegExp(segment: string): RegExp {
  let out = "^";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close === -1) {
        throw new Error("unterminated character class (missing ']')");
      }
      let body = segment.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      try {
        // 先试编译字符类，让 `[z-a]` 这类畸形范围被明确报出，而不是抛出不透明的
        // RegExp 错误。
        void new RegExp(`[${body}]`);
      } catch {
        throw new Error(`unsupported character class "[${body}]"`);
      }
      out += `[${body}]`;
      // 跳过整个字符类；范围探测已经校验过它的内容。
      i = close;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * 把一条 instruction/引用条目展开成具体的项目相对文件。
 *
 * glob 模式用上面的本地匹配器展开；字面路径原样使用。解析到项目根之外的路径会被
 * 报出并跳过，而不是悄悄丢弃。
 *
 * @param projectRoot 项目根目录
 * @param reference 配置里的引用条目
 * @returns 存在的引用文件绝对路径列表
 */
function expandConfigReference(projectRoot: string, reference: string): string[] {
  const hasGlob = /[*?[\]{}]/.test(reference);
  let matches: string[];
  if (hasGlob) {
    matches = expandConfigGlob(projectRoot, reference);
  } else {
    matches = [reference];
  }

  const resolved: string[] = [];
  for (const match of matches) {
    const absolute = resolve(projectRoot, match);
    if (!isInsidePath(projectRoot, absolute)) {
      // 例如 `../shared/rules.md` —— 无法在不越出评测根的前提下镜像成兄弟节点。
      // 报出来，而不是悄悄丢掉。
      console.error(
        `skill_eval: instruction reference "${reference}" resolves outside the project root and is not mirrored into the isolated eval root; move it inside the project if eval runs must see it.`,
      );
      continue;
    }
    if (existsSync(absolute)) resolved.push(absolute);
  }
  return resolved;
}

/**
 * 把项目根目录的配置文档镜像进评测根，并把它们引用的相对 `instructions`/`{file:...}`
 * 文件一并带过去。
 *
 * OpenCode 以配置文档所在目录为基准解析这些相对路径，因此只把文档拷进评测根是不够
 * 的：被引用的兄弟文件不跟过去，路径就会悄悄指向那里不存在的文件，指令随之丢失。
 *
 * 安全边界：被测技能以及 `.opencode/skills` 下的一切永不镜像 —— 指向该目录的引用
 * 不允许把真实技能重新带回隔离根。
 *
 * @param projectRoot 项目根目录
 * @param evalRoot 隔离的评测根
 * @param excludedSkillPath 被测技能目录（可选）
 */
function mirrorRootConfigDocuments(
  projectRoot: string,
  evalRoot: string,
  excludedSkillPath: string | undefined,
  ctx: MirrorContext,
): void {
  const skillsRoot = join(projectRoot, ".opencode", "skills");

  for (const name of ROOT_CONFIG_FILES) {
    const source = join(projectRoot, name);
    if (!existsSync(source)) continue;
    linkOrCopyConfigEntry(source, join(evalRoot, name), false, "config", ctx);

    for (const reference of collectRelativeConfigRefs(projectRoot, name)) {
      for (const absolute of expandConfigReference(projectRoot, reference)) {
        // 绝不把被测技能或项目技能目录下的任何东西带回隔离的评测根。按规范化路径
        // 比较，因此指向 `.opencode/skills` 的别名也能拦住。
        if (referencesSkillsRoot(skillsRoot, absolute)) continue;
        // 同样排除被测候选自己的目录（无论它在哪），避免根配置引用泄漏它的完整
        // 原始正文。指向候选**祖先**的引用会拷整个父目录（把候选带回来），要用准确
        // 的告警拒绝。
        if (isWithinExcludedSkill(excludedSkillPath, absolute)) continue;
        if (isAncestorOfExcludedSkill(excludedSkillPath, absolute)) {
          console.error(
            `skill_eval: instruction reference "${reference}" resolves to a directory containing the tested skill; the isolated eval-root mirror refuses to copy that parent tree (it would reintroduce the skill under test). Reference the specific file instead.`,
          );
          continue;
        }
        const relativeTarget = relative(projectRoot, absolute);
        const target = join(evalRoot, relativeTarget);
        if (!isInsidePath(evalRoot, target)) continue;
        linkOrCopyConfigEntry(absolute, target, statSync(absolute).isDirectory(), "config", ctx);
      }
    }
  }
}

/**
 * 把项目的 `.opencode/` 配置（排除 skills）与根配置文档镜像进隔离的评测根。
 *
 * @param projectRoot 项目根目录
 * @param evalRoot 隔离的评测根
 * @param skillName 被测技能的基础名（默认候选目录为 `.opencode/skills/<skillName>`）
 * @param excludedSkillPath 被测技能目录（可选）
 * @returns 本次镜像的清单（条目、大小、跳过原因）
 */
export function symlinkProjectOpenCodeConfig(
  projectRoot: string,
  evalRoot: string,
  skillName: string,
  excludedSkillPath?: string,
): MirrorReport {
  const ctx = createMirrorContext(evalRoot);
  // 先镜像项目的 `.opencode/` 配置（排除 skills），再处理根配置文档及其引用文件。
  // 顺序如此，指向 `.opencode/` 的根引用才会是幂等的空操作，而不是冲突。
  const sourceOpenCode = join(projectRoot, ".opencode");
  if (existsSync(sourceOpenCode)) {
    const targetOpenCode = join(evalRoot, ".opencode");
    mkdirSync(targetOpenCode, { recursive: true });

    const sourceSkillsRoot = join(sourceOpenCode, "skills");
    for (const entry of readdirSync(sourceOpenCode, { withFileTypes: true })) {
      if (entry.name === "skills") continue;
      const entryPath = join(sourceOpenCode, entry.name);
      // 指向 `.opencode/skills` 的别名（符号链接）条目 —— 或指向被测候选目录的条目
      // —— 否则会把被测技能换个名字镜像进来。按规范化路径比较。
      if (referencesSkillsRoot(sourceSkillsRoot, entryPath)) continue;
      if (isWithinExcludedSkill(excludedSkillPath, entryPath)) continue;
      if (isAncestorOfExcludedSkill(excludedSkillPath, entryPath)) continue;
      linkOrCopyConfigEntry(entryPath, join(targetOpenCode, entry.name), entry.isDirectory(), "config", ctx);
    }

    const sourceSkills = join(sourceOpenCode, "skills");
    if (existsSync(sourceSkills)) {
      const targetSkills = join(targetOpenCode, "skills");
      mkdirSync(targetSkills, { recursive: true });
      const canonicalSkillsRoot = canonicalizeForExclusion(sourceSkills);
      // 候选专属排除：被测技能自己的目录（无论它在哪；默认
      // `.opencode/skills/<skillName>`）。这样即使没显式传路径，也保留原有的别名
      // 安全性。
      const candidatePath = excludedSkillPath ?? join(sourceSkills, skillName);
      for (const entry of readdirSync(sourceSkills, { withFileTypes: true })) {
        if (entry.name === skillName) continue;
        const entryPath = join(sourceSkills, entry.name);
        const canonicalEntry = canonicalizeForExclusion(entryPath);
        // 指向整个 skills 根的别名（`.opencode/skills/alias -> .opencode/skills`）会把
        // 每个技能都带回来，包括被测技能。根的后代是合法兄弟技能，**仍须**镜像。
        if (canonicalEntry === canonicalSkillsRoot) continue;
        // 指向被测候选的别名（在 `.opencode/skills` 内，或 —— 给了显式路径时 ——
        // 在 `.opencode` 之外）不得带回候选正文。只做相等/后代判断，绝不排除兄弟。
        if (isWithinExcludedSkill(candidatePath, entryPath)) continue;
        // 父级/祖先别名（`.opencode/skills/alias -> <包含候选的目录>`）会拷贝整个子树
        // 并把候选带回来。拒绝它；正常兄弟永远不会是候选的祖先，因此合法兄弟照旧
        // 镜像。
        if (isAncestorOfExcludedSkill(candidatePath, entryPath)) continue;
        linkOrCopyConfigEntry(entryPath, join(targetSkills, entry.name), entry.isDirectory(), "skill", ctx);
      }
    }
  }

  // 根配置文档（及其引用的相对文件）镜像到相同的相对位置。OpenCode 以配置文档所在
  // 目录解析 `instructions` 与 `{file:...}` 引用，因此只有相对兄弟文件一起过来，
  // 文档才真正生效。
  mirrorRootConfigDocuments(projectRoot, evalRoot, excludedSkillPath, ctx);
  printMirrorReport(ctx);
  return ctx.report;
}

/**
 * 对 `opencode run` 跑一条 query，返回临时技能名是否出现在输出里。
 *
 * 每次运行都有自己的临时 OpenCode 项目根，避免并行 worker 互相看到对方合成的技能、
 * 从而在兄弟合成技能被选中时误判为阴性。
 *
 * @param query 要执行的 query
 * @param skillName 被测技能的基础名（用于拼合成技能名）
 * @param skillDescription 被测技能的描述（写入合成技能）
 * @param timeout 单次运行超时（秒）
 * @param projectRoot 被被测项目根目录
 * @param agent 传给 `opencode run` 的 agent
 * @param triggerOnly 见到触发即提前结束该条运行
 * @param model 可选的模型
 * @param signal 调用方的取消信号
 * @param excludedSkillPath 被测技能目录（不镜像进临时根）
 * @param deniedSkillNames 本次评测要在隔离根里 deny 的同名技能（J6）
 * @param onMirror 镜像清单回调（用于汇总「镜像了多少条目」，J5）
 * @returns 是否触发
 * @throws 技能名不合法、被取消、或子进程失败时抛错
 */
async function runSingleQuery(
  query: string,
  skillName: string,
  skillDescription: string,
  timeout: number,
  projectRoot: string,
  agent: string,
  triggerOnly: boolean,
  model?: string,
  signal?: AbortSignal,
  excludedSkillPath?: string,
  deniedSkillNames: readonly string[] = [],
  onMirror?: (report: MirrorReport) => void,
): Promise<boolean> {
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new Error(
      `Invalid skill name "${skillName}". Expected kebab-case (lowercase letters, numbers, and hyphens only).`,
    );
  }

  const uniqueId = randomBytes(4).toString("hex");
  const cleanName = `${skillName}-skill-${uniqueId}`;
  // 调用前已取消：不 spawn、也不建临时根。
  if (signal?.aborted) throw abortError();
  const evalRoot = mkdtempSync(join(osTmpdir(), "opencode-skill-eval-"));
  const skillsDir = join(evalRoot, ".opencode", "skills", cleanName);
  const skillFile = join(skillsDir, "SKILL.md");

  try {
    let mirror;
    try {
      mirror = symlinkProjectOpenCodeConfig(
        projectRoot,
        evalRoot,
        skillName,
        excludedSkillPath,
      );
      // J6：在隔离根的配置里写 permission.skill.<基础名> = "deny"，屏蔽全局同名技能。
      // 只写隔离根，绝不碰用户的任何目录（配置若是指向源文件的符号链接，会先摘链）。
      applySkillDeny(evalRoot, deniedSkillNames);
    } catch (error) {
      // 隔离根准备失败是「整轮不可信」，不能让 worker 当成单条 query 的错误吞掉（J7）。
      throw new IsolationError(
        `隔离根准备失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    onMirror?.(mirror);
    mkdirSync(skillsDir, { recursive: true });

    // 用 YAML 块标量，避免描述里的引号把 frontmatter 写坏。
    const indentedDesc = skillDescription.split("\n").join("\n  ");
    const skillContent = [
      "---",
      `name: ${cleanName}`,
      "description: |",
      `  ${indentedDesc}`,
      "---",
      "",
      `# ${skillName}`,
      "",
      `This skill handles: ${skillDescription}`,
      "",
    ].join("\n");
    writeFileSync(skillFile, skillContent);

    const cmd = buildOpenCodeRunCommand(query, { agent, model });

    // 带超时地收集输出，并从 JSON 事件里判定技能是否被调用。
    let buffer = "";
    let triggered = false;
    const maxStderrChars = 64 * 1024;
    const timeoutMs = timeout * 1000;

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (event.type !== "tool_use") return;

        const part = event.part as Record<string, unknown> | undefined;
        if (!part || typeof part !== "object") return;

        const toolName = typeof part.tool === "string" ? part.tool : "";
        if (toolName !== "skill" && toolName !== "read") return;

        const serialized = JSON.stringify(part);
        if (serialized.includes(cleanName)) {
          triggered = true;
        }
      } catch {
        // 忽略非 JSON 行与畸形事件。
      }
    };

    const flushBuffer = (final = false): void => {
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(line);
        newlineIndex = buffer.indexOf("\n");
      }

      if (final && buffer.trim()) {
        consumeLine(buffer);
        buffer = "";
      }
    };

    const result = await runProcess(cmd, {
      cwd: evalRoot,
      // opencode 从 $PWD（而不是 spawn 的 cwd）解析项目根，进而解析项目级技能。泄漏
      // 调用方的 PWD 会让这层嵌套运行加载到被测的**真实**项目技能（基础名），于是
      // 它的触发被算到那个技能头上 —— 一个假的 0。把 PWD 钉到 evalRoot，作用域里
      // 就只剩合成技能（以及全局技能）。
      env: buildOpencodeEnv(evalRoot),
      timeoutMs,
      maxStderrChars,
      signal,
      onStdoutChunk(chunk: string) {
        buffer += chunk;
        flushBuffer();
        return triggerOnly && triggered;
      },
    });

    flushBuffer(true);

    // 被取消的运行不是阴性结果。抛错，使它绝不会被计成通过/失败的评测结论。
    if (result.aborted || signal?.aborted) {
      throw abortError();
    }

    if (triggered && triggerOnly) {
      return true;
    }

    if (isFailedProcess(result)) {
      const cleanedStderr = result.stderr.trim();
      throw new Error(
        cleanedStderr
          ? `opencode run exited ${result.exitCode}: ${cleanedStderr}`
          : `opencode run exited ${result.exitCode}`,
      );
    }

    return triggered;
  } finally {
    // J4：正常结束 / 抛错 / 取消三条路径都清理隔离根；清理失败不得掩盖原始错误。
    try {
      if (existsSync(evalRoot)) {
        rmSync(evalRoot, { recursive: true, force: true });
      }
    } catch (error) {
      debugLog(
        `[skill_zh:debug] 隔离根清理失败：${evalRoot}（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 同名技能自动屏蔽（J6 / J7 / J8）
// ---------------------------------------------------------------------------

/**
 * 评测因同名技能无法安全处理而中止时抛出的错误。
 *
 * `locations` 保存冲突技能的**实际路径**，供 CLI 组装「改法：移走或改名 <路径> …」。
 */
export class ShadowGuardError extends Error {
  /** 冲突技能的实际路径列表（枚举不可用时为空）。 */
  readonly locations: string[];

  /**
   * @param message 一句话说明为什么不能继续评测
   * @param locations 冲突技能的实际路径
   */
  constructor(message: string, locations: string[] = []) {
    super(message);
    this.name = "ShadowGuardError";
    this.locations = locations;
  }
}

/**
 * 构造「检测到同名技能」的中文说明（J8：关闭自动屏蔽时直接中止）。
 *
 * @param skillName 被测技能的基础名
 * @param locations 同名技能的实际路径
 * @returns 冲突说明
 */
export function shadowConflictMessage(skillName: string, locations: string[]): string {
  return `检测到同名技能 "${skillName}" 已安装：${locations.join("、")}`;
}

/**
 * 构造「无法枚举可见技能」的中文说明。
 *
 * @param skillName 被测技能的基础名
 * @returns 中止说明
 */
export function shadowEnumerationUnavailableMessage(skillName: string): string {
  return `无法枚举项目里可见的技能，不能确认同名技能 "${skillName}" 是否已安装`;
}

/**
 * 构造「无法写入 deny 配置」的中文说明。
 *
 * @param skillName 被测技能的基础名
 * @param reason 底层失败原因
 * @returns 中止说明
 */
export function shadowDenyWriteFailedMessage(skillName: string, reason: string): string {
  return `无法在隔离根写入同名技能屏蔽配置（permission.skill.${skillName} = "deny"）：${reason}`;
}

/** 隔离根里可能承载项目配置的文件名（JSONC 优先）。 */
const OPENCODE_CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

/**
 * 把 `permission.skill.<name> = "deny"` 合并进隔离根的 `.opencode` 配置文档。
 *
 * 约束（J6）：
 * - 只写隔离根，**不碰用户任何目录**；目标若是符号链接（指向源项目的真实配置），
 *   先摘下链接再写，避免写穿到用户文件；
 * - **用项目实际存在的配置文件**（`opencode.jsonc` 优先，都没有则新建 `opencode.json`），
 *   避免项目用 jsonc 时 deny 写进另一份文件；
 * - 已有配置（JSONC）先读入再合并，保留其它 `permission` 键；
 * - 写入失败直接抛错，由调用方按 J7 中止（不静默放行）。
 *
 * @param evalRoot 隔离的评测根
 * @param deniedSkillNames 需要 deny 的技能基础名列表（空列表直接返回）
 * @throws 读取/写入配置失败时抛出底层错误
 */
export function applySkillDeny(evalRoot: string, deniedSkillNames: readonly string[]): void {
  if (deniedSkillNames.length === 0) return;

  const configDir = join(evalRoot, ".opencode");
  const existingName = OPENCODE_CONFIG_NAMES.find((name) =>
    existsSync(join(configDir, name)),
  );
  const target = join(configDir, existingName ?? "opencode.json");
  let existing: Record<string, unknown> = {};

  if (existsSync(target)) {
    const content = readFileSync(target, "utf-8");
    const parsed = parseJsonc(content) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
    // 符号链接指向用户项目的真实配置：摘下链接，后续只写隔离根内的副本。
    if (lstatSync(target).isSymbolicLink()) unlinkSync(target);
  }

  const permission =
    existing.permission && typeof existing.permission === "object" && !Array.isArray(existing.permission)
      ? ({ ...(existing.permission as Record<string, unknown>) })
      : {};
  const skillPermission =
    permission.skill && typeof permission.skill === "object" && !Array.isArray(permission.skill)
      ? ({ ...(permission.skill as Record<string, unknown>) })
      : {};
  for (const name of deniedSkillNames) skillPermission[name] = "deny";

  existing.permission = { ...permission, skill: skillPermission };
  mkdirSync(configDir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
}

/**
 * 在实际开跑前验证 deny 配置能写进隔离根（J7：写不进就不进入执行阶段）。
 *
 * 用一个临时探针根做一次镜像 + deny 写入，随后立即删除；探针根里的配置与用户目录
 * 没有任何写入关系（符号链接也会被摘掉）。
 *
 * @param projectRoot 项目根目录
 * @param skillName 被测技能的基础名
 * @param excludedSkillPath 被测技能目录
 * @param deniedSkillNames 需要 deny 的技能名
 * @throws 镜像或写入失败时抛出底层错误
 */
function preflightSkillDeny(
  projectRoot: string,
  skillName: string,
  excludedSkillPath: string | undefined,
  deniedSkillNames: readonly string[],
): void {
  const probeRoot = mkdtempSync(join(osTmpdir(), "opencode-skill-eval-probe-"));
  try {
    symlinkProjectOpenCodeConfig(projectRoot, probeRoot, skillName, excludedSkillPath);
    applySkillDeny(probeRoot, deniedSkillNames);
  } finally {
    try {
      rmSync(probeRoot, { recursive: true, force: true });
    } catch (error) {
      debugLog(
        `[skill_zh:debug] 探针根清理失败：${probeRoot}（${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
  }
}

/**
 * 决定本次评测如何处理同名技能，并返回要写进隔离根的 deny 名单。
 *
 * - 自动屏蔽开（默认）：枚举同名技能；命中则预检 deny 可写，返回 `[skillName]`；
 * - 自动屏蔽关（`--no-shadow-guard`）：命中即抛 {@link ShadowGuardError}（老行为）；
 * - 枚举不可用：一律抛 {@link ShadowGuardError}，绝不静默跳过冲突守卫。
 *
 * @param opts 被测技能名、项目根、被测技能目录、开关与枚举器
 * @returns 需要 deny 的技能名列表（无冲突时为空）
 * @throws 枚举不可用、命中同名且关闭屏蔽、或 deny 预检失败时抛错
 */
async function resolveShadowGuard(opts: {
  skillName: string;
  projectRoot: string;
  excludedSkillPath?: string;
  shadowGuard: boolean;
  enumerate: SkillEnumerator;
}): Promise<string[]> {
  const skills = await opts.enumerate(opts.projectRoot);
  if (skills === null) {
    throw new ShadowGuardError(shadowEnumerationUnavailableMessage(opts.skillName));
  }

  const locations = findSkillConflictsInList(skills, opts.skillName);
  if (locations.length === 0) return [];

  if (!opts.shadowGuard) {
    throw new ShadowGuardError(
      shadowConflictMessage(opts.skillName, locations),
      locations,
    );
  }

  try {
    preflightSkillDeny(
      opts.projectRoot,
      opts.skillName,
      opts.excludedSkillPath,
      [opts.skillName],
    );
  } catch (error) {
    throw new ShadowGuardError(
      shadowDenyWriteFailedMessage(
        opts.skillName,
        error instanceof Error ? error.message : String(error),
      ),
      locations,
    );
  }

  debugLog(
    `[skill_zh:debug] 已在本轮评测中屏蔽同名技能：${locations.join("、")}`,
  );
  return [opts.skillName];
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** `runEval` 的可选项。 */
export interface RunEvalOptions {
  evalSet: EvalItem[];
  skillName: string;
  description: string;
  numWorkers: number;
  timeout: number;
  projectRoot: string;
  runsPerQuery?: number;
  triggerThreshold?: number;
  triggerOnly?: boolean;
  model?: string;
  agent?: string;
  /**
   * 调用方持有的取消信号。abort 之后队列中的任务不再启动，在飞的子进程被杀掉，
   * 返回的 promise 以 `AbortError` reject —— 取消绝不会被误当成正常的阴性结果
   * （`run_errors: 0`）。
   */
  signal?: AbortSignal;
  /**
   * 被测技能自己的目录（本次评测的候选）。它的原始 `SKILL.md` 绝不能镜像进隔离的
   * 评测根，因此指向它（或指向会把它拷过来的祖先目录）的根配置
   * `instructions`/`{file:...}` 引用会被排除。未传 -> 不做额外排除。
   */
  excludedSkillPath?: string;
  /**
   * 是否自动屏蔽同名技能（默认 `true`，对应 J6；`false` 对应 `--no-shadow-guard` 的
   * 老行为：检测到同名即中止）。
   */
  shadowGuard?: boolean;
  /** 可见技能枚举器；缺省走 `opencode debug skill`（V1），V2 场景由调用方注入。 */
  skillEnumerator?: SkillEnumerator;
  /** 每次镜像后的清单回调（用于输出「镜像了多少条目」的汇总，J5）。 */
  onMirror?: (report: MirrorReport) => void;
}

/**
 * 一次完成的 query 运行，带上它所属的评测集条目。
 *
 * `itemIndex` 是稳定的聚合键：它能扛住重复的 query 文本与乱序完成，因此两条恰好共用
 * 同一个 query 字符串的评测集条目永远不会被合并成一条结果。
 */
export interface EvalJobResult {
  itemIndex: number;
  triggered: boolean;
  errored: boolean;
}

/**
 * 把逐次运行的结果聚合成「每条评测集条目一条结果」。
 *
 * 按评测集数组下标分组，绝不按 query 字符串：重复 query 保持独立，其运行次数与
 * 通过/失败不会被混在一起。结果按评测集顺序返回，`runLoop` 据此按位置切分训练/测试
 * 集。评分逻辑（分母、单条错误数、阈值）与之前按 query 分组的版本一致 —— 只有分组键
 * 变了。
 *
 * @param evalSet 评测集
 * @param jobResults 逐次运行结果
 * @param triggerThreshold 触发率阈值（含）
 * @returns 与评测集条目同序的结果列表
 */
export function aggregateEvalResults(
  evalSet: EvalItem[],
  jobResults: EvalJobResult[],
  triggerThreshold: number,
): EvalResultItem[] {
  const byItem = new Map<number, { triggers: boolean[]; errors: number }>();
  for (const jr of jobResults) {
    let bucket = byItem.get(jr.itemIndex);
    if (!bucket) {
      bucket = { triggers: [], errors: 0 };
      byItem.set(jr.itemIndex, bucket);
    }
    bucket.triggers.push(jr.triggered);
    if (jr.errored) bucket.errors += 1;
  }

  const results: EvalResultItem[] = [];
  for (const [itemIndex, item] of evalSet.entries()) {
    const bucket = byItem.get(itemIndex);
    if (!bucket) continue;

    const triggers = bucket.triggers;
    const errors = bucket.errors;
    const successfulRuns = triggers.length - errors;
    const triggerRate =
      successfulRuns > 0 ? triggers.filter(Boolean).length / successfulRuns : 0;
    const shouldTrigger = item.should_trigger;
    const thresholdPass = shouldTrigger
      ? triggerRate >= triggerThreshold
      : triggerRate < triggerThreshold;
    const didPass = errors === 0 && thresholdPass;

    results.push({
      query: item.query,
      should_trigger: shouldTrigger,
      trigger_rate: triggerRate,
      triggers: triggers.filter(Boolean).length,
      runs: triggers.length,
      successful_runs: successfulRuns,
      errors,
      pass: didPass,
    });
  }
  return results;
}

/**
 * 跑完整套评测集并返回结果。
 *
 * 并行用 `Promise.all` 加并发限流实现，替代 Python 的 `ProcessPoolExecutor`。
 *
 * 返回的 `results` 每个评测集条目一条，按评测集顺序（重复 query 保持独立）。
 *
 * @param opts 评测集、技能名与描述、并发与超时、项目根、取消信号等
 * @returns 逐条结果、告警与汇总
 * @throws 调用方取消时抛 `AbortError`
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalOutput> {
  const {
    evalSet,
    skillName,
    description,
    numWorkers,
    timeout,
    projectRoot,
    runsPerQuery = 3,
    triggerThreshold = 0.5,
    triggerOnly = true,
    model,
    agent = "build",
    signal,
    excludedSkillPath,
    shadowGuard = true,
    skillEnumerator,
    onMirror,
  } = opts;

  if (signal?.aborted) throw abortError();

  // J6/J7/J8：在任何子进程启动前决定同名技能怎么处理（自动 deny 或中止）。
  const deniedSkillNames = await resolveShadowGuard({
    skillName,
    projectRoot,
    excludedSkillPath,
    shadowGuard,
    enumerate: skillEnumerator ?? cliInstalledSkillEnumerator,
  });

  // 展开成完整的 (item, runIdx) 任务表。itemIndex 是稳定键：即使 query 文本重复、
  // 即使各次运行乱序完成，也能把每次运行归回它的评测集条目。
  type Job = { item: EvalItem; runIdx: number; itemIndex: number };
  const jobs: Job[] = [];
  evalSet.forEach((item, itemIndex) => {
    for (let r = 0; r < runsPerQuery; r++) {
      jobs.push({ item, runIdx: r, itemIndex });
    }
  });

  // 限并发执行
  const jobResults: EvalJobResult[] = [];
  let idx = 0;
  let abortedDuringRun = false;
  // 隔离根准备失败必须中止整轮评测（J7），而不是记成某条 query 的错误。
  let fatalError: Error | null = null;
  // 镜像汇总：多 worker 串行累加（JS 单线程事件循环，累加本身无需加锁）。
  const mirrorTotals: MirrorSummary = { entries: 0, bytes: 0, skipped: 0 };
  const collectMirror = (report: MirrorReport): void => {
    mirrorTotals.entries += report.entries.length;
    mirrorTotals.bytes += report.totalBytes;
    mirrorTotals.skipped += report.skipped.length;
    onMirror?.(report);
  };

  async function worker(): Promise<void> {
    while (idx < jobs.length && fatalError === null) {
      // 调用方取消后不再从队列取新任务。
      if (signal?.aborted) {
        abortedDuringRun = true;
        return;
      }
      const job = jobs[idx++];
      if (!job) break;
      try {
        const triggered = await runSingleQuery(
          job.item.query,
          skillName,
          description,
          timeout,
          projectRoot,
          agent,
          triggerOnly,
          model,
          signal,
          excludedSkillPath,
          deniedSkillNames,
          collectMirror,
        );
        jobResults.push({
          itemIndex: job.itemIndex,
          triggered,
          errored: false,
        });
      } catch (e) {
        if (e instanceof IsolationError || e instanceof ShadowGuardError) {
          fatalError = e;
          return;
        }
        if (isAbortError(e) || signal?.aborted) {
          abortedDuringRun = true;
          return;
        }
        console.error(`Warning: query failed: ${e}`);
        jobResults.push({
          itemIndex: job.itemIndex,
          triggered: false,
          errored: true,
        });
      }
    }
  }

  const workers = Array.from({ length: Math.min(numWorkers, jobs.length) }, () => worker());
  await Promise.all(workers);

  // 隔离环境不可信时整轮失败，不产出评分（也不写报告，报告由 CLI 在成功返回后写）。
  if (fatalError !== null) {
    throw fatalError;
  }

  // 取消以显式 abort 上报，绝不计成一条评分结果。
  if (signal?.aborted || abortedDuringRun) {
    throw abortError();
  }

  // 按评测集条目聚合（按 index 分组、按评测集顺序）。
  const results = aggregateEvalResults(evalSet, jobResults, triggerThreshold);

  const passed = results.filter((r) => r.pass).length;
  const runErrors = results.reduce((acc, r) => acc + r.errors, 0);
  const queriesWithErrors = results.filter((r) => r.errors > 0).length;

  return {
    skill_name: skillName,
    description,
    results,
    warnings: buildEvalWarnings(results),
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      run_errors: runErrors,
      queries_with_errors: queriesWithErrors,
    },
    ...(mirrorTotals.entries > 0 ? { mirror: mirrorTotals } : {}),
  };
}


