/**
 * `eval` / `optimize` 共用的参数解析、评测集读取与失败文案。
 *
 * 两个子命令的选项高度重合（`--runs` / `--workers` / `--timeout` / `--model` /
 * `--agent` / `--eval-set` / `--no-shadow-guard`），集中在这里可以保证默认值、非法值
 * 判据与三段式改法只有一份实现，避免两个 handler 各写一套后漂移。
 *
 * 路径口径（`docs/SPEC.md` R6.2-J2）：相对路径一律按 `HandlerInput.projectDir`
 * （即 `ToolContext.directory` → `worktree`）解析；**不读 `process.cwd()`、不向上查找**。
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { IsolationError, ShadowGuardError } from "../lib/run-eval.js";
import { parseSkillMd } from "../lib/utils.js";
import { formatError } from "./errors.js";
import type { FlagValue } from "./types.js";
import type { DispatchResult, HandlerInput } from "./types.js";
import type { EvalItem, MirrorSummary } from "../lib/run-eval.js";

/** 每个 query 的默认重复次数。 */
export const DEFAULT_RUNS = 1;

/** 默认并发数：默认串行，避免一上来就打满 provider 配额。 */
export const DEFAULT_WORKERS = 1;

/** 单次 query 的默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** 评测集默认文件名（放在技能目录下）。 */
export const DEFAULT_EVAL_SET_FILE = "eval_set.json";

/** 报告目录默认值（技能目录下的 `.evals/`，按 gitignore 习惯用点目录）。 */
export const DEFAULT_LOG_DIR = ".evals";

/** 触发率阈值（与 `runEval` 的默认值一致）。 */
export const DEFAULT_TRIGGER_THRESHOLD = 0.5;

/** 优化循环的留出集比例（测试集占比）。 */
export const DEFAULT_HOLDOUT = 0.4;

/** 优化循环的默认轮数。 */
export const DEFAULT_ITERATIONS = 5;

/** 解析完成的评测参数（路径均已转成绝对路径）。 */
export interface EvalCliOptions {
  /** 技能目录绝对路径。 */
  skillPath: string;
  /** 用户写的技能目录（用于输出与改法，可直接照抄）。 */
  skillDisplay: string;
  /** frontmatter 的 `name`。 */
  skillName: string;
  /** frontmatter 的 `description`。 */
  description: string;
  /** 评测集（已读取并校验）。 */
  evalSet: EvalItem[];
  /** 评测集显示路径。 */
  evalSetDisplay: string;
  /** 每条 query 的重复次数。 */
  runsPerQuery: number;
  /** 并发数。 */
  numWorkers: number;
  /** 单次超时秒数（`runEval` 以秒为单位）。 */
  timeoutSeconds: number;
  model?: string;
  agent?: string;
  /** 报告目录绝对路径。 */
  logDir: string;
  /** 是否自动屏蔽同名技能（`--no-shadow-guard` 时为 false）。 */
  shadowGuard: boolean;
}

/** 参数准备结果：成功带选项，失败直接就是三段式结果。 */
export type PreparedOptions =
  | { ok: true; options: EvalCliOptions }
  | { ok: false; result: DispatchResult };

/**
 * 把路径统一成 `/` 分隔，供输出与改法命令使用。
 *
 * @param path 任意文件系统路径
 * @returns 用 `/` 分段的路径文本
 */
export function toDisplayPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * 取字符串标志的取值。
 *
 * @param flags 已解析的标志
 * @param name 标志名（不含 `--`）
 * @returns 标志取值；未出现返回 `undefined`；只写开关没写取值时返回 `true`
 */
function rawFlag(flags: Record<string, FlagValue>, name: string): FlagValue | undefined {
  return flags[name];
}

/**
 * 解析正整数标志（缺省用默认值）。
 *
 * @param flags 已解析的标志
 * @param name 标志名（不含 `--`）
 * @param example 改法里可直接照抄的示例值
 * @param fallback 缺省值
 * @returns 解析结果（非法时带改法提示）
 */
