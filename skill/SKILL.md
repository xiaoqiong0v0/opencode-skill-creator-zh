---
name: opencode-skill-creator-zh
description: 创建、修改、打包 OpenCode 技能（skill / SKILL.md）时使用。当用户说「帮我建个技能 / 把这套流程做成技能 / 改 SKILL.md / 重写技能描述 / 优化技能触发 / 技能该触发没触发、帮我修技能描述和正文 / 跑技能触发评测 / 打包技能 / 技能目录结构怎么摆」，或要判断某件事该不该做成技能时使用。凡改动对象是某个技能的 SKILL.md 及其附属文件（含 description 的触发语料与边界），无论新建还是修补，都归本技能；description 要同时写清「做什么 + 何时触发（含用户真实说法）+ 不适用边界」，触发率用本工具的 `eval` 子命令实测。不适用：改业务代码、写技术文档、单纯使用某个技能完成任务。
---

# 技能创建（opencode-skill-creator-zh）

用于**创建新技能**并**迭代改进已有技能**。核心循环：

```
确认意图 → 调研 → 草稿 → 测试用例 → 双路运行（带技能 / 基线）
→ 评分与汇总 → 用户评审（按评分章节人工看产物）→ 按反馈改 → 重复 → 扩大测试集 → 打包安装
```

你的工作是判断用户处在这个循环的哪一步，然后接手推进。已有草稿就直接进「运行与评审」；只有一句「我想做个 X 技能」就从访谈开始。

## 1. 何时建技能（而不是写进提示词）

| 内容特征 | 去处 |
|---|---|
| 只在**特定场景**用到的多步流程、命令清单、条件分支、判定口径 | 技能（可被触发才加载） |
| 任何时刻都要生效的默认规则、身份与输出格式 | 提示词（AGENTS.md / agent 提示） |
| 纯事实知识、排查记录 | docs |

判据：需要「被触发」才有意义的 → 技能；永远在线的 → 提示词。技能正文只写规范与索引，细则放 `references/`。

## 2. 目录与文件结构

```
skill-name/
├── SKILL.md          必需：frontmatter（name、description）+ 正文
├── eval_set.json     评测集默认位置（格式见 4.3；可用 --eval-set 指定别的路径）
├── .evals/           评测报告与产物（运行 skill_zh eval 后生成）
└── 可选资源
    ├── scripts/      确定性重复操作的代码（可执行而不读入上下文）
    ├── references/   按需加载的参考资料
    ├── assets/       产出时使用的素材（模板、图标、字体）
    └── agents/       子代理说明文件（由 Task 工具驱动，见第 5 节）
```

- **渐进披露三层**：① metadata（name+description，永远在上下文，约 100 词）→ ② SKILL.md 正文（触发后在上下文，建议 <500 行）→ ③ 打包资源（按需读，不限量）。正文快超限时加一层目录并写清「接下来去哪读」。
- 目录名必须等于 frontmatter 的 `name`：kebab-case（`^[a-z0-9]+(-[a-z0-9]+)*$`，≤64 字符）。
- 单个 reference 文件 >300 行时加目录；支持多领域时按变体拆文件（如 `references/aws.md`、`gcp.md`），运行时只读需要的那份。
- **无意外原则**：技能内容不得包含恶意、越权、外传数据等令用户意外的东西；「扮演 XYZ」这类可以接受。

## 3. description（触发机制）

description 决定技能会不会被调用，是**唯一触发依据**：必须同时写清「做什么 + 何时触发（含用户真实说法语料）+ 不适用边界」。模型有**欠触发**倾向，要写得主动一些（列举别名、近义场景）。写法：一句话说清做什么与何时用，正文保持精简、细节放 `references/`；写完用 `eval` 子命令验证触发。

## 4. 从零到可用的步骤

### 4.1 捕捉意图（新技能的强制门禁）

访谈完成并经用户确认摘要之前，**不要**动笔写 SKILL.md 或测试用例。

- 当前对话可能已包含流程的一部分（如「把刚才这套做成技能」）：先提取（用到的工具、步骤顺序、被纠正的地方、输入输出、成功标准），再补问缺口。
- 至少问 3–5 个针对性问题（流程复杂则更多），覆盖：
  1. 端到端要让 OpenCode 做什么？
  2. 什么时候该触发？（真实说法、上下文、险些误触的场景）
  3. 输出格式与质量标准是什么？
  4. 哪些步骤必须原样保留，哪些允许模型即兴？
  5. 要不要建测试用例？输出客观可验证的（文件转换、数据提取、固定流程）适合建；主观的（文风、美术）一般不建。给出建议后由用户定。
- 用大白话复述你的理解，让用户确认或纠正后再继续。用户坚持跳过访谈：警告一次「成品质量与工作流贴合度会变差」，得到明确确认后尽力而为。

### 4.2 调研与草稿

