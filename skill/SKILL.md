---
name: opencode-skill-creator-zh
description: 创建、修改、打包 OpenCode 技能（skill / SKILL.md）时使用。当用户说「帮我建个技能 / 把这套流程做成技能 / 改 SKILL.md / 重写技能描述 / 优化技能触发 / 技能该触发没触发、帮我修技能描述和正文 / 跑技能触发评测 / 打包技能 / 技能目录结构怎么摆」，或要判断某件事该不该做成技能时使用。凡改动对象是某个技能的 SKILL.md 及其附属文件（含 description 的触发语料与边界），无论新建还是修补，都归本技能；description 要同时写清「做什么 + 何时触发（含用户真实说法）+ 不适用边界」，触发率用本工具的 `eval` 子命令实测。不适用：改业务代码、写技术文档、单纯使用某个技能完成任务。
---

# 技能创建（opencode-skill-creator-zh）

用于**创建新技能**并**迭代改进已有技能**。核心循环：

```
确认意图 → 调研 → 草稿 → 测试用例 → 双路运行（带技能 / 基线）
→ 评分与汇总 → 用户评审（查看器）→ 按反馈改 → 重复 → 扩大测试集 → 打包安装
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
└── 可选资源
    ├── scripts/      确定性重复操作的代码（可执行而不读入上下文）
    ├── references/   按需加载的参考资料
    ├── assets/       产出时使用的素材（模板、图标、字体）
    ├── agents/       子代理说明文件（由 Task 工具驱动，见第 5 节）
    └── evals/        测试用例 evals.json
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

草稿完成后，写 2–3 条**真实用户会说**的测试 prompt，先给用户过目再跑。存 `evals/evals.json`，此步只写 prompt 与预期描述，断言留到 4.4 起草。完整 schema（含 `expectations`/`assertions`）见 `references/schemas.md`。

### 4.4 运行双路对比（本节是一口气跑完的连续流程）

- 工作区放在暂存目录旁：`<skill-name>-workspace/iteration-N/eval-<ID>/{with_skill, without_skill 或 old_skill}/outputs/`，随用随建，不预先铺满。给每个 eval 起有含义的名字，目录名同名，并各写一份 `eval_metadata.json`（prompt + assertions，可先空）。
- **同一轮**为每个测试用例同时派出 with-skill 与 baseline 两个子代理任务，不要先跑完带技能再补基线。基线选择：新技能 → 完全不给技能（`without_skill`）；改进已有技能 → 编辑前先快照旧版（`cp -r` 到 workspace/skill-snapshot/），基线指向快照（`old_skill`）。
- 跑的过程中起草断言并向用户解释：断言要客观可验证、命名有描述性（查看器里一眼看懂查的是什么）；主观质量不硬造断言。
- 每个子任务完成通知带 `total_tokens` 与 `duration_ms`，**立即**落盘为该 run 目录的 `timing.json`——这个数据过后拿不回来。通知到达一个处理一个，不要攒批。

### 4.5 评分、汇总、发起评审

硬门禁：每个 eval 必须有成对分支输出（with_skill + 基线）才能进评审；缺对时除非用户明确接受，不继续。

1. **评分**：按 `agents/grader.md` 派 grader 子代理（或少量内联评分），逐断言对照 transcript 与产物判定，写各 run 目录的 `grading.json`。字段名必须是 `text`/`passed`/`evidence`，查看器依赖这些名字。可编程检查的断言写脚本判定，不肉眼估。
2. **汇总**：`skill_aggregate_benchmark` 生成 `benchmark.json`/`benchmark.md`（各配置的 pass_rate、时间、token，均值±标准差与差值）。手工构造 benchmark.json 先核对 `references/schemas.md`。
3. **分析师过一遍**：按 `agents/analyzer.md`「分析 Benchmark 结果」一节，找出聚合数字掩盖的模式（两边都恒过的无效断言、高方差疑似 flaky、时间/token 换收益）。
4. **查看器**：用 `skill_serve_review`（iteration 2+ 传 `previousWorkspace`；省略 benchmarkPath 会自动汇总；默认 `allowPartial: false` 严格配对）。无头环境用 `skill_export_static_review` 导出独立 HTML，用户点「提交」下载 `feedback.json` 后复制回 workspace。「Outputs」页逐条看产物并留反馈，「Benchmark」页看量化对比；用完后 `skill_stop_review` 停服务。不要自己写查看 HTML。
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

技能完成后要验证/优化触发（生成 20 条语料、用 `templates/eval-review.html` 给用户过目、跑 `optimize` / `eval` 子命令、把 `best_description` 落回 frontmatter）：流程与参数见本工具 `help`。一个要点先记住：模型只给多步/专门任务查技能，太简单的一句话指令即使描述匹配也不会触发——语料要有实质内容。

`templates/eval-review.html` 用法：读模板，替换 `__EVAL_DATA_PLACEHOLDER__`（JSON 数组，不加引号）、`__SKILL_NAME_PLACEHOLDER__`、`__SKILL_DESCRIPTION_PLACEHOLDER__`，写临时文件打开；用户编辑后点「导出评测集」得到 `eval_set.json`。

## 7. 安装与登记

- 安装位置：项目级 `.opencode/skills/<name>/`（仅本项目）或全局 `~/.config/opencode/skills/<name>/`（所有项目）；目录名必须 = `name`。
- 本仓库自研技能走源仓流程：源文件放技能源仓（远程 `https://github.com/xiaoqiong0v0/opencode-skills`），改完 commit+push，再由配置仓 `python scripts/install/20-skills.py --force` 安装；直接改安装副本会被下次同步覆盖。
- 草稿与评测产物留在暂存区，只有验证过的最终目录才复制进安装位置。

## 8. 配套插件工具一览

| 工具 | 用途 |
|---|---|
| `skill_validate` | 校验 SKILL.md 结构与 frontmatter |
| `skill_parse` | 解析 SKILL.md，返回 name/description/正文 |
| `eval` 子命令 | 触发率评测（跑评测集，统计命中率） |
| `skill_improve_description` | 按评测失败改进 description |
| `skill_optimize_loop` | 完整「评测→改进」循环（train/test 切分） |
| `skill_aggregate_benchmark` | 汇总各 run 的 grading.json 为 benchmark |
| `skill_generate_report` | 生成优化过程 HTML 报告 |
| `skill_serve_review` / `skill_stop_review` | 起/停评审查看器 |
| `skill_export_static_review` | 无头环境导出独立评审 HTML |

## 9. 打包自检清单

- [ ] `skill_validate` 通过：frontmatter 只含允许字段、无含冒号未加引号的值、description ≤1024 字符且不含尖括号
- [ ] 目录名 = `name`（kebab-case）
- [ ] description 含触发语料与不适用边界；正文里的「见技能 X」指针都指向真实存在的技能
- [ ] SKILL.md <500 行；references 有「何时读」指引；超长 reference 带目录
- [ ] 无自引用旧名、无悬空文件引用；`scripts/` 内代码可运行且依赖已声明
- [ ] 内容符合无意外原则（无恶意/越权/外传数据）
- [ ] 已在 TodoList 记住「建 evals JSON 并起查看器让用户评审」这一步

再强调一遍核心循环：确认意图 → 草稿 → 双路运行 → 汇总+人评 → 迭代 → 扩测 → 验证后安装交付用户。
