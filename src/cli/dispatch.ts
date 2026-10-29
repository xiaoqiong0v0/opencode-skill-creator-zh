/**
 * 子命令分发：把解析结果 + 项目上下文路由到对应实现，并把失败统一成三段式。
 *
 * 分发是「工具成不成功」的唯一判定位（见 docs/SPEC.md R5）：`new` / `validate` 已接
 * `src/cli/new.ts` / `src/cli/validate.ts`，其余子命令由 B4/B5 接入，当前回「尚未实现」三段式，
 * 绝不抛异常。
 *
 * 路径口径（docs/SPEC.md R6.2-J2）：项目目录只来自调用方传入的 `directory`，退一步用
 * `worktree`；**不从 `process.cwd()` 派生，也不向上查找**。上游 `findProjectRoot()` 在 Windows
 * 上会把 `~/.opencode`（运行时目录）当成项目根，是本仓明确不复刻的做法。
 */

import { log } from "../lib/logger.js";
import { formatError } from "./errors.js";
import { HELP_TEXT, SUBCOMMANDS, isSubcommand, type Subcommand } from "./help.js";
import { newHandler } from "./new.js";
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

/**
 * 未接实现子命令的占位 handler（`eval` / `optimize` / `package`，B4 接入）。
 *
 * 仍然接收完整 `HandlerInput`：一是保证 `ctx` 一路带到 handler（接实现时只改 handler 表），
 * 二是把将要使用的项目目录显式带进输出，路径取错时能立刻看出来。
 *
 * @param input handler 入参
 * @returns 失败结果，文本为三段式
 */
const pendingHandler: SubcommandHandler = ({ projectDir }: HandlerInput): DispatchResult => {
  log.info(`子命令尚未实现（B4）：项目目录 ${projectDir}`);
  return {
    ok: false,
    output: formatError(
      "子命令尚未实现",
      `等待 B4 落地；先用 skill_zh help 查看用法（项目目录：${projectDir}）`,
    ),
  };
};

/**
 * `install` 的占位 handler：文案点明归属批次（B5），免得和 B3/B4 的五个子命令混淆。
 *
 * @returns 失败结果，文本为三段式
 */
const installPendingHandler: SubcommandHandler = (): DispatchResult => {
  log.info("install 子命令尚未实现（B5）");
  return {
    ok: false,
    output: formatError("install 子命令尚未实现", "等待 B5 落地；当前可用 skill_zh help 查看规划中的用法"),
  };
};

/** 子命令 → handler；`help` 在分发里直接短路，不在这张表里。 */
const HANDLERS: Record<Exclude<Subcommand, "help">, SubcommandHandler> = {
  new: newHandler,
  validate: validateHandler,
  eval: pendingHandler,
  optimize: pendingHandler,
  package: pendingHandler,
  install: installPendingHandler,
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
export function runCommand(parsed: ParsedArgs, ctx: DispatchContext): DispatchResult {
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
  try {
    return HANDLERS[command]({
      positionals: parsed.positionals,
      flags: parsed.flags,
      projectDir,
      ctx,
    });
  } catch (error) {
    // handler 是 B3/B4 接进来的外部逻辑：抛错一律转三段式，堆栈只进日志。
    log.error(`子命令 ${command} 执行失败`, error instanceof Error ? error : new Error(String(error)));
    return {
      ok: false,
      output: formatError(`子命令 ${command} 执行失败`, "先用 skill_zh help 确认参数写法，再重试一次"),
    };
  }
}

/**
 * 工具层入口：吃原始 `args` 字符串与项目上下文，只回文本。
 *
 * @param input 工具收到的原始 `args` 字符串，例如 `"help"`
 * @param ctx 工具调用带来的项目上下文（`directory` / `worktree`）
 * @returns 回给模型的完整文本（失败时是三段式错误，同样不抛异常）
 */
export function dispatch(input: string, ctx: DispatchContext): string {
  return runCommand(parseArgs(input), ctx).output;
}
