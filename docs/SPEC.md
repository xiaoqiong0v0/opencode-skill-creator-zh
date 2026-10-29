# SPEC —— 中文技能工坊需求与验收口径

本文是**需求与验收口径的唯一出处**。实施批次见 [ROADMAP.md](ROADMAP.md)，编码规范见 [CONVENTIONS.md](CONVENTIONS.md)，用法定稿见 [../README.md](../README.md)。

> 当前状态：B0–B5 已完成——骨架、单工具壳、`new` / `validate`、`eval` / `optimize`、`package` / `install` 均已落地；B6 做技能正文与文案收尾。文中行为均由测试或门禁守住，验收项见 §4。

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
| 测试 | `node --test --experimental-test-module-mocks`（自动发现 `test/**/*.test.js`；该 flag 要求 **Node ≥ 22.3**，`engines.node` 必须同步，见 R7；对编译产物跑，测试文件为 `.js`） |
| 包内容 | `files: ["dist", "skill", "README.md"]`；包内技能只有 `skill/` 一份，与 `dist/` 平级 |
| 目录 | `src/`（含 `src/lib/`、`src/cli/`）、`test/`、`docs/`、`scripts/`、`templates/`、`skill/` |

## 3. 需求

### R1 只暴露 1 个工具（单点注册）

- 插件注册后工具列表里只新增 **1 项**：工具名 `skill_zh`。
- 上游 14 个工具（`skill_validate` / `skill_parse` / `skill_eval` / `skill_improve_description` / `skill_optimize_loop` / `skill_aggregate_benchmark` / `skill_generate_report` / `skill_serve_review` / `skill_stop_review` / `skill_export_static_review` / `skill_add_gold_standard` / `skill_list_gold_standards` / `skill_remove_gold_standard` / `skill_get_gold_advice`）**全部不再单独注册**。
- 入参 schema 只有一个字符串字段 `args`，不为每个子命令各开一套 typed args。
- 代码结构上，工具注册调用点**只有 1 处**（在 `src/index.ts`），其余能力由 `src/cli/` 的分发器调用 `src/lib/` 实现。

### R2 固定 7 个子命令

名称与顺序即 `help` 的展示顺序。

> `install` 是**第 7 个**子命令，B5 已实现。它存在的理由：安装器跑在插件启动钩子里，CLI 参数传不进去，所以「有冲突时怎么处置」必须由用户显式调子命令完成。

| 子命令 | 语义 | 必备行为 |
|---|---|---|
| `help` | 用法 | 无参数或 `help` 时返回完整用法 |
| `new` | 新建技能骨架 | 产出 `SKILL.md` + `references/`；目标目录已存在时拒绝覆盖，并提示 `--force` |
| `validate` | 校验技能目录 | 校验 `SKILL.md` 存在、frontmatter 合法、必填字段齐全、目录名与 `name` 一致、description 长度；`--strict` 时 description 长度与命名规范从提示升级为错误 |
| `eval` | 触发率评测 | 输出通过率、逐条 query 的触发结果、失败用例清单；benchmark 类汇总随评测输出一并给出 |
| `optimize` | 迭代改写 description | 训练/测试集切分，输出每轮通过率与最终 description |
| `package` | 导出技能目录 | **只导出目录**（不产出 npm 包），`--out <产物路径>` 必填；发布 npm 由用户手动执行 |
| `install` | 把包内 `skill/` 装到用户级技能目录 | 承担冲突探测、白名单拷贝、元数据外置；`--dry-run` 只报冲突不写盘；`--dir` 改目标根；默认**不覆盖**用户改过的 `SKILL.md`，`--force` 才覆盖；冲突与处置口径见 R6.1 |

- 未知子命令 → 走 R5 三段式，改法里列出全部可用子命令（不另外打印完整帮助）。
- 子命令缺参 → 打印该子命令示例，不打印堆栈。
- 参数值非法（如 `--runs abc`、`--workers 0`）→ 指出允许取值，并给一条可直接照抄的正确命令。

### R3 `help` 覆盖度

