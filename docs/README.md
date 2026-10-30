# opencode-skill-creator-zh 文档索引

OpenCode 中文技能工坊 —— npm 插件，只暴露 1 个 CLI 风格工具 `skill_zh`，覆盖技能的新建、校验、评测、优化与打包。

项目概览与安装速览见 [../README.md](../README.md)。

## 文档结构

| 文档 | 说明 |
|---|---|
| [SPEC.md](SPEC.md) | 需求与验收口径（R1–R7）：单工具、7 子命令、help 覆盖度、description 长度、错误三段式、技能入包与安装约束、工程门禁 |
| [ROADMAP.md](ROADMAP.md) | 实施批次 B0–B6，每批写明「内容 → 涉及文件 → 验收方式」；B0–B6 全部完成，CI 已补；npm 发布（`npm publish`）尚未执行 |
| [CONVENTIONS.md](CONVENTIONS.md) | 项目规范：目录约定、TypeScript 编译口径、注释、类型、导入分组、命名、测试、文档规则 |
| [tools.md](tools.md) | `skill_zh` 子命令参考：参数、输出示例、失败示例（三段式），逐个子命令一节 |
| [ASYNC.md](ASYNC.md) | `eval` / `optimize` 的异步与并发交互点清单：共享状态 · 保护手段 · 顺序契约 · 位置，含门禁表 |
| [installation.md](installation.md) | npm 安装、本地插件目录安装、技能安装位置与共存、卸载与回滚、升级 |
| [design/技能打包决策.md](design/技能打包决策.md) | 决策记录：「技能入包 vs 不入包」的对比、结论（入包）与 4 条配套约束 |
| [design/技能安装与目录问题.md](design/技能安装与目录问题.md) | 技能安装与目录的 6 条坑：现象 → 根因（带源码行号）→ 正确做法 → 验收方式，末尾是对实现的约束清单 |
| [design/技能评测隔离问题.md](design/技能评测隔离问题.md) | 评测隔离根与镜像的 6 条坑（含全局同名技能遮挡）+ 镜像方案**已定 C** 的决策记录 + 对实现的约束 J1–J9；与安装问题分开编号 |
| [design/上游携带缺陷台账.md](design/上游携带缺陷台账.md) | 继承自上游基线 `d4383924` 的 4 条已核实缺陷：现象 → 触发条件 → 影响 → 当前处置（保持与上游一致）→ 修复建议 → 修复后要改的用例；修复须单开批次 |

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
| 2026-10-29 | SPEC R2 未知子命令改走三段式（与 R5 统一）；R7 与 ROADMAP B1 的 `tsc` 覆盖范围改为只含 `src/`；测试命令改为 `node --test`；B1 脚本改 `prepack`；`SKILL_ZH_DEBUG` 顺延至 B3 | 文档与已落地实现不一致、且 R2 与 R5 自相矛盾，详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md) |
| 2026-10-29 | 新增 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)；SPEC 增 `R6.1`（I1–I5）；ROADMAP B5 补白名单拷贝/元数据外置/外部目录探测/大小写/用户改动保护；installation 重写「技能安装位置与共存」与升级口径；tools 补「package 只导出白名单内技能本体」 | 上游安装器整目录递归拷、元数据写进技能目录、只备份后覆盖；且「装到 `skills/` 就生效」与真实发现源不符。详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/installation.20261029.md](changes/installation.20261029.md)、[changes/技能打包决策.20261029.md](changes/技能打包决策.20261029.md) |
| 2026-10-29 | 新增第 7 个子命令 `install`（B5 实现，现有 6 个的断言与 R3 覆盖要求不变）；`~/.claude` 在扫描范围内的事实确定化；tools 加 `install` 一节；README 补「装到用户级目录 ≠ 一定生效」 | 启动钩子接不到 CLI 参数，冲突处置需要用户显式调子命令。详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md) |
| 2026-10-29 | 新增 [design/技能评测隔离问题.md](design/技能评测隔离问题.md)；SPEC 增 `R6.2`（J1–J9，含同名技能自动 deny、镜像范围已定方案 C）；ROADMAP B4 补隔离约束；tools 的 `eval` 加「隔离根与镜像范围」与「同名技能遮挡与自动 deny」 | 上游评测把项目 `.opencode/` 整目录 symlink 镜像、Windows 失败即递归整拷，根来自无边界向上找的 `findProjectRoot()`；且全局同名技能命中即中止、要用户先删自己的技能。详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/ROADMAP.20261029.md](changes/ROADMAP.20261029.md)、[changes/tools.20261029.md](changes/tools.20261029.md) |
| 2026-10-29 | 项目目录接入分发层：`src/tool.ts` 透传 `ToolContext.directory`/`worktree`，`dispatch(input, ctx)` 带 `ctx` 到 handler；J2 定稿为 `directory` → `worktree` → 三段式报错，禁止 `process.cwd()` 与向上查找（向上查找仅独立 CLI 兜底且排除 `~/.opencode`/`~/.config/opencode`）；tools 新增「路径解析基准」一节（相对路径按会话项目目录、绝对路径原样、技能可写任意目录） | B2 只读 `args`、丢掉 `context`，后续 eval 只能退回上游 `findProjectRoot()` 的 cwd 派生根，而这正是「子目录/临时目录跑评测用了错项目根」的根源；详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/ROADMAP.20261029.md](changes/ROADMAP.20261029.md)、[changes/tools.20261029.md](changes/tools.20261029.md)、[changes/技能评测隔离问题.20261029.md](changes/技能评测隔离问题.20261029.md) |
| 2026-10-29 | `install` 进入 `SUBCOMMANDS` 与 `HELP_TEXT`（3 条示例，标 B5 实现），占位 handler 返回「install 子命令尚未实现」三段式；SPEC R2/R3 与 §4 验收行、CONVENTIONS 子命令清单、tools help 行、installation 自检步骤统一为 **7 个子命令**，测试断言 7 个命令名 + 每个至少 1 条示例 | 规范写 7 个、`help` 只列 6 个、测试只测 6 个，三方不一致；`help` 是模型唯一自解释入口，命令不在其中就等于不存在。B5 因此只需换 handler，不再动文案与测试 |
| 2026-10-29 | B4 完成：`eval` / `optimize` 接真实现（全部选项与默认值、失败三段式、报告落盘）；SPEC `§4` 补 `R6.2-J4/J5/J7/J9` 与 `B4-eval` / `B4-optimize` 验收行；新增 [ASYNC.md](ASYNC.md)（并发交互点四要素 + 门禁表）；ROADMAP B4 标完成并写实测结论（256 例全绿、`cpSync` 门禁 0、可失败性验证通过） | 从「文档目标行为」转为「可运行实现」，同时把「评测隔离 J1–J9」落到代码与门禁；并发契约此前只散落在实现里，必须单独登记。详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/ROADMAP.20261029.md](changes/ROADMAP.20261029.md)、[changes/tools.20261029.md](changes/tools.20261029.md)、[changes/ASYNC.20261029.md](changes/ASYNC.20261029.md) |
| 2026-10-29 | `engines.node` 由 `>= 18` 改为 `>= 22.3`；SPEC `§2` 测试行与 CONVENTIONS `§2`/`§7`、ROADMAP B1、installation 前置条件、根 README 开发命令同步；SPEC `§4` 新增 **R7-Node** 验收行（engines 下限与 `test` 脚本的 Node flag 必须兼容） | `test` 已改用 `node --test --experimental-test-module-mocks`（22.3 才有的 flag），而 `engines` 仍声明 `>= 18`，老 Node 用户跑到测试就报未知参数。详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/CONVENTIONS.20261029.md](changes/CONVENTIONS.20261029.md)、[changes/ROADMAP.20261029.md](changes/ROADMAP.20261029.md)、[changes/installation.20261029.md](changes/installation.20261029.md) |
| 2026-10-29 | B5 完成：`package` / `install` 接真实现（白名单导出 / 安装、`--out` 校验、`--dry-run` / `--force` / `--dir`、元数据外置、同名技能探测、启动静默安装）；SPEC §4 补 I1–I5 与 `B5-package` / `B5-install` 验收行；tools 两节改为实际行为；ASYNC 新增「启动静默安装与显式 install」并发点 | 从「文档目标行为」转为「可运行实现」，并把安装器四类风险（整目录拷贝、元数据污染、装完不生效、覆盖用户改动）落成可失败断言；详见 [changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/ROADMAP.20261029.md](changes/ROADMAP.20261029.md)、[changes/tools.20261029.md](changes/tools.20261029.md)、[changes/installation.20261029.md](changes/installation.20261029.md)、[changes/ASYNC.20261029.md](changes/ASYNC.20261029.md) |
| 2026-10-29 | 终审文档修复：README / ROADMAP 状态改为「B0–B6 全部完成，发布链路未做」；README 子命令表补 `install`；`files` 口径五处统一为含 `templates`（SPEC §2/R6/§4、README、打包决策、ROADMAP）；ROADMAP B6 标完成并补实测（14 处旧工具名 → 0，7 子命令）与留痕 [changes/skill-SKILL.20261029.md](changes/skill-SKILL.20261029.md)；B5 用例数改「269 例，1 例时延断言满载时不稳定，待修」；删 installation 的 `XDG_CONFIG_HOME` 宣称并明确 `skills.urls` 不探测；tools 的 `help` 节选补 `install`、安装示例改 6 文件 | 文档口径落后于已落地代码（首页状态行、子命令清单缺 `install`、包内容清单缺 `templates/`），且用例数写成「全绿」掩盖了一例满载下偶发失败的时延断言；详见 [changes/README.20261029.md](changes/README.20261029.md)、[changes/ROADMAP.20261029.md](changes/ROADMAP.20261029.md)、[changes/SPEC.20261029.md](changes/SPEC.20261029.md)、[changes/tools.20261029.md](changes/tools.20261029.md)、[changes/installation.20261029.md](changes/installation.20261029.md)、[changes/技能打包决策.20261029.md](changes/技能打包决策.20261029.md) |