- 主动追问边界情况、输入输出格式、示例文件、成功标准、依赖。以「影子同事」的姿态复刻用户的真实工作流、术语与交接点；这部分没敲定前不写测试 prompt。
- 可并行用子代理（explore/general）查文档、找相似技能，减少用户负担。
- **暂存位置**用临时目录而非当前仓库：`<系统临时>/opencode-skills/<skill-name>/`（Windows `%TEMP%`、Unix `/tmp`），避免技能开发期污染无关仓库；用户指定路径除外。

### 4.3 测试用例

草稿完成后，写 2–3 条**真实用户会说**的测试 prompt，先给用户过目再跑。存默认位置 `<技能目录>/eval_set.json`，格式为 `[{"query":"…","should_trigger":true|false}]`；需要别的路径时用 `skill_zh eval --eval-set <路径>`。用 `skill_zh new` 建的技能已有 2 正 1 负的骨架，直接把占位 `query` 换成真实说法即可（多余字段会被忽略）。此步只写 query 与 should_trigger，断言留到 4.4 起草；跑评测后报告与产物落 `<技能目录>/.evals/`。完整 schema（含 `expectations`/`assertions`）见 `references/schemas.md`。

### 4.4 运行双路对比（本节是一口气跑完的连续流程）

- 工作区放在暂存目录旁：`<skill-name>-workspace/iteration-N/eval-<ID>/{with_skill, without_skill 或 old_skill}/outputs/`，随用随建，不预先铺满。给每个 eval 起有含义的名字，目录名同名，并各写一份 `eval_metadata.json`（prompt + assertions，可先空）。
- **同一轮**为每个测试用例同时派出 with-skill 与 baseline 两个子代理任务，不要先跑完带技能再补基线。基线选择：新技能 → 完全不给技能（`without_skill`）；改进已有技能 → 编辑前先快照旧版（`cp -r` 到 workspace/skill-snapshot/），基线指向快照（`old_skill`）。
- 跑的过程中起草断言并向用户解释：断言要客观可验证、命名有描述性（人评时一眼看懂查的是什么）；主观质量不硬造断言。
- 每个子任务完成通知带 `total_tokens` 与 `duration_ms`，**立即**落盘为该 run 目录的 `timing.json`——这个数据过后拿不回来。通知到达一个处理一个，不要攒批。

### 4.5 评分、汇总、发起评审

硬门禁：每个 eval 必须有成对分支输出（with_skill + 基线）才能进评审；缺对时除非用户明确接受，不继续。

1. **评分**：按 `agents/grader.md` 派 grader 子代理（或少量内联评分），逐断言对照 transcript 与产物判定，写各 run 目录的 `grading.json`。字段名必须是 `text`/`passed`/`evidence`（下游一律按这三个名字读，改名会让已有产物对不上）。可编程检查的断言写脚本判定，不肉眼估。
2. **汇总**：本版未单独提供汇总工具——`skill_zh eval <技能目录>` 的输出已含通过率、逐条结果、失败用例与文本汇总（总通过率、按 `should_trigger` 分组、重复 query 分组），报告落在 `<技能目录>/.evals/` 下的 JSON；需要 `benchmark.json`/`benchmark.md` 时按 `references/schemas.md` 的字段手工整理（各配置的 pass_rate、时间、token，均值±标准差与差值）。
3. **分析师过一遍**：按 `agents/analyzer.md`「分析 Benchmark 结果」一节，找出聚合数字掩盖的模式（两边都恒过的无效断言、高方差疑似 flaky、时间/token 换收益）。
4. **人工评审**：本版未提供评审查看器（起 / 停 / 导出静态 HTML 都不注册为工具，`templates/eval-review.html` 随包但未接线）。需要人工评审时按本节评分标准逐条记下各 run 的产物观感与量化对比，汇总成 `feedback.json` 放回 workspace；不跑工具、也不自己另写评审页面。
5. 告诉用户怎么看、看完回来告诉你。

### 4.6 读反馈与迭代

- 读 `feedback.json`：空 feedback = 用户认为没问题；改进聚焦有具体抱怨的用例。
- **怎么想改进**：
  1. **泛化**：技能要服务千千万万次调用，不是在几个样例上过关。别打过拟合的补丁和高压的 MUST；顽固问题换比喻、换做法试试。
  2. **精简**：删不动脑子的内容；读 transcript 而不只看产物——技能让模型空转的段落就删掉再验证。
  3. **讲为什么**：全大写的 ALWAYS/NEVER 是黄旗，改为解释缘由让模型理解重要性。
  4. **找重复劳动**：几个用例都各自现写相似辅助脚本 → 该把脚本打包进 `scripts/` 并让技能引用。
- 改进后跑新一轮 `iteration-N+1/`（含基线），重复 4.4–4.6。停止条件：用户满意 / feedback 全空 / 不再有实质进展。之后可扩大测试集做更大规模验证。

## 5. 子代理分工

`agents/` 下三个文件是**派子代理时读的说明书**（经 Task 工具以 general 子代理执行），用到哪个读哪个：

