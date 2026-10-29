# SPEC —— 中文技能工坊需求与验收口径

本文是**需求与验收口径的唯一出处**。实施批次见 [ROADMAP.md](ROADMAP.md)，编码规范见 [CONVENTIONS.md](CONVENTIONS.md)，用法定稿见 [../README.md](../README.md)。

> 当前状态：仓库只有文档与 `skill/`，`src/` 尚未创建。文中所有行为均为**目标行为**，验收项按 ROADMAP 批次逐步成立。

## 1. 目标

把上游 14 个英文 `skill_*` 工具收敛为 **1 个中文 CLI 风格工具** `skill_zh`：单工具、单 `args` 字符串、`help` 自解释；文案全中文；技能随包分发且与上游英文技能共存；不引用其它技能。

## 2. 架构口径

| 项 | 定稿 |
|---|---|
| 插件形态 | OpenCode **V1** 插件，入口 `export default { id, server }`；不做 V2 入口 |
| 插件 id | `opencode-skill-creator-zh`（与上游 `opencode-skill-creator` 不同，保证可共存） |
| 包名 | `@xiaoqiong0v0/opencode-skill-creator-zh` |
| 仓库 | `https://github.com/xiaoqiong0v0/opencode-skill-creator-zh` |
| 构建 | `tsc` 直出 `dist/`；`prebuild` 清 `dist/`；`dist/` 不入库 |
| 测试 | `node --test test/**/*.test.js`（对编译产物跑，测试文件为 `.js`） |
| 包内容 | `files: ["dist", "skill", "README.md"]`；包内技能只有 `skill/` 一份，与 `dist/` 平级 |
| 目录 | `src/`（含 `src/lib/`、`src/cli/`）、`test/`、`docs/`、`scripts/`、`templates/`、`skill/` |

## 3. 需求

### R1 只暴露 1 个工具（单点注册）

- 插件注册后工具列表里只新增 **1 项**：工具名 `skill_zh`。
- 上游 14 个工具（`skill_validate` / `skill_parse` / `skill_eval` / `skill_improve_description` / `skill_optimize_loop` / `skill_aggregate_benchmark` / `skill_generate_report` / `skill_serve_review` / `skill_stop_review` / `skill_export_static_review` / `skill_add_gold_standard` / `skill_list_gold_standards` / `skill_remove_gold_standard` / `skill_get_gold_advice`）**全部不再单独注册**。
- 入参 schema 只有一个字符串字段 `args`，不为每个子命令各开一套 typed args。
- 代码结构上，工具注册调用点**只有 1 处**（在 `src/index.ts`），其余能力由 `src/cli/` 的分发器调用 `src/lib/` 实现。

### R2 固定 6 个子命令

名称与顺序即 `help` 的展示顺序。

| 子命令 | 语义 | 必备行为 |
|---|---|---|
| `help` | 用法 | 无参数或 `help` 时返回完整用法 |
| `new` | 新建技能骨架 | 产出 `SKILL.md` + `references/`；目标目录已存在时拒绝覆盖，并提示 `--force` |
| `validate` | 校验技能目录 | 校验 `SKILL.md` 存在、frontmatter 合法、必填字段齐全、目录名与 `name` 一致、description 长度；`--strict` 时 description 长度与命名规范从提示升级为错误 |
| `eval` | 触发率评测 | 输出通过率、逐条 query 的触发结果、失败用例清单；benchmark 类汇总随评测输出一并给出 |
| `optimize` | 迭代改写 description | 训练/测试集切分，输出每轮通过率与最终 description |
| `package` | 导出技能目录 | **只导出目录**（不产出 npm 包），`--out <产物路径>` 必填；发布 npm 由用户手动执行 |

- 未知子命令 → 打印完整帮助 + 一行可执行改法。
- 子命令缺参 → 打印该子命令示例，不打印堆栈。
- 参数值非法（如 `--runs abc`、`--workers 0`）→ 指出允许取值，并给一条可直接照抄的正确命令。

### R3 `help` 覆盖度

- `help` 必须覆盖**全部 6 个子命令**，每个子命令至少 **1 个可复制执行的示例**。
- 断言方式：对 `HELP_TEXT` 做字符串检查，6 个子命令名与 6 条 `skill_zh <子命令>` 形式的示例行必须同时出现。