function parsePositiveInt(
  flags: Record<string, FlagValue>,
  name: string,
  example: string,
  fallback: number,
  command: "eval" | "optimize",
  skillDisplay: string,
): { ok: true; value: number } | { ok: false; problem: string; fix: string } {
  const raw = rawFlag(flags, name);
  if (raw === undefined) return { ok: true, value: fallback };
  if (typeof raw !== "string") {
    return {
      ok: false,
      problem: `缺少参数 --${name} <数值>`,
      fix: `运行 skill_zh ${command} ${skillDisplay} --${name} ${example}`,
    };
  }
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    return {
      ok: false,
      problem: `参数 --${name} 非法：${raw}（只接受正整数）`,
      fix: `改用正整数，例如 skill_zh ${command} ${skillDisplay} --${name} ${example}`,
    };
  }
  return { ok: true, value: Number(raw) };
}

/**
 * 把字符串标志转成 `string | undefined`；只写开关没写取值视为非法。
 *
 * @param flags 已解析的标志
 * @param name 标志名（不含 `--`）
 * @returns 值、未出现时为 `undefined`
 */
function stringFlag(flags: Record<string, FlagValue>, name: string): FlagValue | undefined {
  return rawFlag(flags, name);
}

/**
 * 读取并校验评测集 JSON。
 *
 * @param evalSetPath 评测集绝对路径
 * @param display 评测集显示路径（错误文案里可直接照抄）
 * @returns 评测集条目，或带三段式结果的失败
 */
function loadEvalSet(
  evalSetPath: string,
  display: string,
): { ok: true; items: EvalItem[] } | { ok: false; result: DispatchResult } {
  if (!existsSync(evalSetPath)) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `评测集不存在：${display}`,
          `在技能目录下新建 ${DEFAULT_EVAL_SET_FILE}，写入 [{"query":"…","should_trigger":true}] 形式的 JSON 数组`,
        ),
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(evalSetPath, "utf-8"));
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `评测集不是合法 JSON：${display}（${error instanceof Error ? error.message : String(error)}）`,
          `修正 ${display} 的语法，确保是 [{"query":"…","should_trigger":true}] 形式的数组`,
        ),
      },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `评测集必须是 JSON 数组：${display}`,
          `把 ${display} 改成 [{"query":"…","should_trigger":true}] 形式的数组`,
        ),
      },
    };
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `评测集为空：${display}`,
          `在 ${display} 里至少写一条 {"query":"…","should_trigger":true}`,
        ),
      },
    };
  }

  const items: EvalItem[] = [];
  for (const [index, entry] of parsed.entries()) {
    const record = entry as Record<string, unknown> | null;
    if (!record || typeof record.query !== "string" || !record.query.trim()) {
      return {
        ok: false,
        result: {
          ok: false,
          output: formatError(
            `评测集第 ${index + 1} 条缺少 query：${display}`,
            `给第 ${index + 1} 条补上 "query": "用户会说的话"`,
          ),
        },
      };
    }
    if (typeof record.should_trigger !== "boolean") {
      return {
        ok: false,
        result: {
          ok: false,
          output: formatError(
            `评测集第 ${index + 1} 条的 should_trigger 不是布尔值：${display}`,
            `把第 ${index + 1} 条的 should_trigger 改成 true 或 false`,
          ),
        },
      };
    }
    items.push({ query: record.query, should_trigger: record.should_trigger });
  }

  return { ok: true, items };
}

/**
 * 解析 `eval` / `optimize` 共用的参数并读取评测集。
 *
 * @param input handler 入参（`positionals[0]` 为技能目录）
 * @param command 当前子命令名（用于改法与下一步示例）
 * @returns 解析结果或三段式失败
 */
