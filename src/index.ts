/**
 * 插件入口（V1 形态：只有默认导出 `{ id, server }`）。
 *
 * 为什么只有默认导出：旧版加载器会把具名导出逐个当成插件工厂尝试，多出额外导出会被误加载；
 * 因此工具定义放在 `src/tool.ts`，本文件只负责组装与注册（全仓唯一 1 处注册点，见 docs/SPEC.md R1）。
 */

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";

import { TOOL_NAME } from "./cli/help.js";
import { log } from "./lib/logger.js";
import { SKILL_ZH_TOOL } from "./tool.js";

/** 插件 id：与包名后缀、随包技能目录名一致，保证与上游英文插件共存。 */
const PLUGIN_ID = "opencode-skill-creator-zh";

/** 插件工厂：只注册 1 个工具，不挂其它钩子。 */
const server: Plugin = async (): Promise<Hooks> => {
  // 只留一次加载事件：交互测试时用它确认插件确实被 opencode 载入过。
  log.loaded();
  return { tool: { [TOOL_NAME]: SKILL_ZH_TOOL } };
};

const pluginModule: PluginModule = { id: PLUGIN_ID, server };

export default pluginModule;
