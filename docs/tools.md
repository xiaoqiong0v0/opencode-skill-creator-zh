# skill_zh 子命令参考

[项目概览](../README.md) · [安装](installation.md) · [需求与验收](SPEC.md)

本插件只暴露 **1 个工具** `skill_zh`，入参只有一个 `args` 字符串。工具 description 为 `中文技能工坊：新建、校验、评测、优化并打包 OpenCode 技能`（33 字符），参数细节全部交给 `skill_zh help`。

> 当前状态：B0/B1/B2 完成，B3 已接真实现——`new` / `validate` 可用；`eval` / `optimize` / `package` 待 B4、`install` 待 B5，调用会返回「尚未实现」三段式。相对路径的解析基准见下节「路径解析基准」。

## 通用约定

| 约定 | 说明 |
|---|---|
| 入参 | 单个 `args` 字符串，如 `"validate ./skills/demo"`；空字符串等同 `help` |
| 分词 | 参数以空格分隔；路径含空格用双引号包裹，如 `validate "D:/my skills/demo"` |
| 选项形式 | `--flag value` 与 `--flag=value` 等价；布尔选项只写 `--flag` |
| 路径基准 | 相对路径按**当前会话的项目目录**解析（见下节「路径解析基准」）；工具参数是文件系统路径，不是 shell 命令 |
| 输出 | 纯文本，直接回给模型；失败也返回文本，不抛原始堆栈 |
| 失败格式 | 统一三段式：`错误：` / `改法：` / `可用：skill_zh help` |
| 调试 | `SKILL_ZH_DEBUG=1`（打印执行细节与原始错误）**尚未实现**，当前调试入口是 `SKILL_ZH_LOG_DISABLE=1` 关闭日志、`~/.config/opencode/plugin-logger.jsonc` 的 `enabled` 打开日志；默认不外泄内部路径与堆栈 |

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

- **不用 `process.cwd()` 推断项目根，不做向上查找**。上游 `findProjectRoot()` 从 cwd 一路向上，命中 `.opencode/` 就返回——在 home 之下调用时会把 `~/.opencode`（opencode 的运行时目录：缓存、插件数据、`skills/`）判成项目根，于是评测镜像了错的项目、结果不可信。本版不复刻这条路径。仅「独立 CLI 场景」（进程里没有 `ToolContext`）才允许兜底向上找，且必须排除 `~/.opencode`、`~/.config/opencode` 并校验项目形态，输出里写明实际命中的根。
- **技能可以写在任意目录**：`skill_zh` 不要求技能必须在 `.opencode/skills/` 下，只要路径给对（相对或绝对）就行。`validate` / `eval` / `optimize` / `package` 都接收任意目录；只有涉及「项目里可见哪些技能」的评测画像才与项目根有关。

## skill_zh help

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
  eval      跑触发率评测，输出通过率与失败用例
  optimize  按评测失败反复改写 description（先训练/测试集切分）
  package   只导出可分发的技能目录（--out 必填）

示例：
  skill_zh new api-doc-writer --dir ./skills
  skill_zh validate ./skills/api-doc-writer
  ...
  skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
```

失败示例（未知子命令：恰好三行，改法里列出全部可用子命令）：

```text
错误：未知子命令 "validat"
改法：可用子命令：help / new / validate / eval / optimize / package / install
可用：skill_zh help
```

## skill_zh new

按中文模板（仓库 `templates/`）生成技能骨架：`<技能名>/SKILL.md` + `<技能名>/references/`。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能名>` | 是 | — | 必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` 且 ≤ 64 字符；同时作为目录名与 frontmatter `name` |
| `--dir <目录>` | 否 | 当前会话项目目录 | 父目录，不存在则创建；相对路径按「路径解析基准」一节解析 |
| `--force` | 否 | 关 | 目标目录已存在且非空时允许覆盖：只重写 `SKILL.md` 与 `references/示例.md`，被覆盖的两个文件各留一份 `.bak`（输出点名「已备份：…」），不动用户自建文件 |

目标目录已存在且**非空**时默认拒绝（空目录可直接生成）。生成的 `description` 是带引号的 TODO 占位（`TODO: 用一句话写清做什么 + 何时触发 + 不适用，≤ 60 字符`），`references/示例.md` 开头写明「何时读本文件」。

输出示例：

```text
已生成技能骨架：./skills/api-doc-writer
  SKILL.md               （frontmatter：name、description 占位，正文为待填大纲）
  references/示例.md      （按需加载的参考资料，文件开头写明何时读）
