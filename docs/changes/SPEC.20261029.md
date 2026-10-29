# SPEC 变更说明（2026-10-29）

## SPEC R2「未知子命令」的行为口径

**原来**：`R2` 写「未知子命令 → 打印完整帮助 + 一行可执行改法」，与 `R5`「错误输出统一三段式（恰好三行）」互相矛盾——完整帮助 + 改法会多出十余行。

**现在**：`R2` 改为「未知子命令 → 走 R5 三段式，改法里列出全部可用子命令（不另外打印完整帮助）」。实现与测试保持原样：三行，第三行固定 `可用：skill_zh help`。

**为什么**：同一类失败只能有一种形状，否则测试无法同时满足 R2 与 R5，调用方也无从判断该读前几行还是最后一行。三段式已含兜底入口，完整帮助由 `skill_zh help` 按需取。

## 同批对齐的其它口径（均为「文档跟上实现」）

- `R7`：`tsc --noEmit` 只覆盖 `src/`；`test/` 为纯 JS，由 `node --test` 执行，不进 tsc。
- 测试命令：`node --test test/**/*.test.js` → `node --test`（自动发现），因为 glob 形式要 Node ≥ 22，而 `engines` 声明 `>= 18`。

## 新增 `R6.1 技能安装约束`（同日第二批）

**原来**：SPEC 只在 R6「配套约束」里写了 4 条（包内容、命名一致、只在目标目录内写、升级保留改动），没有安装器的可判定要求；备份与版本标记的位置沿用上游（写在技能目录内、`SKILL.md.user-backup`）。

**现在**：新增 `### R6.1 技能安装约束`，收敛成 5 条可判定要求 I1–I5（白名单拷贝、元数据外置、安装前探测同名技能、禁用手段只给真正生效的动作、用户改动默认不覆盖），并在 `§4 验收方式` 加 5 行（I1/I2/I3/I5 为单测、I4 为 `grep` 门禁），R7 加一条「不允许只写在文档里」。配套把备份位置改为 `~/.config/opencode/skills/.skill-zh-state/`。

**为什么**：上游安装器整目录递归拷、元数据写进技能目录、只备份后覆盖（`.tmp/old/plugin/lib/skill-install.ts:19,27,74-85,324,348-363`），三者都会让「技能目录 = 技能本体」失效并吃掉用户改动；写进 SPEC 才能进验收表。问题推导与源码依据见 [../design/技能安装与目录问题.md](../design/技能安装与目录问题.md)。

## 新增第 7 个子命令 `install`（同日第三批）

**原来**：子命令固定 6 个（`help` / `new` / `validate` / `eval` / `optimize` / `package`），冲突处置与升级覆盖没有入口——安装器跑在插件启动钩子里，CLI 参数传不进去，用户无从表达「要不要覆盖」。

**现在**：R2 子命令表加一行 `install`（标 **B5 实现**）：把包内 `skill/` 装到用户级技能目录，承担冲突探测 / 白名单拷贝 / 元数据外置 / `--dry-run` / `--force`。**现有 6 个子命令的断言口径与 R3 的「help 覆盖 6 个子命令」保持不变**，`install` 暂不计入该断言（`help` 文案与测试在 B5 同批加）；`R6.1-I5` 的提示文案同步改成 `skill_zh install --force`。

**为什么**：启动钩子只能在「无冲突」时静默安装、有冲突时提示；「覆盖我改过的 `SKILL.md`」「先看看会冲突什么」必须由用户显式调用子命令完成。

**同批确定的事实**：`~/.claude` 确在 opencode v1.18.25 的扫描范围内——`packages/opencode/src/skill/index.ts:187` 的 `if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)`，只受 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE` 控制；`installation.md` 与 `design/技能安装与目录问题.md` 里「需复核」的措辞已改为确定结论（保留「跨版本仍建议复核」的版本提示）。

## 新增 `R6.2 技能评测隔离约束`（同日第四批）

**原来**：SPEC 对评测（`eval` / `optimize`）只有 R2 表格里的「必备行为」与 R5 的错误口径，没有对**隔离根内容**与**项目根来源**的任何要求；上游做法（`.tmp/old/plugin/lib/run-eval.ts`，基线 `d4383924`）默认被当作可照抄的实现。

**现在**：新增 `### R6.2 技能评测隔离约束`，收敛成 5 条可判定要求 J1–J5（拒绝整目录递归拷贝、项目根只来自调用方 instance root、被测技能本体与祖先永不进入隔离根、隔离根清理 `finally` 级、镜像清单可打印），并在 `§4 验收方式` 加 3 行（J1/J2/J3 为单测）。