export function prepareEvalOptions(
  input: HandlerInput,
  command: "eval" | "optimize",
): PreparedOptions {
  const target = input.positionals[0];
  if (target === undefined) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          "缺少参数 <技能目录>",
          `运行 skill_zh ${command} ./skills/my-skill（技能目录里要有 SKILL.md）`,
        ),
      },
    };
  }

  const skillPath = resolve(input.projectDir, target);
  const skillDisplay = toDisplayPath(target);
  if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `技能目录不存在：${skillDisplay}`,
          `确认目录名拼写，或运行 skill_zh new my-skill --dir ./skills 新建一个`,
        ),
      },
    };
  }

  let skillName: string;
  let description: string;
  try {
    const meta = parseSkillMd(skillPath);
    skillName = meta.name.trim();
    description = meta.description.trim();
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `技能目录里没有可用的 SKILL.md：${skillDisplay}（${error instanceof Error ? error.message : String(error)}）`,
          `先运行 skill_zh validate ${skillDisplay} 定位问题，修好 frontmatter 再评测`,
        ),
      },
    };
  }
  if (skillName === "") {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          `SKILL.md 缺少 frontmatter name：${skillDisplay}`,
          `在 ${skillDisplay}/SKILL.md 的 frontmatter 里补 name: my-skill，再运行 skill_zh validate ${skillDisplay}`,
        ),
      },
    };
  }

  const runs = parsePositiveInt(input.flags, "runs", "3", DEFAULT_RUNS, command, skillDisplay);
  if (!runs.ok) {
    return { ok: false, result: { ok: false, output: formatError(runs.problem, runs.fix) } };
  }
  const workers = parsePositiveInt(input.flags, "workers", "4", DEFAULT_WORKERS, command, skillDisplay);
  if (!workers.ok) {
    return { ok: false, result: { ok: false, output: formatError(workers.problem, workers.fix) } };
  }
  const timeout = parsePositiveInt(
    input.flags,
    "timeout",
    "120000",
    DEFAULT_TIMEOUT_MS,
    command,
    skillDisplay,
  );
  if (!timeout.ok) {
    return { ok: false, result: { ok: false, output: formatError(timeout.problem, timeout.fix) } };
  }

  const model = stringFlag(input.flags, "model");
  if (model === true) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          "缺少参数 --model <provider/model>",
          `运行 skill_zh ${command} ${skillDisplay} --model provider/model`,
        ),
      },
    };
  }
  const agent = stringFlag(input.flags, "agent");
  if (agent === true) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          "缺少参数 --agent <名称>",
          `运行 skill_zh ${command} ${skillDisplay} --agent build`,
        ),
      },
    };
  }

  const evalSetFlag = stringFlag(input.flags, "eval-set");
  if (evalSetFlag === true) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          "缺少参数 --eval-set <路径>",
          `运行 skill_zh ${command} ${skillDisplay} --eval-set ${skillDisplay}/${DEFAULT_EVAL_SET_FILE}`,
        ),
      },
    };
  }
  const evalSetPath =
    typeof evalSetFlag === "string"
      ? resolve(input.projectDir, evalSetFlag)
      : join(skillPath, DEFAULT_EVAL_SET_FILE);
  const evalSetDisplay =
    typeof evalSetFlag === "string"
      ? toDisplayPath(evalSetFlag)
      : `${skillDisplay.replace(/\/+$/, "")}/${DEFAULT_EVAL_SET_FILE}`;

  const loaded = loadEvalSet(evalSetPath, evalSetDisplay);
  if (!loaded.ok) return { ok: false, result: loaded.result };

  const logDirFlag = stringFlag(input.flags, "log-dir");
  if (logDirFlag === true) {
    return {
      ok: false,
      result: {
        ok: false,
        output: formatError(
          "缺少参数 --log-dir <路径>",
          `运行 skill_zh ${command} ${skillDisplay} --log-dir ${skillDisplay}/${DEFAULT_LOG_DIR}`,
        ),
      },
    };
  }
  const logDir =
    typeof logDirFlag === "string"
      ? resolve(input.projectDir, logDirFlag)
      : join(skillPath, DEFAULT_LOG_DIR);

  return {
    ok: true,
    options: {
      skillPath,
      skillDisplay,
      skillName,
      description,
      evalSet: loaded.items,
      evalSetDisplay,
      runsPerQuery: runs.value,
      numWorkers: workers.value,
      timeoutSeconds: timeout.value / 1000,
      ...(typeof model === "string" ? { model } : {}),
      ...(typeof agent === "string" ? { agent } : {}),
      logDir,
      shadowGuard: input.flags["no-shadow-guard"] !== true,
    },
  };
}

