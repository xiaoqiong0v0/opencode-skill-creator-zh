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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { parse as parseJsonc } from "jsonc-parser";

import { buildOpencodeEnv, isFailedProcess, runProcess } from "./process.js";
import type { RunProcessResult } from "./process.js";

/** 合法技能名：小写字母/数字组成的 kebab-case。 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 项目可能放在根目录的配置文档；存在几个就镜像几个。 */
const ROOT_CONFIG_FILES = ["opencode.json", "opencode.jsonc"] as const;

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
 * 构造「同名技能已安装」的冲突文案。
 *
 * @param skillName 被测技能的基础名
 * @param locations 同名技能的位置列表
 * @returns 供用户处置的冲突说明
 */
export function skillConflictMessage(
  skillName: string,
  locations: string[],
): string {
  return `skill_eval conflict: skill "${skillName}" is already available to opencode at ${locations.join(", ")}. Remove that installed skill or its skills.paths entry before running skill_eval. The eval tool creates a synthetic skill named "${skillName}-skill-<id>" and only counts that temporary skill as triggered; an installed skill with the base name can steal triggers and produce false negatives.`;
}

/**
 * 构造「无法枚举已安装技能」的中止文案。
 *
 * @param skillName 被测技能的基础名
 * @returns 说明为何不继续评测、以及两条按版本处置的提示
 */
export function skillEnumerationUnavailableMessage(skillName: string): string {
  return `skill_eval aborted: could not enumerate the skills installed in this project to check whether "${skillName}" is already available. A pre-installed skill with the base name can steal triggers and produce false negatives, so the eval does not run rather than return misleading results. In OpenCode V2 the plugin uses the skill list API; if that call fails, retry once the server is healthy. In V1 the check uses \`opencode debug skill\`.`;
}

/**
 * 断言被测技能没有被同名已安装技能占用。
 *
 * @param skillName 被测技能的基础名
 * @param projectRoot 项目根目录
 * @param enumerate 枚举器（默认走 V1 的 `opencode debug skill`）
 * @returns 无冲突时正常完成
 * @throws 枚举不可用，或发现同名技能时抛错，文案分别见上两个构造器
 */
export async function assertNoInstalledSkillConflict(
  skillName: string,
  projectRoot: string,
  enumerate: SkillEnumerator = cliInstalledSkillEnumerator,
): Promise<void> {
  const skills = await enumerate(projectRoot);
  if (skills === null) {
    throw new Error(skillEnumerationUnavailableMessage(skillName));
  }

  const locations = findSkillConflictsInList(skills, skillName);
  if (locations.length === 0) return;

  throw new Error(skillConflictMessage(skillName, locations));
}

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
 * 从 `cwd` 逐级向上查找 `.opencode/` 或 `.claude/`，定位项目根 —— 与 OpenCode
 * 发现项目根的方式一致。
 *
 * @param cwd 起始目录，缺省为 `process.cwd()`
 * @returns 第一个含 `.opencode` 或 `.claude` 的祖先目录；一路到盘符根都没命中时
 * 返回起始目录
 */
export function findProjectRoot(cwd?: string): string {
  let current = cwd ?? process.cwd();
  const { root } = parse(current);

  while (true) {
    if (existsSync(join(current, ".opencode"))) return current;
    if (existsSync(join(current, ".claude"))) return current;
    const parent = dirname(current);
    if (parent === current || parent === root) break;
    current = parent;
  }
  return cwd ?? process.cwd();
}

/**
 * 把项目的配置条目镜像进评测根：优先建符号链接（开销小、不拷贝），并显式传 type
 * 让目录链接正确解析。在符号链接不可用的平台（Windows 未开管理员/开发者模式时以
 * EPERM 拒绝）回退到递归拷贝，保证评测隔离在各平台都能用。幂等：目标已存在时原样
 * 保留，重叠的镜像不会因 EEXIST 冲突。
 *
 * @param source 源路径（文件或目录）
 * @param target 评测根内的目标路径
 * @param isDirectory 源是否为目录（决定符号链接的 type）
 */
function linkOrCopyConfigEntry(source: string, target: string, isDirectory: boolean): void {
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  try {
    symlinkSync(source, target, isDirectory ? "dir" : "file");
  } catch {
    // TODO(B4/J1): 禁止整目录递归拷贝，改为逐文件白名单 + 单文件大小上限
    if (!existsSync(target)) cpSync(source, target, { recursive: true });
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
  excludedSkillPath?: string,
): void {
  const skillsRoot = join(projectRoot, ".opencode", "skills");

  for (const name of ROOT_CONFIG_FILES) {
    const source = join(projectRoot, name);
    if (!existsSync(source)) continue;
    linkOrCopyConfigEntry(source, join(evalRoot, name), false);

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
        linkOrCopyConfigEntry(absolute, target, statSync(absolute).isDirectory());
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
 */
export function symlinkProjectOpenCodeConfig(
  projectRoot: string,
  evalRoot: string,
  skillName: string,
  excludedSkillPath?: string,
): void {
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
      linkOrCopyConfigEntry(entryPath, join(targetOpenCode, entry.name), entry.isDirectory());
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
        linkOrCopyConfigEntry(entryPath, join(targetSkills, entry.name), entry.isDirectory());
      }
    }
  }

  // 根配置文档（及其引用的相对文件）镜像到相同的相对位置。OpenCode 以配置文档所在
  // 目录解析 `instructions` 与 `{file:...}` 引用，因此只有相对兄弟文件一起过来，
  // 文档才真正生效。
  mirrorRootConfigDocuments(projectRoot, evalRoot, excludedSkillPath);
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
    symlinkProjectOpenCodeConfig(projectRoot, evalRoot, skillName, excludedSkillPath);
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
    // 清理隔离的临时项目根。
    if (existsSync(evalRoot)) {
      rmSync(evalRoot, { recursive: true, force: true });
    }
  }
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
  } = opts;

  if (signal?.aborted) throw abortError();

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

  async function worker(): Promise<void> {
    while (idx < jobs.length) {
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
        );
        jobResults.push({
          itemIndex: job.itemIndex,
          triggered,
          errored: false,
        });
      } catch (e) {
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
  };
}