**为什么**：上游隔离根靠 `symlinkSync`，Windows 上失败即 `cpSync(recursive)` 整目录递归拷（`:297-305`），没有白名单也没有大小上限；取根靠无边界向上找 `.opencode` / `.claude` 的 `findProjectRoot()`（`:275-287`），命中即返回且不报告实际命中的根，而壳层仍在两处调用它（`.tmp/old/plugin/skill-creator.ts:367`、`:1091`）。两者叠加就是用户实测的两类症状：评测时拷了多余的东西、用错了项目根 → 触发率不可信。问题推导、三方案对比与完整测试点见 [../design/技能评测隔离问题.md](../design/技能评测隔离问题.md)。

## `R6.2` 补 J6–J8：同名技能遮挡改由隔离根 deny（同日第五批）

**原来**：`R6.2` 只有 J1–J5，全部围绕「隔离根里放什么、根从哪来」；对「已经装在 `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills` 的同名技能怎么办」没有要求，于是默认继承上游行为——发现同名即中止，让用户自己去删技能或改 `skills.paths`（`.tmp/old/plugin/lib/run-eval.ts:210-215`、`:221-236`，上游 PR #32 / commit `81efc24` 引入）。

**现在**：`R6.2` 扩到 8 条，新增 J6/J7/J8：J6 执行前枚举可见技能，命中同名基础名时**自动**在 `evalRoot/.opencode/opencode.json` 写 `permission.skill.<基础名> = "deny"`，不碰用户任何目录；J7 deny 写不进或目标版本不支持按名 deny 时**回退冲突中止**，错误三段式里给实际路径 + 可复制命令；J8 提供 `--no-shadow-guard` 关闭自动屏蔽（关闭后回到「检测到冲突即中止」）。`§4 验收方式` 补 2 行（R6.2-J6 / R6.2-J8，J7 用打桩写入失败同批验证）。

**为什么**：合成技能叫 `<基础名>-skill-<id>`，只认这个名字被触发；而全局技能在 eval 子进程里不会被隔离——`buildOpencodeEnv` 只覆盖 `PWD`（`.tmp/old/plugin/lib/process.ts:48-50`），不动 `HOME` / `XDG_CONFIG_HOME`。于是「评测一个已经装好的技能」这个最常见场景反而跑不了，用户被迫删自己的技能（不可逆）或临时改名。deny 能按名屏蔽且不改用户目录：`permission.skill` 类型为 `PermissionRuleConfig`（opencode v1.18.25 `packages/sdk/js/src/v2/gen/types.gen.ts:1682`），可用技能列表按 `PermissionV2.evaluate` 过滤 deny（`packages/core/src/skill.ts:30-31`；`packages/opencode/src/skill/index.ts:314` 同理）。坑 F 与 A/B/C 三方案**正交**，任何方案都要处理，详见 [../design/技能评测隔离问题.md](../design/技能评测隔离问题.md)。

## `R6.2` 镜像范围定稿为方案 C，补 J9（同日第六批）

**原来**：`R6.2` 有 J1–J8，但没有一条规定「`evalRoot` 到底放哪些东西」——镜像范围当时悬置，只写在设计文档的三方案对比里；`J1` 只写「拒绝整目录递归拷贝」，判定方式也只靠单测，没有源码级门禁。

**现在**：
1. 新增 **J9**：镜像范围固定为方案 C 的四项——① 合成技能本体；② 项目根 `opencode.json(c)` 及其引用文件（**必需**，丢了丢 provider / agent / model 与项目指令）；③ `.opencode/` 除 `skills` 外全部条目（**必需**）；④ `.opencode/skills/` 下除被测技能外的兄弟技能。四项之外不放行。
2. `J1` 的判定方式补**源码门禁**：`grep -n "cpSync(.*recursive"`（`src/lib/`）命中数必须为 0；要求里同时写明「禁止对任何目录调用 `cpSync(..., { recursive: true })`」，`§4` 的 R6.2-J1 行同步。
3. `R6.2` 抬头从「8 条」改为「9 条」，并注明镜像范围已定方案 C（2026-10-29）。

**为什么**：用户已定方案 C，镜像范围从「设计取舍」升级为可验收的需求口径；而「拷多余的东西」的病根是递归拷贝而非镜像语义，所以要把「禁 `cpSync(recursive)`」落成**可 grep 的硬门禁**，防止迁入时换个写法又把整目录拷贝带回来。决策记录与理由见 [../design/技能评测隔离问题.md](../design/技能评测隔离问题.md)。