/**
 * 把一份报告写进日志目录，文件名带时间戳（多 worker / 多轮不会互相覆盖）。
 *
 * @param logDir 报告目录（不存在则创建）
 * @param prefix 文件名前缀（`eval` / `optimize`）
 * @param data 报告内容
 * @returns 报告绝对路径
 */
export function writeJsonReport(logDir: string, prefix: string, data: unknown): string {
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  // 时间戳之外再加 4 位随机后缀：并发调用（同一毫秒）也不会互相覆盖。
  const unique = randomBytes(2).toString("hex");
  const file = join(logDir, `${prefix}-${stamp}-${unique}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return file;
}

/**
 * 渲染镜像汇总的一行文案（J5：默认只输出这一行，逐条清单只在调试开关下打印）。
 *
 * @param summary 镜像汇总
 * @returns 汇总行；无汇总时返回 `null`
 */
export function formatMirrorSummary(summary: MirrorSummary | undefined): string | null {
  if (!summary) return null;
  const size = summary.bytes > 0 ? `共 ${(summary.bytes / 1024).toFixed(1)} KB` : "链接镜像";
  return `镜像：${summary.entries} 个条目，${size}（跳过 ${summary.skipped} 项）`;
}

/**
 * 把同名技能守卫抛出的错误转成三段式（J7：含实际路径与可复制命令）。
 *
 * @param error 捕获到的错误
 * @param command 当前子命令名
 * @param skillDisplay 技能目录显示路径
 * @returns 三段式结果；不是 {@link ShadowGuardError} 时返回 `null`
 */
export function shadowGuardFailure(
  error: unknown,
  command: "eval" | "optimize",
  skillDisplay: string,
): DispatchResult | null {
  if (!(error instanceof ShadowGuardError)) return null;
  // 枚举不可用（没有冲突位置）与「找到同名技能」是两种病因，改法必须分别给：前者是
  // 工具不可用，后者才是环境里有同名技能。
  if (error.locations.length === 0) {
    return {
      ok: false,
      output: formatError(
        error.message,
        "确认 `opencode debug skill` 可用（在 opencode 会话内或 shell 里能跑起来），然后重试",
      ),
    };
  }
  const locations = error.locations.join("、");
  return {
    ok: false,
    output: formatError(
      error.message,
      `移走或改名 ${locations} 里的同名技能后重试；或运行 skill_zh ${command} ${skillDisplay} --no-shadow-guard（不自动屏蔽，检测到同名即中止）`,
    ),
  };
}

/**
 * 把隔离根准备失败（镜像 / deny 写入）转成三段式（J7：整轮中止，不产出报告）。
 *
 * @param error 捕获到的错误
 * @returns 三段式结果；不是 {@link IsolationError} 时返回 `null`
 */
export function isolationFailure(error: unknown): DispatchResult | null {
  if (!(error instanceof IsolationError)) return null;
  return {
    ok: false,
    output: formatError(
      error.message,
      "检查系统临时目录的写权限与磁盘空间后重试（或用 --log-dir 把报告指向可写目录）",
    ),
  };
}

/**
 * 把执行期失败（`opencode` 不可用、provider/模型未配置等）转成三段式。
 *
 * @param error 捕获到的错误
 * @param command 当前子命令名
 * @param skillDisplay 技能目录显示路径
 * @returns 三段式结果
 */
export function executionFailure(
  error: unknown,
  command: "eval" | "optimize",
  skillDisplay: string,
): DispatchResult {
  const reason = (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return {
    ok: false,
    output: formatError(
      `无法调用 opencode 执行评测：${reason || "未知错误"}`,
      `先确认 opencode CLI 可用、provider 与模型已配置，再运行 skill_zh ${command} ${skillDisplay}`,
    ),
  };
}
