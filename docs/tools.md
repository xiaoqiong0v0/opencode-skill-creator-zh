# skill_zh 子命令参考

[项目概览](../README.md) · [安装](installation.md) · [需求与验收](SPEC.md)

本插件只暴露 **1 个工具** `skill_zh`，入参只有一个 `args` 字符串。工具 description 为 `中文技能工坊：新建、校验、评测、优化并打包 OpenCode 技能`（33 字符），参数细节全部交给 `skill_zh help`。

> 当前状态：B0–B6 完成——7 个子命令均接真实现。相对路径的解析基准见下节「路径解析基准」。

## 通用约定

| 约定 | 说明 |
|---|---|
| 入参 | 单个 `args` 字符串，如 `"validate ./skills/demo"`；空字符串等同 `help` |
| 分词 | 参数以空格分隔；路径含空格用双引号包裹，如 `validate "D:/my skills/demo"` |
| 选项形式 | `--flag value` 与 `--flag=value` 等价；布尔选项只写 `--flag` |
| 路径基准 | 相对路径按**当前会话的项目目录**解析（见下节「路径解析基准」）；工具参数是文件系统路径，不是 shell 命令 |
| 输出 | 纯文本，直接回给模型；失败也返回文本，不抛原始堆栈 |
| 失败格式 | 统一三段式：`错误：` / `改法：` / `可用：skill_zh help` |
| 调试 | `SKILL_ZH_DEBUG=1` 输出执行细节到 stderr（评测镜像清单 / 跳过原因、同名技能屏蔽路径等）；默认不外泄内部路径与堆栈。日志另有 `SKILL_ZH_LOG_DISABLE=1` 关闭、`~/.config/opencode/plugin-logger.jsonc` 的 `enabled` 打开 |
| shell 入口 | `skill-zh`（npm bin）与本工具共用同一套子命令；argv 按 token 解析（含空格路径由 shell 引号处理），成功写 stdout / 退出码 0，失败写 stderr / 退出码 1；输出里的 `skill_zh` 归一成 `skill-zh`，可直接照抄 |
| shell 目录基准 | 独立 CLI 用 `process.cwd()` 作项目目录，**不向上查找**；cwd 位于 `~/.config/opencode` / `~/.opencode`（含子树）时警告到 stderr 但继续执行 |

失败输出模板：

```
错误：<一句话说明哪里不对>
改法：<可复制执行的命令或明确的文件改动>
可用：skill_zh help
```

## 路径解析基准

所有子命令的路径都按同一条规则解析，`skill_zh` 不猜项目在哪：

| 情形 | 行为 |
|---|---|
| 相对路径（`./skills/demo`、`skills/demo`） | 按**当前会话的项目目录**解析——即 OpenCode 传进来的 `ToolContext.directory`；它为空时用 `worktree`（工作树根） |
| 绝对路径（`D:/work/proj/skills/demo`、`/home/me/proj/skills/demo`） | 原样使用，不做任何拼接 |
| 目录拿不到（`directory` 与 `worktree` 都为空） | 三段式报错 `错误：拿不到当前项目目录`，改法为「在 opencode 会话内重试，或显式传绝对路径」 |
| 路径不存在 | 三段式报错，改法里给出可复制命令与建议路径 |

两条硬口径（对应 SPEC `R6.2` 的 J2）：

- **插件与分发层不用 `process.cwd()` 推断项目根，不做向上查找**。上游 `findProjectRoot()` 从 cwd 一路向上，命中 `.opencode/` 就返回——在 home 之下调用时会把 `~/.opencode`（opencode 的运行时目录：缓存、插件数据、`skills/`）判成项目根，于是评测镜像了错的项目、结果不可信。本版不复刻这条路径。独立 CLI（bin `skill-zh`，进程里没有 `ToolContext`）只把 `process.cwd()` 当项目目录、**同样不向上查找**；cwd 位于 `~/.opencode` / `~/.config/opencode` 时警告到 stderr 但继续执行。
- **技能可以写在任意目录**：`skill_zh` 不要求技能必须在 `.opencode/skills/` 下，只要路径给对（相对或绝对）就行。`validate` / `eval` / `optimize` / `package` 都接收任意目录；只有涉及「项目里可见哪些技能」的评测画像才与项目根有关。

## skill_zh help

> shell 等价：`skill-zh help`（或直接运行 `skill-zh`）

打印完整用法：7 个子命令说明 + 每个子命令至少 1 条可复制示例。

| 参数 | 必填 | 说明 |
|---|---|---|
| 无 | — | `skill_zh` 与 `skill_zh help` 等价 |

