# skill_zh 子命令参考

[项目概览](../README.md) · [安装](installation.md) · [需求与验收](SPEC.md)

本插件只暴露 **1 个工具** `skill_zh`，入参只有一个 `args` 字符串。工具 description 为 `中文技能工坊：新建、校验、评测、优化并打包 OpenCode 技能`（33 字符），参数细节全部交给 `skill_zh help`。

> 当前状态：`src/` 尚未创建，本文描述的是**目标行为**（落地批次见 [ROADMAP.md](ROADMAP.md)）。

## 通用约定

| 约定 | 说明 |
|---|---|
| 入参 | 单个 `args` 字符串，如 `"validate ./skills/demo"`；空字符串等同 `help` |
| 分词 | 参数以空格分隔；路径含空格用双引号包裹，如 `validate "D:/my skills/demo"` |
| 选项形式 | `--flag value` 与 `--flag=value` 等价；布尔选项只写 `--flag` |
| 路径基准 | 相对路径按 OpenCode 进程的工作目录解析；工具参数是文件系统路径，不是 shell 命令 |
| 输出 | 纯文本，直接回给模型；失败也返回文本，不抛原始堆栈 |
| 失败格式 | 统一三段式：`错误：` / `改法：` / `可用：skill_zh help` |
| 调试 | 调用进程设 `SKILL_ZH_DEBUG=1` 时输出执行细节与原始错误；默认不外泄内部路径与堆栈（B2 落地） |

失败输出模板：

```
错误：<一句话说明哪里不对>
改法：<可复制执行的命令或明确的文件改动>
可用：skill_zh help
```

## skill_zh help

打印完整用法：6 个子命令说明 + 每个子命令至少 1 条可复制示例。

| 参数 | 必填 | 说明 |
|---|---|---|
| 无 | — | `skill_zh` 与 `skill_zh help` 等价 |

输出示例（节选，实际以 `HELP_TEXT` 为准）：

```text
skill_zh —— 中文 OpenCode 技能创建工具（CLI 风格单工具）

子命令：
  help      显示本帮助，覆盖全部子命令与示例
  new       按中文模板生成技能骨架（SKILL.md + references/）
  validate  校验 SKILL.md 结构、frontmatter 字段与 description 长度
  eval      跑触发率评测，输出通过率与失败用例
  optimize  按评测失败反复改写 description（先训练/测试集切分）
  package   只导出可分发的技能目录（--out 必填）

示例：
  skill_zh new api-doc-writer --dir ./skills
  skill_zh validate ./skills/api-doc-writer
  ...
  skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
```

失败示例（未知子命令：先给完整帮助，再给一行改法）：

```text
错误：未知子命令 "validat"
改法：运行 skill_zh validate ./skills/my-skill（子命令见上面的列表）
可用：skill_zh help
```

## skill_zh new

按中文模板生成技能骨架：`<技能名>/SKILL.md` + `<技能名>/references/`。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能名>` | 是 | — | kebab-case，同时作为目录名与 frontmatter `name` |
| `--dir <目录>` | 否 | `./skills` | 父目录，不存在则创建 |
| `--force` | 否 | 关 | 目标目录已存在时允许覆盖已生成文件（不动用户自建文件） |

输出示例：

```text
已生成技能骨架：./skills/api-doc-writer
  SKILL.md            （frontmatter：name、description；正文为待填大纲）
  references/         （按需加载的参考资料，先放占位说明）
下一步：
  skill_zh validate ./skills/api-doc-writer
```

失败示例（目标已存在）：

```text
错误：目录已存在，未覆盖：./skills/api-doc-writer
改法：换一个技能名，或运行 skill_zh new api-doc-writer --dir ./skills --force
可用：skill_zh help
```

## skill_zh validate

校验技能目录：`SKILL.md` 是否存在、frontmatter 是否合法、必填字段是否齐全、目录名与 `name` 是否一致、description 长度是否在限内。

| 参数 | 必填 | 说明 |
|---|---|---|
| `<技能目录>` | 是 | 含 `SKILL.md` 的目录 |
| `--strict` | 否 | 把 description 长度与命名规范从「提示」升级为「错误」（判失败 + 三段式）；缺省只提示 |

输出示例：

```text
校验 ./skills/api-doc-writer：通过
  frontmatter  合法（name、description）
  name         与目录名一致
  description  118 字符（上限 1024）
  references/  3 个文件
```

失败示例（描述超长，逐条给改法）：

```text
错误：description 超长：1380 字符，上限 1024 字符
改法：编辑 ./skills/api-doc-writer/SKILL.md 的 frontmatter description，把细则移到正文或 references/，只保留「做什么 + 何时触发 + 不适用边界」
可用：skill_zh help
```

失败示例（路径不存在）：

```text
错误：技能目录不存在：./skills/api-doc
改法：确认目录名拼写，或运行 skill_zh new api-doc-writer --dir ./skills 新建一个
可用：skill_zh help
```

## skill_zh eval

跑触发率评测：按技能目录下的评测集把每条 query 交给被测模型，统计技能是否被选中，输出通过率、逐条结果与失败用例清单。

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `<技能目录>` | 是 | — | 评测集默认取 `<技能目录>/evals/evals.json` |
| `--runs <次数>` | 否 | 见实现常量 | 每条 query 重复次数，必须是正整数 |
| `--workers <并发>` | 否 | 见实现常量 | 并发数，必须是正整数；按 provider 限额与预算调小 |

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

打包成可分发的技能目录或 npm 包，并在产出后做结构自检（`SKILL.md` 存在、`references/` 存在、目录名与 `name` 一致）。

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

## 本版不提供的上游能力

上游共 14 个工具，其中 5 个已由 `skill_zh` 承担：`skill_validate` + `skill_parse` → `validate`，`skill_eval` → `eval`，`skill_improve_description` + `skill_optimize_loop` → `optimize`。其余 **9 项不注册为工具**：

| 不注册的能力 | 本版怎么处理 |
|---|---|
| gold 样本管理 ×4（增 / 列 / 删 / 取建议） | 实现保留在 `src/lib/`，不暴露；需要时按 `skill/SKILL.md` 的手工流程处理 |
| 评审查看器 ×3（起 / 停 / 导出静态 HTML） | 同上，手工流程处理 |
| benchmark 汇总、HTML 报告 ×2 | **并入 `eval` 的输出**，不单独注册工具，也不单独开子命令 |
