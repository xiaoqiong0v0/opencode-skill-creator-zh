/**
 * 子命令分发：把解析结果 + 项目上下文路由到对应实现，并把失败统一成三段式。
 *
 * 分发是「工具成不成功」的唯一判定位（见 docs/SPEC.md R5）：7 个子命令全部接真实现，
 * 失败一律转三段式，绝不抛异常。
 *
 * 路径口径（docs/SPEC.md R6.2-J2）：项目目录只来自调用方传入的 `directory`，退一步用
 * `worktree`；**不从 `process.cwd()` 派生，也不向上查找**。上游的 cwd 向上取根在 Windows
 * 上会把 `~/.opencode`（运行时目录）当成项目根，是本仓明确不复刻的做法。
 */

import { log } from "../lib/logger.js";
import { evalHandler } from "./eval.js";
import { formatError } from "./errors.js";
import { HELP_TEXT, SUBCOMMANDS, isSubcommand, type Subcommand } from "./help.js";
import { installHandler } from "./install.js";
import { newHandler } from "./new.js";
import { optimizeHandler } from "./optimize.js";
import { packageHandler } from "./package.js";
import { parseArgs } from "./parse-args.js";
import { validateHandler } from "./validate.js";
import type { DispatchContext, DispatchResult, HandlerInput, ParsedArgs, SubcommandHandler } from "./types.js";

/** 未知子命令时列出的可用子命令（由 `SUBCOMMANDS` 派生，避免与 `help` 顺序漂移）。 */
const AVAILABLE_SUBCOMMANDS = SUBCOMMANDS.join(" / ");

/** `help` / 空参数共用的成功结果（帮助文本不依赖项目目录）。 */
const HELP_RESULT: DispatchResult = { ok: true, output: HELP_TEXT };

/**
 * 解析项目目录：`directory` 优先，其次 `worktree`；两者都为空时返回空串。
 *
 * 不读 `process.cwd()`、不做向上查找——相对路径的基准必须由调用方显式给出。
 *
 * @param ctx 工具调用带来的项目上下文
 * @returns 可用的项目目录；`""` 表示拿不到
 */
export function resolveProjectDir(ctx: DispatchContext): string {
  return ctx.directory || ctx.worktree;
}

/** 子命令 → handler；`help` 在分发里直接短路，不在这张表里。 */
const HANDLERS: Record<Exclude<Subcommand, "help">, SubcommandHandler> = {
  new: newHandler,
  validate: validateHandler,
  eval: evalHandler,
  optimize: optimizeHandler,
  package: packageHandler,
  install: installHandler,
};

/**
 * 执行一次已解析的调用。
 *
 * 保留 `ok` 标志的原因：CLI 调试入口需要据此决定退出码，工具层只用 `output`。
 *
 * @param parsed `parseArgs` 的解析结果
 * @param ctx 项目上下文（来自 `ToolContext`）
 * @returns 成功标志与完整输出文本
 */
export function runCommand(
  parsed: ParsedArgs,
  ctx: DispatchContext,
): DispatchResult | Promise<DispatchResult> {
  const { command } = parsed;
  log.log("DEBUG", `dispatch ${command === "" ? "(空)" : command}`);

  // 空参数等同于 help：模型常省略参数，直接给用法比报错更有用。help 不读目录，故先短路。
  if (command === "") return HELP_RESULT;

  if (!isSubcommand(command)) {
    log.info(`未知子命令 "${command}"`);
    return {
      ok: false,
      output: formatError(`未知子命令 "${command}"`, `可用子命令：${AVAILABLE_SUBCOMMANDS}`),
    };
  }

  // 单独判 help 只为让类型收窄到「非 help 子命令」，下面才敢用 handler 表取值。
  if (command === "help") return HELP_RESULT;

  const projectDir = resolveProjectDir(ctx);
  // 拿不到目录就早失败：继续往下走只会让 B3/B4 用错基准（或退回 process.cwd()）。
  if (projectDir === "") {
    return {
      ok: false,
      output: formatError("拿不到当前项目目录", "在 opencode 会话内重试，或显式传绝对路径"),
    };
  }

  // TODO(B3): SKILL_ZH_DEBUG 输出原始错误（当前无抛点，见 docs/ROADMAP.md B2 调试开关一条）。
  const fail = (error: unknown): DispatchResult => {
    // handler 是外部逻辑（含 `opencode run` 子进程）：失败一律转三段式，堆栈只进日志。
    log.error(
      `子命令 ${command} 执行失败`,
      error instanceof Error ? error : new Error(String(error)),
    );
    return {
      ok: false,
      output: formatError(
        `子命令 ${command} 执行失败`,
        "先用 skill_zh help 确认参数写法，再重试一次",
      ),
    };
  };

  try {
    const outcome = HANDLERS[command]({
      positionals: parsed.positionals,
      flags: parsed.flags,
      projectDir,
      ctx,
    });
    // 同步 handler（new / validate）保持同步返回；异步 handler（eval / optimize）把
    // rejection 也收进同一套三段式，避免未捕获的 Promise 抛到工具层。
    return outcome instanceof Promise ? outcome.catch(fail) : outcome;
  } catch (error) {
    return fail(error);
  }
}

/**
 * 工具层入口：吃原始 `args` 字符串与项目上下文，只回文本。
 *
 * @param input 工具收到的原始 `args` 字符串，例如 `"help"`
 * @param ctx 工具调用带来的项目上下文（`directory` / `worktree`）
 * @returns 回给模型的完整文本（失败时是三段式错误，同样不抛异常）
 */
export async function dispatch(input: string, ctx: DispatchContext): Promise<string> {
  return (await runCommand(parseArgs(input), ctx)).output;
}