输出示例（节选，实际以 `HELP_TEXT` 为准）：

```text
skill_zh —— 中文 OpenCode 技能创建工具（CLI 风格单工具）

子命令：
  help      显示本帮助，覆盖全部子命令与示例
  new       按中文模板生成技能骨架（SKILL.md + references/），--force 覆盖前留 .bak
  validate  校验 SKILL.md 结构与 frontmatter，--strict 把长度/命名提示升级为错误
  eval      跑触发率评测，输出通过率、逐条结果与失败用例
  optimize  按评测失败反复改写 description（训练/测试集 6:4 切分）
  package   只导出白名单内的技能目录（--out 必填，不产出 npm 包）
  install   把包内技能装到用户级技能目录（默认不覆盖本地改动）

示例：
  skill_zh new api-doc-writer --dir ./skills
  skill_zh validate ./skills/api-doc-writer
  ...
  skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
  skill_zh install --dry-run
```

失败示例（未知子命令：恰好三行，改法里列出全部可用子命令）：

```text
错误：未知子命令 "validat"
改法：可用子命令：help / new / validate / eval / optimize / package / install
可用：skill_zh help
```

## skill_zh new

> shell 等价：`skill-zh new <技能名> --dir <目录> [--force]`

按中文模板（仓库 `templates/`）生成技能骨架：`<技能名>/SKILL.md` + `<技能名>/references/` + `<技能名>/eval_set.json`。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能名>` | 是 | — | 必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` 且 ≤ 64 字符；同时作为目录名与 frontmatter `name` |
| `--dir <目录>` | 否 | 当前会话项目目录 | 父目录，不存在则创建；相对路径按「路径解析基准」一节解析 |
| `--force` | 否 | 关 | 目标目录已存在且非空时允许覆盖：重写 `SKILL.md` 与 `references/示例.md`（各留一份 `.bak`，输出点名「已备份：…」），不动用户自建文件；**已存在的 `eval_set.json` 一律保留**（评测集是用户资产，不覆盖、不备份） |

目标目录已存在且**非空**时默认拒绝（空目录可直接生成）。生成的三样东西：

- `SKILL.md`：`description` 是带引号的 TODO 占位（`TODO: 用一句话写清做什么 + 何时触发 + 不适用，≤ 60 字符`）——`validate` 会提示、`--strict` 判失败，改完才算完成；
- `references/示例.md`：开头写明「何时读本文件」；
- `eval_set.json`：**可直接跑**的最小评测集（2 条应触发 + 1 条不应触发），`query` 仍是 TODO 占位，`_comment` 键写改法（`eval` 只读 `query` / `should_trigger`，多余键忽略）——不必先手写评测集就能 `eval` 一次。

输出示例：

```text
已生成技能骨架：./skills/api-doc-writer
  SKILL.md               （frontmatter：name、description 占位，正文为待填大纲）
  references/示例.md      （按需加载的参考资料，文件开头写明何时读）
  eval_set.json          （2 正 1 负的可跑评测集骨架，query 仍是 TODO 占位）
下一步：
  1. 编辑 ./skills/api-doc-writer/SKILL.md，把 description 的 TODO 换成「做什么 + 何时触发 + 不适用」
  2. 编辑 ./skills/api-doc-writer/eval_set.json，把 3 条 query 换成针对本技能的真实说法
  3. 运行 skill_zh validate ./skills/api-doc-writer --strict 复核结构（占位未改完会判失败）
  4. 运行 skill_zh eval ./skills/api-doc-writer --runs 1 试跑评测（调用 opencode，会产生费用）
```

`--force` 时已存在评测集的输出（结构检查与备份行为同上，评测集原样保留）：

```text
已生成技能骨架：./skills/api-doc-writer
  SKILL.md               （frontmatter：name、description 占位，正文为待填大纲）
  references/示例.md      （按需加载的参考资料，文件开头写明何时读）
  eval_set.json          （已存在，保留原评测集未覆盖）
  已备份：./skills/api-doc-writer/SKILL.md.bak
  已保留：./skills/api-doc-writer/eval_set.json（未覆盖已有评测集）
```

失败示例（目标已存在）：

```text
错误：目标目录已存在且非空，未覆盖：./skills/api-doc-writer
改法：换一个技能名，或运行 skill_zh new api-doc-writer --dir ./skills --force（覆盖前会把旧 SKILL.md 备份为 SKILL.md.bak）
可用：skill_zh help
```

失败示例（技能名不合法）：

```text
错误：技能名不是 kebab-case：ApiDoc_Writer（只允许小写字母、数字与单个连字符）
改法：改用 kebab-case 名重试，例如 skill_zh new api-doc-writer --dir ./skills
可用：skill_zh help
```