下一步：
  1. 编辑 ./skills/api-doc-writer/SKILL.md，把 description 的 TODO 换成「做什么 + 何时触发 + 不适用」
  2. 运行 skill_zh validate ./skills/api-doc-writer 复核结构
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

校验技能目录：`SKILL.md` 是否存在、frontmatter 是否合法、必填字段是否齐全、目录名与 `name` 是否一致、description 长度是否在限内。

| 参数 | 必填 | 说明 |
|---|---|---|
| `<技能目录>` | 是 | 含 `SKILL.md` 的目录 |
| `--strict` | 否 | 把 description 长度与命名规范从「提示」升级为「错误」（判失败）；缺省只提示、不影响「通过」结论 |

每条问题都给 `问题：` + `文件:行`（能定位时）+ `改法：`，改法可直接照做；**同一目录的多处问题一次报全**（不是只报第一条），错误与提示分开计数、一并输出（不必先修完错误再跑一次才看见提示）。结论有两种：`通过` / `未通过（N 处错误[, M 处提示]）`；通过时同时输出 description 实际字符数。

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

跑触发率评测：按技能目录下的评测集把每条 query 交给被测模型，统计技能是否被选中，输出通过率、逐条结果与失败用例清单。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 评测集默认取 `<技能目录>/evals/evals.json` |
| `--runs <次数>` | 否 | 见实现常量 | 每条 query 重复次数，必须是正整数 |
| `--workers <并发>` | 否 | 见实现常量 | 并发数，必须是正整数；按 provider 限额与预算调小 |
| `--no-shadow-guard` | 否 | 关 | 关闭「自动屏蔽同名技能」（见下节）；关闭后只要发现同名技能就中止评测 |

逐条次数与并发的默认值以 `skill_zh help` 与 `src/cli/eval.ts` 中的常量为准。评测调用 `opencode run`，需要可用的 provider 与模型，且**会产生费用**。

评测集格式（JSON 数组）：

```json
[
  { "query": "帮我把这套发布流程做成技能", "should_trigger": true },
  { "query": "写一段生日邀请函", "should_trigger": false }
]
```

输出示例：

```text
评测 ./skills/api-doc-writer：通过率 0.85（17/20，每条 3 次，阈值 0.5）
失败用例：
  应触发未触发（2）
    - "把接口文档的更新流程固化下来"   命中 0/3
    - "这套 SKILL.md 写法能不能复用"   命中 1/3
  不应触发却触发（1）
    - "解释一下什么是 OpenAPI"         命中 2/3
下一步：
  skill_zh optimize ./skills/api-doc-writer --iterations 5
```

失败示例（评测集缺失）：

