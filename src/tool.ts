/**
 * `skill_zh` 的工具定义（全仓唯一 1 处工具注册调用）。
 *
 * 入参只有一个 `args` 字符串，业务全部交给 `src/cli/dispatch.ts`；这里不写任何
 * 子命令逻辑，避免工具层与 CLI 层各自维护一份参数语义。
 *
 * 路径口径：把 `ToolContext` 的 `directory` / `worktree` 原样透传给分发层，**不用
 * `process.cwd()`**（`tool.d.ts` 的原话是 prefer this over process.cwd()）。
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import { dispatch } from "./cli/dispatch.js";
import { formatError } from "./cli/errors.js";
import { TOOL_DESCRIPTION, TOOL_NAME } from "./cli/help.js";
import { log } from "./lib/logger.js";

/** `skill_zh` 的工具定义，由 `src/index.ts` 注册到 OpenCode。 */
export const SKILL_ZH_TOOL: ToolDefinition = tool({
  description: TOOL_DESCRIPTION,
  args: {
    args: tool.schema.string().describe("子命令与参数；不带参数等同 help"),
  },
  execute: async (input, context): Promise<string> => {
    log.tool(TOOL_NAME, { args: input.args });
    try {
      return dispatch(input.args, { directory: context.directory, worktree: context.worktree });
    } catch (error) {
      // 工具层兜底：任何异常都转三段式，绝不把堆栈抛给模型（R5）。
      log.error(`${TOOL_NAME} 执行失败`, toLoggableError(error));
      return formatError(`${TOOL_NAME} 执行失败`, "先用 skill_zh help 确认参数写法，再重试一次");
    }
  },
});

/**
 * 把 catch 到的未知值转成 logger 能接受的形式。
 *
 * @param error `catch` 分支拿到的任意值
 * @returns 原样 Error，或包一层 Error 保留文本
 */
function toLoggableError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