## skill_zh validate

> shell 等价：`skill-zh validate <技能目录> [--strict]`

校验技能目录：`SKILL.md` 是否存在、frontmatter 是否合法、必填字段是否齐全、目录名与 `name` 是否一致、description 长度是否在限内、description 是否仍是模板占位。

| 参数 | 必填 | 说明 |
|---|---|---|
| `<技能目录>` | 是 | 含 `SKILL.md` 的目录 |
| `--strict` | 否 | 把全部「提示」升级为「错误」（判失败）：description 长度、命名规范、description 仍是占位文案；缺省只提示、不影响「通过」结论 |

每条问题都给 `问题：` + `文件:行`（能定位时）+ `改法：`，改法可直接照做；**同一目录的多处问题一次报全**（不是只报第一条），错误与提示分开计数、一并输出（不必先修完错误再跑一次才看见提示）。结论有两种：`通过` / `未通过（N 处错误[, M 处提示]）`；通过时同时输出 description 实际字符数。

**占位文案判据**（只查 `description`，不查正文，且**只认占位形态**）：① description **开头**就是 `TODO` / `待填` 加冒号（半角 `:` 或全角 `：`，大小写不敏感）；② description **整体等于**模板占位原文 `TODO: 用一句话写清做什么 + 何时触发 + 不适用，≤ 60 字符`。中间出现 `TODO` / `待填` 一律不算——`管理 TODO 清单，支持增删改查`、`处理等待填写的审批表单` 都是合法 description，`--strict` 下照常通过。级别是**提示**，所以 `new` 出来的骨架 `validate` 通过但带 1 条提示，`validate --strict` 判失败。

输出示例（通过）：

```text
校验 ./skills/api-doc-writer：通过
  name         api-doc-writer（与目录名一致）
  description  118 字符（上限 1024）
```

输出示例（description 超长，缺省只提示）：

```text
校验 ./skills/api-doc-writer：通过
  name         api-doc-writer（与目录名一致）
  description  1030 字符（上限 1024）
提示（1 处，缺省不判失败；加 --strict 会判失败）：
  [提示 1] 问题：description 超长：1030 字符，上限 1024 字符
           文件：./skills/api-doc-writer/SKILL.md:3
           改法：把细则移到正文或 references/，description 只保留「做什么 + 何时触发 + 不适用边界」
```

失败示例（同一份目录加 `--strict`）：

```text
校验 ./skills/api-doc-writer：未通过（1 处错误）
  [错误 1] 问题：description 超长：1030 字符，上限 1024 字符
           文件：./skills/api-doc-writer/SKILL.md:3
           改法：把细则移到正文或 references/，description 只保留「做什么 + 何时触发 + 不适用边界」
```

输出示例（description 仍是占位，缺省只提示）：

```text
校验 ./skills/api-doc-writer：通过
  name         api-doc-writer（与目录名一致）
  description  36 字符（上限 1024）
提示（1 处，缺省不判失败；加 --strict 会判失败）：
  [提示 1] 问题：description 仍是占位文案（命中「TODO」），不是该技能的真实触发说明
           文件：./skills/api-doc-writer/SKILL.md:3
           改法：把 ./skills/api-doc-writer/SKILL.md 的 description 换成「做什么 + 何时触发（含用户真实说法）+ 不适用边界」，再运行 skill_zh validate --strict 复核
```

失败示例（同一份骨架加 `--strict`）：

```text
校验 ./skills/api-doc-writer：未通过（1 处错误）
  [错误 1] 问题：description 仍是占位文案（命中「TODO」），不是该技能的真实触发说明
           文件：./skills/api-doc-writer/SKILL.md:3
           改法：把 ./skills/api-doc-writer/SKILL.md 的 description 换成「做什么 + 何时触发（含用户真实说法）+ 不适用边界」，再运行 skill_zh validate --strict 复核
```

失败示例（同时有错误与提示：一次列全）：

```text
校验 ./skills/api-doc-writer：未通过（2 处错误，1 处提示）
  [错误 1] 问题：frontmatter 缺少必填字段 name
           文件：./skills/api-doc-writer/SKILL.md
           改法：在 ./skills/api-doc-writer/SKILL.md 的 frontmatter 里加一行 name: api-doc-writer（小写 kebab-case，与目录名一致）
  [错误 2] 问题：目录名与 frontmatter name 不一致：目录 api-doc-writer，name api-doc-writer-zh
           文件：./skills/api-doc-writer/SKILL.md
           改法：把目录重命名为 api-doc-writer-zh，或把 ./skills/api-doc-writer/SKILL.md 的 name 改为 api-doc-writer
  [提示 1] 问题：name「ApiDoc_Writer」不是 kebab-case（只允许小写字母、数字与单个连字符）
           改法：把 name 改成全小写、单词间用单个连字符的形式（例如 apidoc-writer）
```