```text
错误：评测集不存在：./skills/api-doc-writer/evals/evals.json
改法：在技能目录下新建 evals/evals.json，写入 [{"query":"...","should_trigger":true}] 形式的 JSON 数组
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

- **不整目录递归拷贝**：镜像一律逐条目/逐文件，并有单文件大小上限；符号链接创建失败时（Windows 非开发者模式常见）也只逐文件拷已知条目，不搬 `node_modules/`、`dist/`、`.git/` 之类，超上限的文件跳过。
- **项目根不靠向上瞎找**：只在调用方传入的上下文里取（`ToolContext.directory` → `worktree`，都空则三段式报错）；不用 `process.cwd()`、不向上查找。只有独立 CLI 场景才兜底向上找，且要排除 `~/.opencode` / `~/.config/opencode` 并写明实际用的是哪个根。
- **被测技能本体不泄漏**：本体、其祖先目录、`skills` 根自身、指向 `skills` 的别名都不会被镜像进来（按真实路径判定，绕不过去）。

> 方案 C 的取舍：分数最接近真实使用，但与项目强耦合（换个项目分数会变，跨项目不可比）；输出里会注明本次镜像了哪些兄弟技能。做 description 的 A/B 对比时，可先把兄弟技能临时移出项目目录。
>
> 调试开关 `SKILL_ZH_DEBUG=1` 打开后，会打印镜像了哪些条目、各多大、哪些被跳过；默认只输出一行汇总。临时隔离根在评测结束（含报错与取消）后删除。

### 同名技能遮挡与自动 deny

评测跑的是合成技能 `<基础名>-skill-<随机 id>`，只把这个名字的触发算命中。但**全局技能不会被隔离**：`opencode` 子进程的 `HOME` / `XDG_CONFIG_HOME` 沿用你的环境，装在 `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills` 里的同名技能照样在候选集里；模型若选中旧的那个，合成技能就是 0 命中（假阴性）。

本版的处理是**不改你的任何目录，只改隔离根**：评测前枚举可见技能，一旦发现与被测技能同名（基础名相同），就在 `evalRoot` 的 `.opencode/opencode.json` 写 `permission.skill.<基础名> = "deny"`，让旧技能在**本次评测的子进程里**不可见。所以「评测一个已经装好的技能」不再需要先删掉它或给它改名。

| 情况 | 行为 |
|---|---|
| 发现了同名技能 | 自动写 deny，评测继续；输出提示「已在本轮评测中屏蔽 `<路径>`」 |
| deny 写不进，或目标版本不支持按名 deny | **不跑**，按三段式失败：「改法」给出冲突的实际路径与一条可直接复制的处置命令（不静默放行） |
| 想保持旧技能在场做对照 | 加 `--no-shadow-guard`：不写 deny，检测到同名即中止（回到「先处理环境再评测」的老行为） |

> 该屏蔽只在本次评测的临时隔离根里生效，评测结束随隔离根一起删除；你的技能目录与全局配置**不会被读写**。

## skill_zh optimize

按评测失败迭代改写 description：先按位置切分训练/测试集，每轮用训练集失败模式改写描述、再用测试集评估，输出每轮通过率与最终 description。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 同 `eval`，评测集默认取 `evals/evals.json` |
| `--iterations <轮数>` | 否 | 见实现常量 | 最大迭代轮数；训练集全通过可提前结束 |

输出示例：

```text
优化 ./skills/api-doc-writer：5 轮
  第 1 轮  训练 0.62  测试 0.58
  第 2 轮  训练 0.78  测试 0.71
  ...
  第 5 轮  训练 0.93  测试 0.86  ← 采用（按测试集得分选优）

最终 description（测试集 0.86）：
  为 API 文档编写与维护流程创建技能……