| 子代理 | 干什么 | 何时启用 |
|---|---|---|
| `agents/grader.md` | 对照 transcript 与产物逐断言判 PASS/FAIL、提取并验证隐含 claim、反向批评测试用例本身 | 每轮迭代评分阶段（4.5 第 1 步） |
| `agents/comparator.md` | 盲评 A/B：不知来源地按 rubric 给两份产物打分定胜负 | 可选；用户要「新版真的更好吗」这类严格对比时 |
| `agents/analyzer.md` | 两种角色：盲评后「解盲」分析赢在哪、给落败方改进建议；或从 benchmark 数据找隐藏模式 | 配 comparator 用；或 4.5 第 3 步的聚合分析 |

多数场景人评循环够用，盲评系统（comparator+analyzer）是进阶可选项。

## 6. 触发优化与评测（指针）

技能完成后要验证/优化触发（生成 20 条语料并让用户过目 → `skill_zh eval <技能目录> [--runs N] [--workers N]` 实测 → `skill_zh optimize <技能目录> [--iterations N]` 按失败用例改写 description → 把 `best_description` 落回 frontmatter → 再跑一次 `skill_zh eval` 复核）：参数与示例见 `skill_zh help`。一个要点先记住：模型只给多步/专门任务查技能，太简单的一句话指令即使描述匹配也不会触发——语料要有实质内容。

`templates/eval-review.html` 是评测集审阅页模板，**随包提供但本版未接线**（没有生成 / 托管 / 导出的子命令）。需要可视化过目语料时，可手工读模板、替换其中 `__EVAL_DATA_PLACEHOLDER__`（JSON 数组，不加引号）、`__SKILL_NAME_PLACEHOLDER__`、`__SKILL_DESCRIPTION_PLACEHOLDER__`，写临时文件打开；否则直接在对话里把 20 条语料贴给用户过目。

## 7. 安装与登记

- 安装位置：项目级 `.opencode/skills/<name>/`（仅本项目）或全局 `~/.config/opencode/skills/<name>/`（所有项目）；目录名必须 = `name`。
- 本仓库自研技能走源仓流程：源文件放技能源仓（远程 `https://github.com/xiaoqiong0v0/opencode-skills`），改完 commit+push，再由配置仓 `python scripts/install/20-skills.py --force` 安装；直接改安装副本会被下次同步覆盖。
- 草稿与评测产物留在暂存区，只有验证过的最终目录才复制进安装位置。

## 8. 配套插件工具一览

本插件只暴露 1 个工具 `skill_zh`，入参是一个 `args` 字符串；下表是它**实际提供**的子命令（以 `skill_zh help` 为准）：

| 子命令 | 用途 |
|---|---|
| `skill_zh help` | 打印全部子命令与可复制示例（空参数等价） |
| `skill_zh new <技能名> [--dir <目录>] [--force]` | 按中文模板生成技能骨架（`SKILL.md` + `references/` + 可直接跑的最小 `eval_set.json`；`--force` 不覆盖已有评测集） |
| `skill_zh validate <技能目录> [--strict]` | 校验 SKILL.md 结构与 frontmatter（含 description 占位文案；`--strict` 把提示升级为错误） |
| `skill_zh eval <技能目录> [--runs N] [--workers N]` | 触发率评测：通过率、逐条结果、失败用例，报告写 `<技能目录>/.evals/` |
| `skill_zh optimize <技能目录> [--iterations N]` | 按评测失败反复改写 description（训练/测试集 6:4） |
| `skill_zh package <技能目录> --out <产物路径>` | 只导出可分发的技能目录 |
| `skill_zh install [--dry-run] [--force] [--dir <目标根>]` | 把包内技能装到用户级技能目录 |

本版**未注册**的上游能力（不要按旧名调用）：benchmark 汇总与 HTML 报告——本版只由 `skill_zh eval` 输出**文本汇总 + JSON 报告**，**HTML 查看器未提供**；评审查看器的起 / 停 / 导出静态 HTML（`templates/eval-review.html` 随包但未接线，需要人工评审时按第 4.5 节手工记录）；gold 样本管理（增 / 列 / 删 / 取建议）——如有需要，单独记录在正文的参考示例里。

## 9. 打包自检清单

- [ ] `skill_zh validate <技能目录>` 通过：frontmatter 只含允许字段、无含冒号未加引号的值、description ≤1024 字符且不含尖括号
- [ ] 目录名 = `name`（kebab-case）
- [ ] description 含触发语料与不适用边界；正文里的「见技能 X」指针都指向真实存在的技能
- [ ] SKILL.md <500 行；references 有「何时读」指引；超长 reference 带目录
- [ ] 无自引用旧名、无悬空文件引用；`scripts/` 内代码可运行且依赖已声明
- [ ] 内容符合无意外原则（无恶意/越权/外传数据）
- [ ] 已在 TodoList 记住「准备评测语料并让用户评审」这一步

再强调一遍核心循环：确认意图 → 草稿 → 双路运行 → 汇总+人评 → 迭代 → 扩测 → 验证后安装交付用户。