失败示例（路径不存在；目录名不是 kebab-case 时改法不推荐用这个非法名新建）：

```text
错误：技能目录不存在：./skills/api-doc
改法：确认目录名拼写，或运行 skill_zh new api-doc --dir ./skills 新建一个
可用：skill_zh help
```

## skill_zh eval

> shell 等价：`skill-zh eval <技能目录> [--runs N] [--workers N] …`（长评测放独立终端跑，不占 OpenCode 会话）

跑触发率评测：按技能目录下的评测集把每条 query 交给被测模型，统计技能是否被选中，输出通过率、逐条结果、失败用例、文本汇总（按 `should_trigger` 分组、重复 query 分组）、镜像汇总与报告路径。本版只输出**文本汇总 + JSON 报告**；HTML 查看器未提供。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 含 `SKILL.md` 的技能目录；技能可放在任意位置，相对路径按「路径解析基准」一节解析 |
| `--runs <N>` | 否 | `1` | 每条 query 的重复次数，必须是正整数 |
| `--workers <N>` | 否 | `1` | 并发数，必须是正整数；按 provider 限额与预算调大 |
| `--timeout <ms>` | 否 | `120000` | 单次 `opencode run` 的超时（毫秒），必须是正整数 |
| `--model <provider/model>` | 否 | `opencode` 默认模型 | 传给评测子进程 |
| `--agent <名称>` | 否 | `build` | 传给评测子进程的 agent（需暴露技能工具事件） |
| `--eval-set <路径>` | 否 | `<技能目录>/eval_set.json` | 评测集文件；相对路径按当前会话项目目录解析 |
| `--log-dir <路径>` | 否 | `<技能目录>/.evals` | 报告目录；每次评测写一份 JSON（文件名带时间戳 + 随机后缀，不会互相覆盖） |
| `--no-shadow-guard` | 否 | 关 | 关闭「同名技能自动屏蔽」；关闭后只要发现同名技能就中止（见下节） |

评测**会产生费用**：`eval` 调用的是真实的 `opencode run`，需要可用的 provider 与模型。

评测集格式（JSON 数组，`query` 非空字符串、`should_trigger` 必须是布尔值；空数组、非数组、坏 JSON 都按三段式失败）：

```json
[
  { "query": "帮我把这套发布流程做成技能", "should_trigger": true },
  { "query": "写一段生日邀请函", "should_trigger": false }
]
```

多余字段（例如 `new` 骨架里的 `_comment`）会被忽略，可以放心写备注；`query` / `should_trigger` 仍必须齐备。

输出示例：

```text
评测 ./skills/api-doc-writer：通过率 0.50（1/2，每条 2 次，阈值 0.5）
逐条结果：
  ✓ 应触发 1.00（2/2）「帮我把这套发布流程做成技能」
  ✗ 不应触发 1.00（2/2）「写一段生日邀请函」
失败用例：
  不应触发却触发（1）
    - 「写一段生日邀请函」 命中 2/2
汇总：
  总通过率 0.50（1/2），失败 1 条；原始触发率 1.00 ± 0.00（诊断用，非通过率）
  应触发：1 条，通过 1（1.00），失败 0；原始触发率 1.00 ± 0.00（诊断用，非通过率）
  不应触发：1 条，通过 0（0.00），失败 1；原始触发率 1.00 ± 0.00（诊断用，非通过率）
  重复 query：无
镜像：3 个条目，链接镜像（跳过 0 项）
报告：./skills/api-doc-writer/.evals/eval-2026-10-29T10-00-00-000Z-1a2b.json
下一步：skill_zh optimize ./skills/api-doc-writer --iterations 3（按失败用例改写 description）
```

汇总里两种数字口径不同，别混着读：

| 字段 | 含义 | 是否参与结论 |
|---|---|---|
| 总通过率 / 分组通过率 | `pass` 判定（`should_trigger=true` 要求被触发、`false` 要求不被触发） | **是**，成绩 |
| 原始触发率 | 按极性分别统计「实际被触发」的比例（均值 ± 标准差）；**两组都要看方向**：应触发组越高越好，不应触发组越低越好（1.00 = 全被触发） | 否，**诊断用**：看模型是否偏向触发某一侧 |

失败示例（缺少技能目录）：

```text
错误：缺少参数 <技能目录>
改法：运行 skill_zh eval ./skills/my-skill（技能目录里要有 SKILL.md）
可用：skill_zh help
```