- `help` 必须覆盖**全部 7 个子命令**，每个子命令至少 **1 个可复制执行的示例**。
- 断言方式：对 `HELP_TEXT` 做字符串检查，7 个子命令名与 7 条 `skill_zh <子命令>` 形式的示例行必须同时出现。

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
3. 安装/升级只写目标技能目录与安装状态目录，删除与覆盖限定在这两处内，不触碰其它技能目录（明细见 `R6.1` 的 I1/I2）；
4. 升级时保留用户对 `SKILL.md` 的改动（备份策略见 [installation.md](installation.md#升级)）。

### R6.1 技能安装约束

安装器（`src/lib/skill-install.ts`，B5 已落地）必须满足下列 5 条，取代上游「整目录递归拷 + 元数据写技能目录内 + 备份后覆盖」的做法。问题推导、源码依据与完整测试点见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)。

| 编号 | 要求（可判定） | 判定方式 |
|---|---|---|
| I1 | **白名单拷贝**：安装只写 `SKILL.md`、`agents/**`、`references/**`、`templates/**`；白名单外条目跳过（比较不区分大小写）；技能目录内不得出现安装器元数据 | 单测：源目录另含 `dist/`、`bin/`、`test/`，安装后目标目录无这些条目，且文件集合 = 白名单集合 |
| I2 | **元数据外置**：安装版本、属主文件清单、用户改动备份只写 `~/.config/opencode/skills/.skill-zh-state/<name>.json`（备份落同目录），技能目录只留技能本体 | 单测：安装后技能目录内无点开头条目、无 `*.user-backup`；状态目录含该技能 json |
| I3 | **安装前探测同名技能**：按发现链探测 `.claude`、`.agents`、OpenCode 配置目录、`skills.paths`；项目目录按 `directory` → `worktree` 逐层，每个来源按 `skills/<任意层级>/SKILL.md` 递归，目录名或 frontmatter `name` 命中都算；遵守 `OPENCODE_DISABLE_EXTERNAL_SKILLS` 与 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`；发现同名**只提示不改写**，按「外部 → config → paths」说明当前哪个生效 | 单测：`.claude` / `.agents` / 项目级各命中一次；嵌套 `skills/**/SKILL.md` 与 frontmatter name 命中；`skills.paths` 最后覆盖；环境变量关闭判定正确；安装输出点名路径且探测目录哈希前后一致 |
| I4 | **禁用手段只给真正生效的动作**：改 `SKILL.md` 文件名、移出 `skills/`、改 frontmatter `name`、权限 deny、用环境变量关掉外部来源；不出现「重命名目录即可禁用」 | `grep -n "重命名目录"`（`docs/`、`src/`）：每条命中所在的句子必须含「不能 / 无效 / 不要 / 不给 / 不出现 / 建议」之一，作为**建议动作**出现即判失败；单测断言提示文案枚举的动作属于上述 5 类 |
| I5 | **用户改动保护**：`SKILL.md` 磁盘哈希与状态文件记录不一致时**默认不覆盖**，提示 `skill_zh install --force`；备份只写状态目录、文件名带时间戳。辅助文件（`agents/`、`references/`、`templates/`）仍随包更新 | 单测：改本地 `SKILL.md` 后重装内容不变且提示 `--force`；加 `install --force` 后变包内版本，改动可在状态目录备份中找到 |

### R6.2 技能评测隔离约束

评测（`eval` / `optimize`）会建一个临时隔离根 `evalRoot` 再跑 `opencode run`（`src/lib/run-eval.ts`，**B4 已落地**）。隔离根的内容与来源必须满足下列 9 条，取代上游「整目录 symlink、失败即递归整拷 + 无边界向上找项目根 + 同名技能命中即中止」的做法；镜像范围**已定方案 C**（2026-10-29）。问题推导、决策记录与完整测试点见 [design/技能评测隔离问题.md](design/技能评测隔离问题.md)。

| 编号 | 要求（可判定） | 判定方式 |
|---|---|---|
| J1 | **拒绝整目录递归拷贝**：降级路径只能逐文件拷贝已知条目（配置文档、被引用的相对文件、技能目录白名单 `SKILL.md`/`agents/**`/`references/**`/`templates/**`），其余跳过；单文件大小有上限常量；**禁止对任何目录调用 `cpSync(..., { recursive: true })`** | 单测：打桩 `symlinkSync` 抛 `EPERM` 后跑镜像，`evalRoot` 文件集合 ⊆ 已知条目集合，源里的 `node_modules/`、`dist/`、`.git/` 与超限大文件均未进入；**源码门禁**：`grep -n "cpSync(.*recursive"`（`src/lib/`）命中数 = 0 |
| J2 | **项目根只来自调用方传入的上下文**，取值优先级固定：`ToolContext.directory`（会话项目目录）→ `worktree`（工作树根）→ 都没有则三段式报错（`错误：拿不到当前项目目录`）。**禁止用 `process.cwd()` 派生项目根，禁止向上查找目录**。只有「独立 CLI 场景」（无 `ToolContext`）才允许兜底向上查找，且必须**排除 opencode 自身运行时目录**（`~/.opencode`、`~/.config/opencode`，命中不算命中）、**校验项目形态**（含 `.opencode/skills` 或 `opencode.json(c)`），并**输出实际命中的根**（含来源） | 单测：`directory` 被原样透传并使用（`src/tool.ts` → `dispatch`，含 `worktree` 次选）；两者皆空时输出三段式（恰好三行）；`process.cwd` 打桩后取根不读它；独立 CLI 兜底路径：从 home 下的临时目录调用不得返回 home 目录（`~/.opencode` 判为运行时目录跳过）；只有 `.opencode/` 而无 `skills`/项目配置的候选根不被采纳；源码门禁：`src/cli/**` 与 `src/tool.ts` 内 `process.cwd()` 的真实调用数 = 0（注释里写禁止不算命中） |
| J3 | **被测技能本体与其祖先永不进入 `evalRoot`**：保留 canonical（`realpath`）守卫（本体 / 祖先 / skills 根自身 / 指向 skills 的别名），判定失败按禁止处理 | 单测：被测与兄弟技能同存时按内容哈希搜不到被测技能；三种别名用例均被拒且正常兄弟技能仍被镜像 |
| J4 | **`evalRoot` 清理必须 `finally` 级**：正常结束、抛错、取消三条路径都删除；预取消时不创建 | 单测：三路径结束后临时根不存在；`rmSync` 抛错时原始错误仍走三段式；预取消用例从未调用 `mkdtempSync` |
| J5 | **镜像清单可打印**：`SKILL_ZH_DEBUG=1` 时列出每个被镜像条目的相对路径、类型、字节数与跳过原因；默认只输出一行汇总 | 单测：调试模式清单与磁盘实际内容一致；未开调试时输出不含逐条清单 |
| J6 | **自动屏蔽同名技能**：执行前枚举可见技能，命中与被测技能基础名相同的条目时，在 `evalRoot/.opencode/opencode.json` 写 `permission.skill.<基础名> = "deny"`；不修改、移动、删除用户的任何技能目录或配置，也不要求用户先手动作业 | 单测：探测目录放同名技能跑评测，`evalRoot` 配置含该 deny；探测目录文件集合与哈希前后一致；输出不含「先删除 / 先改名」类前置要求 |
| J7 | **deny 写不进或不生效时回退中止**：写入失败或目标版本不支持按名 deny 时，不进入执行阶段，按三段式失败，且「改法」含冲突的实际路径与一条可复制命令；不得静默放行 | 单测：配置写入打桩抛错时不 spawn `opencode run`、错误三行含实际路径与可复制命令；「不支持按名 deny」的假版本行为一致 |
| J8 | **`--no-shadow-guard` 关闭自动屏蔽**：关闭时不写任何 deny 配置，行为回到「检测到同名冲突即中止」；只影响屏蔽，不影响 J1–J5 | 单测：加开关且存在同名技能时无 deny 配置且以冲突消息中止；无同名技能时评测正常执行 |
| J9 | **镜像范围固定为方案 C（四项缺一不可）**：① 合成技能本体；② 项目根 `opencode.json(c)` 及其引用文件（丢了丢 provider/agent/model 与项目指令）；③ `.opencode/` 除 `skills` 外全部条目；④ `.opencode/skills/` 除被测技能外的兄弟技能。四项之外不放行 | 单测：按相对路径快照断言 ①②③④ 均在、被测技能按内容哈希不在、`evalRoot` 无四项之外的顶层条目 |

### R7 工程门禁与自包含

- `tsc --noEmit` 零错误（类型检查只覆盖 `src/`；`test/` 为纯 JS，由 `node --test` 执行，不进 tsc）。
- `npm test` 全绿，且测试覆盖 R1（注册点计数）、R3（help 覆盖度）、R4（description 长度）、R5（4 类失败的三段式）。
- `README.md`、`docs/`、`src/` 的用户可见文案**不引用其它技能目录**（要求 agent 去读别的技能、或把某步交给别的技能完成）；例外仅限「来源 / 许可」段落与上游移植说明。
- 包内技能只有一份（见 R6），`npm pack --dry-run` 可验证。
- 技能安装约束 I1–I5（见 `### R6.1`）各有单测或 `grep` 门禁，不允许只写在文档里。

## 4. 验收方式

| 需求 | 验收命令 / 检查 |
|---|---|
| R1 | 加载插件后工具列表计数 = 1；`src/` 下工具注册调用点计数 = 1；14 个上游工具名在注册路径上 `grep` 无命中 |
| R2 | 7 个子命令逐个跑一遍，输出符合 R2 表格「必备行为」 |
| R3 | 断言 `HELP_TEXT` 含 7 个子命令名 + 7 条 `skill_zh <子命令>` 示例 |
| R4 | `[...TOOL_DESCRIPTION].length <= 60`，且文案与定稿值一致 |
| R5 | 触发「未知子命令 / 缺参 / 路径不存在 / 非法参数值」4 类失败，输出满足三段式 |
| R6 | `npm pack --dry-run` 列出 `dist/`、`skill/`、`README.md`；安装后技能目录名与插件 id 一致；与上游英文技能同时安装不冲突 |
| R6.1-I1 | 单测（`lib-skill-install` / `cli-install`）：源目录含 `dist/`/`bin/`/`test/` 时，安装后的技能目录文件集合 = 白名单集合（快照比对）；`skill.md` / `AGENTS/` 大小写变体归一 |
| R6.1-I2 | 单测：安装后技能目录内无点开头条目与 `*.user-backup`；`<目标根>/.skill-zh-state/opencode-skill-creator-zh.json` 存在且清掉旧版元数据 |
| R6.1-I3 | 单测（`lib-install-conflict`）：`.claude` / `.agents` / 项目级各命中一次；项目目录逐层、嵌套 `SKILL.md`、frontmatter name、`skills.paths` 生效顺序；环境变量关闭判定正确；安装输出点名路径且探测目录哈希前后一致 |
| R6.1-I4 | `grep -n "重命名目录"`（`docs/`、`src/`）每条命中须在否定/引用语境（同句含 不能 / 无效 / 不要 / 不给 / 不出现 / 建议）；提示文案枚举的动作属于 5 类 |
| R6.1-I5 | 单测：手工改 `SKILL.md` 后重装内容不变 + 提示 `skill_zh install --force`；加 `--force` 后为包内版本、状态目录存有 `SKILL.md.bak-<时间戳>`，技能目录内无备份 |
| R6.2-J1 | 单测：打桩 `symlinkSync` 抛 `EPERM` 后跑隔离根镜像，`evalRoot` 文件集合 ⊆ 已知条目集合，`node_modules/`、`dist/`、`.git/` 与超单文件上限的大文件均未进入；源码门禁：`grep -n "cpSync(.*recursive"`（`src/lib/`）命中数 = 0 |
| R6.2-J2 | 单测：`ToolContext.directory` 被透传到分发层并作为路径基准（`worktree` 为次选）；两者皆空时输出三段式（恰好三行）；`process.cwd` 打桩后取根过程不读它；源码门禁：`src/cli/**` 与 `src/tool.ts` 内 `process.cwd()` 真实调用数 = 0（注释提及不算），`src/tool.ts` 无「只读 args、丢弃 context」写法；独立 CLI 兜底：从 home 下的临时目录调用**不得返回 home**，只有 `.opencode/` 而无 `skills`/项目配置的候选根不被采纳 |
| R6.2-J3 | 单测：被测技能与兄弟技能同存时，`evalRoot` 内按内容哈希搜不到被测技能；skills 根别名 / 祖先别名 / `.opencode/` 指向 skills 的条目三种用例均被拒，正常兄弟技能仍被镜像 |
| R6.2-J4 | 单测：成功 / 抛错 / 取消三条路径结束后隔离根均不存在；预取消用例从未调用 `mkdtempSync` |
| R6.2-J5 | 单测：`SKILL_ZH_DEBUG=1` 时镜像清单（条目 + 类型 + 字节数 + 跳过原因）与磁盘实际内容一致；未开调试时输出不含逐条清单、只输出一行汇总 |
| R6.2-J6 | 单测：给定同名全局技能 → `evalRoot/.opencode/opencode.json` 出现 `permission.skill.<name> = "deny"`（与已镜像配置合并；目标为符号链接时先摘链），且探测目录文件集合与哈希不变（未写用户目录）；可失败性：注释掉 deny 写入后该用例必须变红 |
| R6.2-J7 | 单测：把 deny 配置写入打桩成抛错 → 不启动任何 `opencode run`，错误三段式的「改法」含冲突实际路径与一条可复制命令；**单条 query 阶段**写入失败同样整轮中止（不计入 `errored`、不产出报告）；枚举不可用时行为一致 |
| R6.2-J8 | 单测：给定 `--no-shadow-guard` → 不写任何 deny 配置，且同名技能存在时按冲突消息中止（J7 的兜底路径同批用打桩写入失败验证）；无同名技能时评测正常执行 |
| R6.2-J9 | 单测：隔离根顶层条目 = 根配置文档 + `.opencode/`（含兄弟技能、非 skills 条目）+ 被引用文件，四项之外不存在；被测技能按内容哈希不可见 |
| B4-eval | `skill_zh eval <技能目录>` 输出通过率（passed/total、每条次数、阈值）、逐条结果、失败用例清单、镜像汇总与报告路径；`--runs` / `--workers` / `--timeout` / `--model` / `--agent` / `--eval-set` / `--log-dir` / `--no-shadow-guard` 全部生效；缺参、评测集缺失、参数非法均走三段式 |
| B5-package | `skill_zh package <技能目录> --out <目录>` 只导出白名单四项并列出跳过项；`--out` 缺失 / 指向源目录内部 / 目标非空 / 结构不合规均走三段式且不产出半成品；输出含文件相对路径、字节数与「npm 发布由用户手动执行」 |
| B5-install | `skill_zh install --dry-run` 不写盘；真实安装后目标技能目录 = 包内白名单集合；重复安装幂等；启动钩子在测试环境不写盘（`NODE_TEST_CONTEXT` / `SKILL_ZH_NO_STARTUP_INSTALL=1`） |
| B4-optimize | `skill_zh optimize <技能目录>` 输出每轮训练/测试通过率与最终 description，并在 `<技能目录>/.evals/` 落盘 HTML 实时报告与 JSON 结果；`--iterations` 缺值/非法走三段式 |
| R7 | `npm run typecheck` 退出码 0；`npm test` 退出码 0；对 `README.md`、`docs/`、`src/` 搜跨技能引用措辞无命中（来源/许可段落除外） |
| R7-Node | `engines.node` 与 `test` 脚本用到的 Node flag 必须兼容（当前 `>=22.3` / `--experimental-test-module-mocks`）：`grep -n "experimental-test-module-mocks" package.json` 有命中时，`engines.node` 下限不得低于该 flag 的引入版本（22.3） |

## 5. 非目标

- **不做英文版**：英文由上游维护，本仓只交付中文。
- **不改 OpenCode 的技能加载 / 发现机制**：技能落盘位置与加载规则沿用平台约定。
- **不重写上游已验证逻辑**：`src/lib/` 只做迁入与接线，不重构算法；确需改动须在 `docs/changes/` 留痕。
- **不注册 9 个非核心能力**：gold 样本管理（4 个）与评审查看器（3 个：起 / 停 / 导出）共 7 个不注册为工具、实现仍保留在 `src/lib/`；**benchmark 汇总与 HTML 报告**这 2 项并入 `eval` 的输出，不单独注册工具，也不单独开子命令。
- **不做 V2 入口**：只提供 V1 `export default { id, server }`。