## `R6.2` 的 J2 补两条硬要求（同日第七批）

**原来**：J2 只要求「项目根来自调用方传入的 instance root；fallback 限定边界并输出实际命中的根」，把「向上找」的**判定条件**留白。实证表明这个留白是致命的。

**现在**：J2 追加两条硬要求——① 向上查找**排除 opencode 自身运行时目录**（至少 `~/.opencode`、`~/.config/opencode`），命中不算命中；② 命中后**校验项目形态**（含 `.opencode/skills` 或 `opencode.json(c)` 等项目配置）才算数，并把实际使用的根与来源打印出来。判定方式补两条：从 **home 下的临时目录**调用时不得返回 home 目录；只有 `.opencode/` 而无 `skills`/项目配置的候选根不被采纳。

**为什么**：Windows 上 `~/.opencode` 是 opencode 的**运行时目录**（`source-cache/`、`plugins-cache/`、`plugins-data/`、`plugins-log/`、`skills/`、`node_modules/`、`package.json`），**不是项目根**。而「命中 `.opencode/` 即返回」对它同样成立：只要 cwd 在 home 之下（含系统临时目录），向上查找必然命中它并把 **home 目录**当成项目根——这正是「用错项目根」的实证，也解释了为什么本机「兜底返回 cwd」的取根用例不可达（只能 skip）。实证与推导见 [../design/技能评测隔离问题.md](../design/技能评测隔离问题.md) 的坑 B。

## `R6.2` 的 J2 定稿为「`directory` → `worktree` → 报错」（同日第八批）

**原来**：J2 写「项目根只来自调用方传入的 instance root；fallback 限定边界（不越过 worktree 根，或最多向上 N 层，N 为常量）」——把「向上查找」当成可选兜底，优先级与禁止项留白；实现侧 `execute` 只读 `args`，连 `ToolContext.directory` 都没往下传。

**现在**：J2 定稿为固定优先级 `ToolContext.directory` → `worktree` → 三段式报错（`错误：拿不到当前项目目录`）；`process.cwd()` 与向上查找**一律禁止**，「向上查找」降级为**仅独立 CLI 场景**（进程里没有 `ToolContext`）的兜底，且必须排除 `~/.opencode` / `~/.config/opencode`、校验项目形态、打印实际命中的根。判定方式改为：透传由 `test/dispatch-context.test.js` 守、两者皆空输出三段式（恰好三行）、`process.cwd` 打桩后不读、源码门禁：`src/cli/**` 与 `src/tool.ts` 内 `process.cwd()` 真实调用数 = 0；`§4` 的 `R6.2-J2` 行同步。

**为什么**：「最多向上 N 层」是个没有依据的魔数，而「向上找」本身就是坑 B 的根因——home 之下的 cwd 必然先命中 `~/.opencode`。B2 已把 `ToolContext` 透传到 `dispatch`，优先级可以写死成「拿不到就报错」，比留一个本机永远走不到的兜底分支更可验收。

## 第 7 个子命令 `install` 进入 help 与覆盖断言（同日第九批）

**原来**：第三批只把 `install` 写进 R2 表并标注「B5 实现」，同时写死「现有 6 个子命令的断言口径与 R3 的『help 覆盖 6 个子命令』保持不变，`install` 暂不计入该断言」。于是规范说 7 个、`help` 只列 6 个、测试只断言 6 个，三者不一致。

**现在**：R2 标题改为「固定 7 个子命令」，R3 与 `§4` 验收行的「6 个子命令 / 6 条示例」全部改为 7；`install` 仍标 **B5 实现**，并注明 `help` 文案、示例与覆盖断言已在 B2 落地，B5 只把 handler 换成真实现（当前调用返回「尚未实现」三段式）。`install` 的示例固定为 `skill_zh install`、`skill_zh install --dry-run`、`skill_zh install --force`。

**为什么**：`help` 是模型唯一的自解释入口，子命令存在却不在 `help` 里，模型就不可能调用它；而「规范 7 个、帮助 6 个、测试 6 个」这种三方不一致会在 B5 一次性爆出。把文案与断言提前到 B2，B5 只需替换 handler，改动面最小。

## `engines.node` 提到 `>= 22.3`，R7 补版本兼容门禁（同日第十批）

**原来**：`engines.node` 写 `>= 18`，而测试脚本已经用上 `node --test --experimental-test-module-mocks`（`mock.module` 需要该开关）——该 flag 在 Node < 22.3 上直接报未知参数；`§2 架构口径` 的「测试」行还写着「不传 glob 以兼容 Node 18/20」。声明与实际运行要求不一致，老 Node 用户装完跑测试就红。