失败示例（评测集缺失）：

```text
错误：评测集不存在：./skills/api-doc-writer/eval_set.json
改法：在技能目录下新建 eval_set.json，写入 [{"query":"…","should_trigger":true}] 形式的 JSON 数组
可用：skill_zh help
```

失败示例（非法参数值）：

```text
错误：参数 --runs 非法：abc（只接受正整数）
改法：改用正整数，例如 skill_zh eval ./skills/api-doc-writer --runs 3
可用：skill_zh help
```

### 隔离根与镜像范围

评测不会在你的项目里跑，而是在系统临时目录下建一个隔离根 `evalRoot`，把被测技能合成进去再跑 `opencode run`——否则 `opencode` 会按 `$PWD` 加载项目里**同名的真实技能**，命中被记到真身身上，结果恒为 0。

**镜像范围已定（方案 C，2026-10-29）**：隔离根 = 下面四项，不多不少。

| # | 镜像什么 | 为什么必须有 |
|---|---|---|
| ① | 合成技能本体 `evalRoot/.opencode/skills/<基础名>-skill-<随机 id>/SKILL.md` | 本次评测的被测对象，只认这个技能的触发 |
| ② | 项目根 `opencode.json` / `opencode.jsonc` **及其引用文件** | 丢了会丢 provider / agent / model 与项目指令，评测失真 |
| ③ | `.opencode/` 下**除 `skills` 外的全部条目**（配置、agent、command、plugin 等） | 同上：这是配置面，缺一项就可能改变模型行为 |
| ④ | `.opencode/skills/` 下**除被测技能外的兄弟技能** | 真实使用时模型是在「本项目全部技能」里挑，去掉它们只会让分数虚高 |

不镜像的：被测技能本体、它的祖先目录、`skills` 根自身、指向 `skills` 的别名（会被真实路径判定拦掉）；项目里的 `src/`、`dist/`、`node_modules/`、`.git/` 等一律不进。

三条硬约束（SPEC `R6.2` 的 J1/J2/J3/J9）：

- **不整目录递归拷贝**：镜像一律逐条目/逐文件，并有 **2 MiB** 单文件大小上限；符号链接创建失败时（Windows 非开发者模式常见）也只逐文件拷已知条目——技能目录只放行 `SKILL.md`、`agents/**`、`references/**`、`templates/**`，`node_modules/`、`dist/`、`.git/` 与超限文件跳过。源码门禁：`grep -rn "cpSync(.*recursive" src/` 命中数 = 0。
- **项目根不靠向上瞎找**：插件只在调用方传入的上下文里取（`ToolContext.directory` → `worktree`，都空则三段式报错）；独立 CLI（bin `skill-zh`）只把 `process.cwd()` 当 `directory`，**同样不向上查找**；cwd 位于 `~/.opencode` / `~/.config/opencode`（含子树）时警告到 stderr 但继续执行。（原「独立 CLI 向上查找、校验项目形态」口径已废弃。）
- **被测技能本体不泄漏**：本体、其祖先目录、`skills` 根自身、指向 `skills` 的别名都不会被镜像进来（按真实路径判定，绕不过去）。

> 方案 C 的取舍：分数最接近真实使用，但与项目强耦合（换个项目分数会变，跨项目不可比）；输出里会注明本次镜像了多少条目。
>
> 调试开关 `SKILL_ZH_DEBUG=1` 打开后，会逐条打印镜像了哪些条目（相对路径、类型、字节数）与哪些被跳过（含原因）；默认只输出一行汇总。临时隔离根在评测结束（含报错与取消）后删除。

### 同名技能遮挡与自动 deny

评测跑的是合成技能 `<基础名>-skill-<随机 id>`，只把这个名字的触发算命中。但**全局技能不会被隔离**：`opencode` 子进程的 `HOME` / `XDG_CONFIG_HOME` 沿用你的环境，装在 `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills` 里的同名技能照样在候选集里；模型若选中旧的那个，合成技能就是 0 命中（假阴性）。

本版的处理是**不改你的任何目录，只改隔离根**：评测前枚举可见技能，一旦发现与被测技能同名（基础名相同），就在 `evalRoot` 的 `.opencode/opencode.json` 写 `permission.skill.<基础名> = "deny"`（与已镜像的配置合并；若目标是指向源文件的符号链接，先摘链再写），让旧技能在**本次评测的子进程里**不可见。所以「评测一个已经装好的技能」不再需要先删掉它或给它改名。

