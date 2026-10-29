/**
 * 插件日志接入点：全仓唯一 1 处 `createLogger` 调用，其余模块只 import 单例 `log`。
 *
 * 开关与目录来自用户配置 `~/.config/opencode/plugin-logger.jsonc`（`enabled` 默认 false，
 * 所以默认不落盘）；测试与静默场景由 `isLoggingDisabled()` 统一覆盖成 `enabled: false`。
 */

import createLogger, { type Logger } from "@xiaoqiong0v0/opencode-plugin-logger";

/** 日志标识：与插件 id / 包名后缀一致，便于在日志目录里区分来源。 */
export const LOGGER_NAME = "opencode-skill-creator-zh";

/** 库没有导出 `LoggerOptions`，从工厂签名反推，避免手抄一份会漂移的类型。 */
export type LoggerOptions = NonNullable<Parameters<typeof createLogger>[1]>;

/**
 * 判断当前进程是否必须关闭日志。
 *
 * 两种情形一律关闭：① 显式设置 `SKILL_ZH_LOG_DISABLE=1`；② 跑在 `node --test` 下
 * （Node 会给每个测试子进程注入 `NODE_TEST_CONTEXT`）——测试不该往用户的日志目录写东西。
 *
 * @returns 需要关闭日志时为 `true`
 */
export function isLoggingDisabled(): boolean {
  return process.env.SKILL_ZH_LOG_DISABLE === "1" || process.env.NODE_TEST_CONTEXT !== undefined;
}

/**
 * 创建本插件的 logger。
 *
 * @param opts 覆盖用户配置文件的字段（测试或临时排查时指向别的目录）
 * @returns 库的 logger；被关闭时返回的是各方法都为空实现的实例
 */
export function createSkillZhLogger(opts?: LoggerOptions): Logger {
  return createLogger(LOGGER_NAME, isLoggingDisabled() ? { ...opts, enabled: false } : opts);
}

/** 全局单例：插件内所有日志都走它，保证开关只在一处判定。 */
export const log: Logger = createSkillZhLogger();
