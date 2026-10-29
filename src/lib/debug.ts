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
 * 走 stderr，避免污染工具回给模型的正文输出；所有调试文本统一先做凭据掩码，
 * 调用方无需自行处理（防止异常消息、子进程 stderr 里的密钥被原样打印）。
 *
 * @param message 调试文案（调用方自带 `[skill_zh:debug]` 前缀）
 */
export function debugLog(message: string): void {
  if (isDebugEnabled()) console.error(maskSecrets(message));
}

/**
 * 疑似凭据的掩码规则，按「先具体、后宽泛」顺序应用。
 *
 * 覆盖：私钥块、`Bearer <token>`、`sk-*`、`key = value` 形式的口令，以及 32 位以上的
 * 长随机串（常见于用户误贴的 token）。
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[私钥已掩码]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [已掩码]"],
  [/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-[已掩码]"],
  [
    /\b(api[_-]?key|token|secret|password|authorization)(\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{6,}/gi,
    "$1$2[已掩码]",
  ],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[已掩码长串]"],
];

/**
 * 把文本里疑似凭据的片段替换成占位符。
 *
 * 只用于「调试时才输出原始内容」的场景，确保即便用户误把密钥写进配置或报错，
 * 也不会原样落到 stderr / 日志里。
 *
 * @param text 原始文本（异常消息、子进程 stderr 等）
 * @returns 掩码后的文本
 */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

/**
 * 输出一条中文摘要；原始细节只在 `SKILL_ZH_DEBUG=1` 时输出，且先做凭据掩码。
 *
 * 默认路径只写一行摘要，避免把子进程 stderr（可能含路径、凭据）抛给用户。
 *
 * @param summary 面向用户的中文摘要
 * @param detail 原始异常 / stderr 等细节（可选；默认不输出）
 */
export function logErrorSummary(summary: string, detail?: unknown): void {
  console.error(summary);
  if (!isDebugEnabled() || detail === undefined) return;
  const raw = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
  const masked = maskSecrets(raw);
  for (const line of masked.split(/\r?\n/)) {
    console.error(`[skill_zh:debug] ${line}`);
  }
}