| 情况 | 行为 |
|---|---|
| 发现了同名技能 | 自动写 deny，评测继续；调试开关下打印被屏蔽的实际路径 |
| deny 写不进，或目标版本不支持按名 deny | **不跑**，按三段式失败：「改法」给出冲突的实际路径与一条可直接复制的处置命令（不静默放行） |
| 枚举可见技能失败（`opencode debug skill` 不可用等） | 同样**不跑**，按三段式失败 |
| 想保持旧技能在场做对照 | 加 `--no-shadow-guard`：不写 deny，检测到同名即中止（回到「先处理环境再评测」的老行为） |

> 该屏蔽只在本次评测的临时隔离根里生效，评测结束随隔离根一起删除。deny 配置**不读写用户其它技能目录与全局配置**；评测报告默认写 `<技能目录>/.evals`（可用 `--log-dir` 改到别处），这是本命令唯一的持久化写入点。

## skill_zh optimize

> shell 等价：`skill-zh optimize <技能目录> [--iterations N] [--runs N] [--workers N] …`

按评测失败迭代改写 description：先按位置切分训练/测试集（**6:4**），每轮用训练集失败模式改写描述、再用测试集评估，输出每轮通过率与最终 description。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 同 `eval` |
| `--iterations <N>` | 否 | `5` | 最大迭代轮数，必须是正整数；训练集全通过可提前结束 |
| `--runs <N>` | 否 | `1` | 每条 query 的重复次数，必须是正整数 |
| `--workers <N>` | 否 | `1` | 并发数，必须是正整数 |
| `--timeout <ms>` | 否 | `120000` | 单次 `opencode run` 的超时（毫秒） |
| `--model <provider/model>` | 否 | `opencode` 默认模型 | 同时用于评测与改写子进程 |
| `--agent <名称>` | 否 | `build` | 评测子进程使用的 agent |
| `--eval-set <路径>` | 否 | `<技能目录>/eval_set.json` | 评测集文件 |
| `--log-dir <路径>` | 否 | `<技能目录>/.evals` | 报告根目录；每次运行在其下建独立子目录（见下方「产物」） |
| `--no-shadow-guard` | 否 | 关 | 关闭同名技能自动屏蔽（同 `eval`） |

产物：每次运行落一个独立子目录 `<logDir>/optimize-<时间戳>-<随机后缀>/`，内含：

| 文件 | 内容 |
|---|---|
| `optimize-report.html` | 每轮自动刷新的实时报告 |
| `optimize-<时间戳>-<随机后缀>.json` | 最终结果与逐轮历史 |
| `improve_iter_<n>.json` | 第 n 轮改善子进程的提示词、响应与解析结果 |

固定命名 + 独立子目录，意味着两次 `optimize`（甚至并发调用）不会互相覆盖报告与改善记录。

输出示例：

```text
优化 ./skills/api-doc-writer：2 轮（训练 3 / 测试 2，holdout 0.4）
  第 1 轮  训练 2/3  测试 1/2
  第 2 轮  训练 3/3  测试 2/2
最终 description（测试集 2/2）：
  为 API 文档编写与维护流程创建技能……
镜像：3 个条目，链接镜像（跳过 0 项）
报告：./skills/api-doc-writer/.evals/optimize-2026-10-29T10-00-00-000Z-1a2b/optimize-2026-10-29T10-01-00-000Z-3c4d.json
实时报告：./skills/api-doc-writer/.evals/optimize-2026-10-29T10-00-00-000Z-1a2b/optimize-report.html
下一步：把上面的 description 写回 ./skills/api-doc-writer/SKILL.md 的 frontmatter，再跑一次 skill_zh eval ./skills/api-doc-writer 复核
```

失败示例（评测集缺失 / 参数非法与 `eval` 同款，此外）：

```text
错误：参数 --iterations 非法：0（只接受正整数）
改法：改用正整数，例如 skill_zh optimize ./skills/api-doc-writer --iterations 5
可用：skill_zh help
```

失败示例（模型/CLI 不可用）：

```text
错误：无法调用 opencode 执行评测：子进程启动失败或异常退出
改法：先确认 opencode CLI 可用、provider 与模型已配置；仍失败时设 SKILL_ZH_DEBUG=1 重跑查看原始报错，再运行 skill_zh optimize ./skills/api-doc-writer
可用：skill_zh help
```

## skill_zh package

> shell 等价：`skill-zh package <技能目录> --out <产物路径>`

把技能目录按**白名单**导出成可分发目录（**不产出 npm 包**）。导出前先做与 `validate` 同源的结构检查（`SKILL.md` 结构/frontmatter、目录名与 `name` 一致）；不合规直接拒绝，**不产出半成品**。

