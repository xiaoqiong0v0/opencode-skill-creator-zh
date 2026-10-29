/**
 * 插件入口（V1 形态：只有默认导出 `{ id, server }`）。
 *
 * 为什么只有默认导出：旧版加载器会把具名导出逐个当成插件工厂尝试，多出额外导出会被误加载；
 * 因此工具定义放在 `src/tool.ts`，本文件只负责组装与注册（全仓唯一 1 处注册点，见 docs/SPEC.md R1）。
 */

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

import { TOOL_NAME } from "./cli/help.js";
import { log } from "./lib/logger.js";
import { scheduleStartupSkillInstall } from "./lib/skill-install.js";
import { SKILL_ZH_TOOL } from "./tool.js";

/** 插件 id：与包名后缀、随包技能目录名一致，保证与上游英文插件共存。 */
const PLUGIN_ID = "opencode-skill-creator-zh";

/** 插件工厂：注册 1 个工具，并在启动时尝试一次静默安装技能（不阻塞）。 */
const server: Plugin = async (): Promise<Hooks> => {
  // 只留一次加载事件：交互测试时用它确认插件确实被 opencode 载入过。
  log.loaded();

  // 同步注册、后台执行：无冲突且目标不存在/版本不同才写盘，其余只记日志（R6.1-I1..I5）。
  scheduleStartupSkillInstall({
    logInfo: (message) => log.info(message),
    logError: (message, error) => log.error(message, error instanceof Error ? error : new Error(String(error))),
  });

  return { tool: { [TOOL_NAME]: SKILL_ZH_TOOL } };
};

const pluginModule: PluginModule = { id: PLUGIN_ID, server };

export default pluginModule;