下一步：把上面的 description 写回 SKILL.md 的 frontmatter，再跑一次 skill_zh eval 复核
```

失败示例（模型/CLI 不可用）：

```text
错误：无法调用 opencode 执行评测（未找到可用的 provider 或模型）
改法：在 OpenCode 里配置可用模型后重试：skill_zh optimize ./skills/api-doc-writer --iterations 3
可用：skill_zh help
```

## skill_zh package

导出**可分发的技能目录**（不产出 npm 包），并在产出后做结构自检（`SKILL.md` 存在、`references/` 存在、目录名与 `name` 一致）。

导出的内容与安装器共用同一份**白名单**：只含 `SKILL.md`、`agents/**`、`references/**`、`templates/**`。也就是说，**导出的是白名单内的技能本体，不含安装器元数据**——版本标记、属主清单、升级备份都在 `~/.config/opencode/skills/.skill-zh-state/` 里，永远不会被导出（约束来源见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)）。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 待导出的技能目录 |
| `--out <产物路径>` | **是** | — | 导出目标目录（不设默认，避免与构建产物 `dist/` 撞名）；已存在且非空时拒绝覆盖 |

导出后在目标目录做结构自检（`SKILL.md` 存在、`references/` 存在、目录名与 `name` 一致）。**只导出目录，不产出 npm 包**；发布到 npm 由用户手动执行（`npm publish --access public`），子命令不代发。

输出示例：

```text
导出 ./skills/api-doc-writer → ./skills-package/api-doc-writer
自检：SKILL.md ✓  references/ ✓  目录名=name ✓
产物：./skills-package/api-doc-writer（4 个文件，12.3 KB）
下一步：复制到 ~/.config/opencode/skills/ 或项目 .opencode/skills/ 下启用
```

> 手工复制只启用技能正文，不受安装器管理（没有状态文件、也不会被升级逻辑覆盖）；同名技能是否真的生效取决于发现顺序，见 [installation.md](installation.md)。

失败示例（缺 `--out`）：

```text
错误：缺少参数 --out <产物路径>
改法：运行 skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
可用：skill_zh help
```

失败示例（自检未通过）：

```text
错误：目录名与 frontmatter name 不一致：目录 api-doc-writer，name api-doc-writer-zh
改法：把目录重命名为 api-doc-writer-zh，或把 ./skills/api-doc-writer/SKILL.md 的 name 改为 api-doc-writer
可用：skill_zh help
```

## skill_zh install（**B5 实现**）

把包内自带的 `skill/` 装到用户级技能目录 `~/.config/opencode/skills/opencode-skill-creator-zh/`。它是**冲突探测、白名单拷贝、元数据外置**的唯一入口。

> 为什么要有这个子命令：安装器本身跑在**插件启动钩子**里，CLI 参数传不进去，所以「发现同名技能怎么办 / 要不要覆盖我改过的 `SKILL.md`」无法在启动时由用户当场决定，只能落到显式调用的子命令上。启动钩子只负责「无冲突静默安装、有冲突只提示」。
>
> 落地批次：`install` 在 **B5** 实现。`skill_zh help` 与「未知子命令」的可用列表已含 `install`（B2 落地），但调用 `skill_zh install` 目前返回「尚未实现」三段式；本节参数与输出仍为**目标行为**。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--dry-run` | 否 | 关 | 只探测与报告（发现哪些同名技能、将写入/跳过哪些文件），**不写盘** |
| `--force` | 否 | 关 | 才用包内版本覆盖你改过的 `SKILL.md`（覆盖前先把你的版本备份到状态目录） |

行为：

1. **默认（不带参数）**：无冲突 → 静默安装；有冲突（探测到同名技能，或检测到 `SKILL.md` 被本地改过）→ **只提示不覆盖**，并给下一步命令。
2. `--dry-run`：只报告，不改任何文件。
3. `--force`：覆盖 `SKILL.md`（先备份到 `~/.config/opencode/skills/.skill-zh-state/`）；白名单外的源条目始终跳过。

输出示例：

```text
安装：/…/skill → ~/.config/opencode/skills/opencode-skill-creator-zh
探测：~/.claude/skills/opencode-skill-creator-zh（同名，当前生效：否）
      ~/.config/opencode/skills/opencode-skill-creator-zh（同名，当前生效：是）
写入：SKILL.md  agents/analyzer.md  agents/comparator.md  agents/grader.md
      references/schemas.md  templates/eval-review.html
跳过：dist/（不在白名单）
下一步：skill_zh install --dry-run 只预览；或 skill_zh install --force 覆盖本地改动
```

失败示例（有冲突，未覆盖）：

```text
错误：检测到同名技能与本地改动，未写入：~/.claude/skills/opencode-skill-creator-zh
改法：先看全貌 skill_zh install --dry-run；确认要换成本包版本再跑 skill_zh install --force
可用：skill_zh help
```

约束口径见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)（对应 SPEC `R6.1` 的 I1–I5）。

## 本版不提供的上游能力

上游共 14 个工具，其中 5 个已由 `skill_zh` 承担：`skill_validate` + `skill_parse` → `validate`，`skill_eval` → `eval`，`skill_improve_description` + `skill_optimize_loop` → `optimize`。其余 **9 项不注册为工具**：

| 不注册的能力 | 本版怎么处理 |
|---|---|
| gold 样本管理 ×4（增 / 列 / 删 / 取建议） | 实现保留在 `src/lib/`，不暴露；需要时按 `skill/SKILL.md` 的手工流程处理 |
| 评审查看器 ×3（起 / 停 / 导出静态 HTML） | 同上，手工流程处理 |
| benchmark 汇总、HTML 报告 ×2 | **并入 `eval` 的输出**，不单独注册工具，也不单独开子命令 |