`references/` 与 `agents/`、`templates/` 一样是**可选**的：只有 `SKILL.md` 的简单技能同样能导出，产物就只有 `SKILL.md`。

导入 / 安装共用同一份白名单：只含 `SKILL.md`、`agents/**`、`references/**`、`templates/**`。安装器元数据（版本、属主清单、备份）在 `~/.config/opencode/skills/.skill-zh-state/`，**永远不会被导出**（约束见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)）。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 待导出的技能目录；相对路径按当前项目目录解析 |
| `--out <产物路径>` | **是** | — | 导出目标目录；相对路径按当前项目目录解析 |

还会拒绝四种目标：`--out` 是源目录本身或其子目录、`--out` 是源的祖先目录（会把源一起导出）、`--out` 已存在且非空、`--out` 已存在但不是目录；路径比较会先取最近存在祖先的 realpath，tmpdir / 项目路径含符号链接时同样生效。白名单外的顶层条目（`dist/`、`bin/`、`test/`、根目录散文件等）跳过并在输出里列出。

**只导出目录，不产出 npm 包**；发布到 npm 由用户手动执行（`npm publish --access public`），子命令不代发。

示例：

```text
skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
```

成功输出：

```text
导出 ./skills/api-doc-writer → ./skills-package/api-doc-writer
自检：SKILL.md 存在；目录名与 frontmatter name 一致；只导出白名单内容
文件（4 个，共 8234 字节）：
  SKILL.md  1204 字节
  agents/analyzer.md  2310 字节
  references/ref.md  4100 字节
  templates/eval-review.html  620 字节
跳过（白名单外，未导出）：
  dist/
  notes.md
下一步：
  1. 把 ./skills-package/api-doc-writer 复制到 ~/.config/opencode/skills/ 或项目 .opencode/skills/ 下启用
  2. npm 发布由用户手动执行（本子命令只导出目录，不做 npm 打包、不代发）
```

失败示例（缺 `--out`）：

```text
错误：缺少参数 --out <产物路径>
改法：运行 skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
可用：skill_zh help
```

失败示例（导出到源目录内部）：

```text
错误：导出目标不能是技能目录本身或其子目录：./skills/api-doc-writer/dist
改法：换一个源目录之外的路径，例如 skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
可用：skill_zh help
```

失败示例（结构不合规）：

```text
错误：导出前校验未通过（1 处错误）
改法：
  - 目录名与 frontmatter name 不一致：目录 api-doc-writer，name api-doc-writer-zh；把目录重命名为 api-doc-writer-zh，或把 ./skills/api-doc-writer/SKILL.md 的 name 改为 api-doc-writer
可用：skill_zh help
```

## skill_zh install

> shell 等价：`skill-zh install [--dry-run] [--force] [--dir <目标根>]`

把包内 `skill/` 装到用户级技能目录（默认 `~/.config/opencode/skills/opencode-skill-creator-zh/`），是**白名单拷贝、元数据外置、冲突探测、用户改动保护**的唯一入口（约束见 SPEC `R6.1` 的 I1–I5）。

