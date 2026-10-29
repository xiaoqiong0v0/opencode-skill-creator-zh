/**
 * 错误三段式构造器：所有面向用户的失败都走这里，保证格式唯一。
 *
 * 为什么固定三段：`错误`（哪里不对）→ `改法`（可直接照做）→ `可用`（兜底入口），
 * 让模型与用户都能在不追问的情况下修正调用（见 docs/SPEC.md R5）。
 */

import { TOOL_NAME } from "./help.js";

/** 第三段的兜底入口，固定指向 `help`。 */
export const AVAILABLE_HINT = `可用：${TOOL_NAME} help`;

/**
 * 生成三段式错误文本（恰好三行，无尾随换行、无堆栈）。
 *
 * @param problem 一句话说明哪里不对，例如 `缺少参数 <技能目录>`
 * @param fix 可复制执行的改法，例如 `运行 skill_zh validate ./skills/my-skill`
 * @returns 形如 `错误：…\n改法：…\n可用：skill_zh help` 的文本
 */
export function formatError(problem: string, fix: string): string {
  return [`错误：${problem}`, `改法：${fix}`, AVAILABLE_HINT].join("\n");
}