**现在**：`engines.node` 改为 `>= 22.3`；`§2` 测试行改为 `node --test --experimental-test-module-mocks`，并注明该 flag 要求 Node ≥ 22.3、`engines.node` 必须同步；`§4 验收方式` 新增 **R7-Node** 一行：`engines.node` 与测试脚本用到的 Node flag 必须兼容（当前 `>=22.3` / `--experimental-test-module-mocks`），检查入口是 `grep -n "experimental-test-module-mocks" package.json`。

**为什么**：包声明的最低 Node 版本是承诺，测试脚本的 flag 是事实，冲突时以事实为准；把「改 flag 必须同批核对 engines」写成可 grep 的验收行，避免下次换 flag 又漏改。影响：仍跑 Node 18/20 的用户需先升级 Node 才能开发或跑测试（该 flag 只出现在 dev 脚本，安装后的插件运行不受影响）。

## B4 落地后补齐 §4 验收行（同日第十一批）

**原来**：SPEC 顶部状态写「B0/B1 完成，子命令业务待 B3/B4」，R6.2 开头写「`src/lib/run-eval.ts`，B4 才落地，当前未迁入」；`§4` 只有 J1/J2/J3/J6/J8 五行，缺 J4/J5/J7/J9，也没有 eval/optimize 子命令本身的验收行。

**现在**：状态行改为 B0–B4 已完成；R6.2 改为「B4 已落地」；`§4` 补 J4/J5/J7/J9 四行，并把 J2（home 下的临时目录不得返回 home、无形态候选不采纳）、J6（与已镜像配置合并、符号链接先摘链、可失败性）、J8（无同名技能时正常执行）细化；新增 `B4-eval` / `B4-optimize` 两行（选项生效、输出内容、报告落盘、三段式失败）。

**为什么**：文档里「当前未迁入」与代码事实相反；缺 J4/J5/J7/J9 会让「只做了一半」的实现照样通过验收；子命令本身没有验收行，就无法判断「接线」是否完成。

## B4 复核：J7 验收补「单条 query 阶段写入失败」（同日第十二批）

**原来**：`R6.2-J7` 只验收「启动前把 deny 配置写入打桩成抛错」这一条路径，没有覆盖「预检通过、正式评测根写入失败」的情况；而旧实现会把这类错误当成单条 query 的 `errored` 吞掉，评测继续并落一份报告。

**现在**：J7 验收补「**单条 query 阶段**写入失败同样整轮中止（不计入 `errored`、不产出报告）」。

**为什么**：预检根与正式评测根是两次独立写入，预检成功不代表正式写入一定成功（磁盘、权限、并发占用都可能变化）。只守预检等于只守了一半，真正的失败路径正好在两次写入之间。

## B5 落地：package / install 与 R6.1 I1–I5

**原来**：SPEC 的状态行与 `R6.1` 写着安装器「B5 才落地，当前未迁入」，`install` 行标「B5 实现」，§4 的 R2 验收还允许「install 返回尚未实现三段式」。I1–I5 只有要求，没有对应的实现与测试落点。

**现在**：状态改为 B0–B5 完成；`install` 行补 `--dir`；`R6.1` 改为「B5 已落地」；§4 的 R2 去掉「尚未实现」例外，I1–I3/I5 的判定方式改为点名实际测试文件（`lib-skill-install` / `cli-install` / `lib-install-conflict`），并新增 `B5-package` 与 `B5-install` 两行验收。

**为什么**：`package` / `install` 已是可运行实现，验收口径必须从「目标行为」切换为「可执行断言」；否则后续改动没有可失败的守门用例。

## B5 复核修正（must-fix + should-fix + nit）

**原来**：I3 只写「按发现链探测」，没有要求项目目录逐层、`skills/<任意层级>/SKILL.md` 与 frontmatter `name` 命中；安装器接受 `skill.md` 但 `validate` 只认 `SKILL.md`。

**现在**：I3 补「`directory` → `worktree` 逐层 + 任意层级 + 目录名/frontmatter name + 外部 → config → paths 生效顺序」；§4 的 I3 验收同步；`validate` 明确文件名不区分大小写（`skill.md` 等价），与安装器 I1 口径统一。

**为什么**：原实现只探项目单层且只看目录名，会漏掉真实会被加载的同名技能；两处大小写口径不一致会让「安装接受、校验拒绝」变成假失败。