> 为什么要有这个子命令：插件启动钩子也在做同一件事，但钩子拿不到 CLI 参数，遇到同名冲突或本地改动只能记日志。需要当场处置时，用本子命令的 `--dry-run` / `--force` / `--dir`。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--dry-run` | 否 | 关 | 只探测与计算处置（同名技能、将写入/跳过/删除哪些文件），**不写盘** |
| `--force` | 否 | 关 | 覆盖本地改过的 `SKILL.md`；覆盖前先把旧文件备份到状态目录 |
| `--dir <目标根>` | 否 | `~/.config/opencode/skills` | 目标技能根目录；相对路径按当前项目目录解析 |

行为：

1. **白名单拷贝**：只写 `SKILL.md`、`agents/**`、`references/**`、`templates/**`；白名单外条目跳过（`SKILL_ZH_DEBUG=1` 时逐条打点）。`skill.md` 等大小写变体按同一个文件处理，落盘规范为 `SKILL.md`。
2. **元数据外置**：版本、属主文件哈希、最近一次备份位置写在 `<目标根>/.skill-zh-state/opencode-skill-creator-zh.json`；技能目录内**只有技能本体**。旧版安装器留在技能目录里的 `.opencode-skill-creator-version` / manifest 会在安装时清理；`SKILL.md.user-backup` 仅当内容等于当前或包内 `SKILL.md` 时删除，否则迁到状态目录并在输出里点名。
3. **冲突探测**：安装前只读枚举 `~/.claude`、`~/.agents`、`~/.config/opencode/{skill,skills}`、项目目录（`directory` → `worktree` 逐层）下的同名技能，以及配置里的 `skills.paths`；每个来源按 `skills/<任意层级>/SKILL.md` 递归，目录名或 frontmatter `name` 命中都算。扫描顺序为外部 → config → `skills.paths`，后者覆盖前者，据此标出哪份当前生效。`OPENCODE_DISABLE_EXTERNAL_SKILLS` 关掉全部外部来源，`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE` 只关 `.claude`。**只提示、不改写任何外部目录**，安装照常写自己的目录。
4. **用户改动保护**：磁盘上的 `SKILL.md` 与状态文件记录的内容哈希不一致（= 本地改过）时**默认不覆盖**，输出字节数/首个差异行并提示 `skill_zh install --force`；`--force` 才覆盖，且旧文件备份为 `<目标根>/.skill-zh-state/SKILL.md.bak-<时间戳>`。辅助文件仍随包更新。
5. **幂等**：内容一致的文件不重写；重复执行输出「已是最新」，不产生临时文件或残留。
6. **只写两处**：目标技能目录与状态目录。不碰上游英文技能目录、不碰 `.claude/`、`.agents/`，也不像上游那样把同级目录改名归档。

成功输出：

```text
安装：已安装（0.1.0）→ ~/.config/opencode/skills/opencode-skill-creator-zh
写入（6）：SKILL.md  agents/analyzer.md  agents/comparator.md  agents/grader.md  references/schemas.md  templates/eval-review.html
跳过（白名单外）：dist/  test/
状态：~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json（版本、属主清单与备份都在技能目录外）
下一步：重启 OpenCode 使技能重新加载
```

带同名冲突时追加（路径为实际探测结果）：

```text
探测：发现 1 处当前生效的同名技能（只提示，不改写任何外部目录）
  ~/.claude/skills/opencode-skill-creator-zh（外部 .claude（用户级），当前生效：是）
处置（任选其一）：
  - 把 ~/.claude/skills/opencode-skill-creator-zh/SKILL.md 改名为 SKILL.md.disabled
  - 把 ~/.claude/skills/opencode-skill-creator-zh 整个移出任何 skills/ 路径
  - 改该技能 frontmatter 的 name（避免同名覆盖，不等于禁用）
  - 在 OpenCode 配置里用 permission deny 拦掉该技能
  - 设 OPENCODE_DISABLE_EXTERNAL_SKILLS=1（只关 .claude 用 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1）
```

带本地改动（未加 `--force`）：

```text
安装：保留本地 SKILL.md，未覆盖（0.1.0）→ ~/.config/opencode/skills/opencode-skill-creator-zh
跳过：SKILL.md（本地已改动，保留）
本地改动：本地 1300 字节 / 包内 1204 字节，首个差异在第 8 行
改法：确认要换成本包版本再运行 skill_zh install --force（旧文件会备份到状态目录）
```

失败示例（`--dir` 缺值）：

```text
错误：缺少参数 --dir <目标根>
改法：运行 skill_zh install --dir ./skills
可用：skill_zh help
```

排障：`SKILL_ZH_SKILL_SOURCE=<目录>` 可让 install / 启动钩子临时改用指定技能目录（本地开发与测试用）；正常使用不需要设置。

插件启动时默认自动安装技能（`~/.config/opencode/skills/opencode-skill-creator-zh/` + `.skill-zh-state/`），开箱即用；每次启动都会记一条日志（「已自动安装技能到 …」或「启动安装跳过：原因」）。设 `SKILL_ZH_NO_STARTUP_INSTALL=1` 可完全跳过启动安装（只跳过插件自己的两处写入，不碰其它技能目录）；关闭后仍可随时用 `skill_zh install` 显式安装。

## 本版不提供的上游能力

上游共 14 个工具，其中 5 个已由 `skill_zh` 承担：`skill_validate` + `skill_parse` → `validate`，`skill_eval` → `eval`，`skill_improve_description` + `skill_optimize_loop` → `optimize`。其余 **9 项不注册为工具**：

| 不注册的能力 | 本版怎么处理 |
|---|---|
| gold 样本管理 ×4（增 / 列 / 删 / 取建议） | 实现保留在 `src/lib/`，不暴露；需要时按 `skill/SKILL.md` 的手工流程处理 |
| 评审查看器 ×3（起 / 停 / 导出静态 HTML） | 同上，手工流程处理 |
| benchmark 汇总、HTML 报告 ×2 | 本版 `eval` 只输出**文本汇总 + JSON 报告**（统计口径复用 `lib/aggregate`）；**HTML 查看器未提供**，不单独注册工具、也不单独开子命令 |
