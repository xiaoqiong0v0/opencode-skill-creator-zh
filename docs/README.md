# opencode-skill-creator-zh 文档索引

OpenCode 中文技能工坊 —— npm 插件，只暴露 1 个 CLI 风格工具 `skill_zh`，覆盖技能的新建、校验、评测、优化与打包。

项目概览与安装速览见 [../README.md](../README.md)。

## 文档结构

| 文档 | 说明 |
|---|---|
| [SPEC.md](SPEC.md) | 需求与验收口径（R1–R7）：单工具、6 子命令、help 覆盖度、description 长度、错误三段式、技能入包、工程门禁 |
| [ROADMAP.md](ROADMAP.md) | 实施批次 B0–B6，每批写明「内容 → 涉及文件 → 验收方式」；阶段 0（挂起旧仓）已完成 |
| [CONVENTIONS.md](CONVENTIONS.md) | 项目规范：目录约定、TypeScript 编译口径、注释、类型、导入分组、命名、测试、文档规则 |
| [tools.md](tools.md) | `skill_zh` 子命令参考：参数、输出示例、失败示例（三段式），逐个子命令一节 |
| [installation.md](installation.md) | npm 安装、本地插件目录安装、技能安装位置与共存、卸载与回滚、升级 |
| [design/技能打包决策.md](design/技能打包决策.md) | 决策记录：「技能入包 vs 不入包」的对比、结论（入包）与 4 条配套约束 |

## 文档之外

| 位置 | 内容 |
|---|---|
| `skill/` | 随 npm 包分发的中文技能（`SKILL.md` + `agents/` + `references/` + `templates/`），安装到 `~/.config/opencode/skills/opencode-skill-creator-zh/` |
| `docs/changes/` | 变更说明留痕目录（按需创建，规则见 [CONVENTIONS.md](CONVENTIONS.md#8-文档规则)） |

## 变更说明

本项目文档**默认就地改原文**，不留副本、不保留被替换的旧文本。只有满足下列之一时才在 `docs/changes/<原文档名>.<YYYYMMDD>.md` 记一条变更说明：

1. 推翻或反转既有结论 / 口径；
2. 改动被他人依赖的约定（工具名、子命令、输出格式、安装步骤）；
3. 改动全局规则或技能正文；
4. 用户明确要求留痕。

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-10-29 | 建立文档层：README、SPEC、ROADMAP、CONVENTIONS、tools、installation、design/技能打包决策 | 新仓首批只落文档与技能目录，代码骨架留待 B1–B5。同日复核后修正口径：`.tmp/old/` 记为 fork 中间态（仅 `plugin/lib/**` 对齐上游基线）、`package` 只导出目录且 `--out` 必填、未注册能力按 9 项计（benchmark 汇总与 HTML 报告并入 `eval` 输出）、错误统一 4 类 |