### R4 工具 description ≤ 60 字符

- 工具 `description` 按字符计（中文算 1 个）≤ **60**。
- 只写「做什么」，不写用法、不写参数说明；用法一律交给 `help`。
- 定稿值：`中文技能工坊：新建、校验、评测、优化并打包 OpenCode 技能`（33 字符）。

### R5 错误信息 = 可执行改法

错误输出统一三段式：

```
错误：<一句话说明哪里不对>
改法：<可复制执行的命令或明确的文件改动>
可用：skill_zh help
```

- 禁止输出原始异常堆栈、内部模块路径、英文错误码（调试开关除外，且须显式开启）。
- 必须落到三段式的 **4 类失败**（与 R7 枚举一致）：未知子命令 / 缺参 / 路径不存在 / 非法参数值。上游 `opencode` CLI 不可用、provider 未配置等执行期失败同样按三段式输出。

### R6 技能随包分发

- npm 包内唯一一份技能目录 `skill/`，与 `dist/` 平级；包内**不存在**第二份技能副本。
- 安装目标：`~/.config/opencode/skills/opencode-skill-creator-zh/`；技能 frontmatter `name` 与本包一致。
- 与上游英文技能（目录名 `opencode-skill-creator`）**共存**，互不覆盖。
- 决策依据与配套约束见 [design/技能打包决策.md](design/技能打包决策.md)。

配套约束（缺一不可）：

1. `files` 只含 `dist`、`skill`、`README.md`，源码与测试不入包；
2. 技能目录名 = 插件 id = frontmatter `name`，三者一致才能共存且被 OpenCode 发现；
3. 安装/升级只写目标技能目录，删除与覆盖限定在该目录内，不触碰其它技能目录；
4. 升级时保留用户对 `SKILL.md` 的改动（备份策略见 [installation.md](installation.md#升级)）。

### R7 工程门禁与自包含

- `tsc --noEmit` 零错误（全量类型标注，含 `test/`）。
- `npm test` 全绿，且测试覆盖 R1（注册点计数）、R3（help 覆盖度）、R4（description 长度）、R5（4 类失败的三段式）。
- `README.md`、`docs/`、`src/` 的用户可见文案**不引用其它技能目录**（要求 agent 去读别的技能、或把某步交给别的技能完成）；例外仅限「来源 / 许可」段落与上游移植说明。
- 包内技能只有一份（见 R6），`npm pack --dry-run` 可验证。

## 4. 验收方式

| 需求 | 验收命令 / 检查 |
|---|---|
| R1 | 加载插件后工具列表计数 = 1；`src/` 下工具注册调用点计数 = 1；14 个上游工具名在注册路径上 `grep` 无命中 |
| R2 | 6 个子命令逐个跑一遍，输出符合 R2 表格「必备行为」 |
| R3 | 断言 `HELP_TEXT` 含 6 个子命令名 + 6 条 `skill_zh <子命令>` 示例 |
| R4 | `[...TOOL_DESCRIPTION].length <= 60`，且文案与定稿值一致 |
| R5 | 触发「未知子命令 / 缺参 / 路径不存在 / 非法参数值」4 类失败，输出满足三段式 |
| R6 | `npm pack --dry-run` 列出 `dist/`、`skill/`、`README.md`；安装后技能目录名与插件 id 一致；与上游英文技能同时安装不冲突 |
| R7 | `npm run typecheck` 退出码 0；`npm test` 退出码 0；对 `README.md`、`docs/`、`src/` 搜跨技能引用措辞无命中（来源/许可段落除外） |

## 5. 非目标

- **不做英文版**：英文由上游维护，本仓只交付中文。
- **不改 OpenCode 的技能加载 / 发现机制**：技能落盘位置与加载规则沿用平台约定。
- **不重写上游已验证逻辑**：`src/lib/` 只做迁入与接线，不重构算法；确需改动须在 `docs/changes/` 留痕。
- **不注册 9 个非核心能力**：gold 样本管理（4 个）与评审查看器（3 个：起 / 停 / 导出）共 7 个不注册为工具、实现仍保留在 `src/lib/`；**benchmark 汇总与 HTML 报告**这 2 项并入 `eval` 的输出，不单独注册工具，也不单独开子命令。
- **不做 V2 入口**：只提供 V1 `export default { id, server }`。
