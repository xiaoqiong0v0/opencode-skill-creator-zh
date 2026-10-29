/**
 * 调试输出开关（`docs/SPEC.md` R6.2-J5 / `docs/tools.md` 通用约定）。
 *
 * 只有显式设置 `SKILL_ZH_DEBUG=1` 才输出执行细节与镜像清单；默认不外泄内部路径、
 * 镜像条目与跳过原因（这些信息只在排查「评测为什么拷多了/少拷了」时需要）。
 */

/**
 * 判断调试开关是否打开。
 *
 * @returns 环境变量 `SKILL_ZH_DEBUG` 等于 `"1"` 时返回 `true`
 */
export function isDebugEnabled(): boolean {
  return process.env.SKILL_ZH_DEBUG === "1";
}

/**
 * 输出一行调试信息（未开调试时静默）。
 *
 * 走 stderr，避免污染工具回给模型的正文输出。
 *
 * @param message 调试文案（调用方自带 `[skill_zh:debug]` 前缀）
 */
export function debugLog(message: string): void {
  if (isDebugEnabled()) console.error(message);
}
