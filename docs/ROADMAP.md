# ROADMAP —— 从「14 个英文工具」到「1 个中文 CLI 工具」

逐批实施清单，每批按 **内容 → 涉及文件 → 验收方式** 写。顺序即实施顺序；B2 是地基，B3/B4 可并行，B5/B6 收尾。

基线：上游 `antongulin/opencode-skill-creator` v0.3.6，commit `d4383924e3d5bd3088195606d23fbdf25284d550`。

`.tmp/old/` **不是上游原文**，而是含 2 个 fork 提交的中间态（`69bcb56` 汉化技能、`221bb4e` 中文 CLI 骨架）：`plugin/package.json` 已改名、`plugin/skill/` 已汉化、`plugin/single-tool.ts` 已有 CLI 原型；**只有 `plugin/lib/**` 与基线 `d4383924` 一致**。B2/B3 迁 `lib/` 时一律以 `d4383924` 为基线，其余文件只当 fork 中间态参考，不得当作上游原文引用。

状态：**B0–B6 全部完成**（B3/B4/B5/B6 于 2026-10-29 落地并实测，见各批「实测结论」）。**CI 已补**（`.github/workflows/ci.yml`：push / PR 跑 typecheck + test + `npm pack --dry-run`）；**npm 发布尚未做**：`npm publish` 由用户手动执行，包尚未上线。

---

## B0 阶段 0：挂起旧仓与新仓初始化（已完成）

- **内容**：旧仓（含 2 个 fork 提交的中间态，见上文基线说明）整体移入 `.tmp/old/`，此后不再修改；新仓 `git init -b main`，**当前 0 提交**——文档层与 `skill/` 只落盘、尚未入库；技能目录取自 `.tmp/old/plugin/skill/`（已汉化版）原样拷贝到 `skill/`。
- **涉及文件**：`.tmp/old/**`（fork 中间态，只读，**不作为上游原文基线**）、`.gitignore`（沿用已有忽略项）、`skill/**`（6 个文件：`SKILL.md`、`agents/analyzer.md`、`agents/comparator.md`、`agents/grader.md`、`references/schemas.md`、`templates/eval-review.html`）、`README.md`、`docs/**`。
- **验收方式**：`skill/` 与 `.tmp/old/plugin/skill/` 逐文件 SHA256 一致（6/6）；`.gitignore` 含 `node_modules/`、`dist/`、`.tmp/`、`.io/`；文档中文且不含指向外部技能目录的引用；当前 `git status --short` 只显示未跟踪的 `.gitignore`、`README.md`、`docs/`、`skill/`（仓库 0 提交，验收不依赖 `git log`）。

## B1 工程骨架

- **内容**：
  - `package.json`：包名 `@xiaoqiong0v0/opencode-skill-creator-zh`、版本 `0.1.0`、`type: module`、`main` 指向 `dist/index.js`、`files: ["dist","skill","templates","README.md"]`（`templates` 于 B3 补入，`new` 运行必需）、`engines.node >= 22.3`（`test` 用 `--experimental-test-module-mocks`）、license `Apache-2.0`。
  - 脚本：`prebuild` 清 `dist/`；`build` = `npm run typecheck && tsc`；`typecheck` = `tsc --noEmit`；`test` = `node --test`（自动发现用例，不传 glob）；`prepack` = `npm test`（`test` 已含 build，不重复构建）。
  - `tsconfig.json`：`module`/`moduleResolution` = `NodeNext`、`target` 与 Node ≥22.3 匹配、`strict` 打开、`declaration: false`、`outDir: dist`、`include` 只覆盖 `src/`（`test/` 为纯 JS，由 `node --test` 执行，不进 tsc；口径见 [CONVENTIONS.md](CONVENTIONS.md)）。
  - 目录骨架：`src/`、`src/lib/`、`src/cli/`、`test/`、`scripts/`、`templates/`（`src/` 内先只放占位导出，保证 `build` 可跑）。
  - 根 `LICENSE`：已就位（Apache-2.0，与 `.tmp/old/LICENSE` 逐字节一致），本批只核对存在、不重写。
- **涉及文件**：`package.json`、`tsconfig.json`、`package-lock.json`（首次 `npm install` 生成）、`LICENSE`、`src/**`、`test/**`、`scripts/**`。
- **验收方式**：`npm run typecheck` 退出码 0；`npm run build` 产出 `dist/` 且 `git status` 不显示 `dist/`（已被忽略）；重复 `npm run build` 不会残留上一版文件；`npm pack --dry-run` 只列 `dist/`、`skill/`、`templates/`、`README.md`（及 LICENSE/package.json 等 npm 必带项）。

## B2 单工具壳：注册 / 分发 / help / 错误格式

- **内容**：
  - `src/index.ts`：V1 入口 `export default { id: "opencode-skill-creator-zh", server }`，`server` 内**唯一 1 处**工具注册，注册 `skill_zh`（`args: string`，description 用定稿值）。
  - `src/cli/`：`parseArgs`（支持 `--flag value` 与 `--flag=value`）、`dispatch`（7 子命令表）、`help.ts`（`HELP_TEXT`）、`errors.ts`（三段式构造器）。
  - **优先复用既有壳**：`.tmp/old/plugin/single-tool.ts` 已有 `skill_zh` 原型（`SUBCOMMANDS` L19–26、`TOOL_DESCRIPTION` L31 即定稿原文、`HELP_TEXT` L37–68 含 6 条示例），迁入时以它为基础改写，**不要从零重写**；其中 `package` 相关文案（「或 npm 包」、示例 `--out ./dist`）需按「只导出目录 + `--out` 必填」改写。
  - 错误覆盖 **4 类**（与 SPEC R5/R7 一致）：未知子命令 / 缺参 / 路径不存在 / 非法参数值，全部走 `errors.ts`；本批除 `help` 外子命令返回「尚未实现 + 对应 B3/B4/B5 批次」，不抛堆栈。
  - 调试开关：调用进程设 `SKILL_ZH_DEBUG=1` 时输出执行细节与原始错误；未置位时不外泄内部路径与堆栈（对应 [tools.md](tools.md) 通用约定的「调试」行）。**顺延至 B3**：当前除 `help` 外无真实错误路径、无抛点，接了 `lib/` 之后再落地。
- **涉及文件**：`src/index.ts`、`src/cli/parse-args.ts`、`src/cli/dispatch.ts`、`src/cli/help.ts`、`src/cli/errors.ts`、`test/cli-help.test.js`、`test/cli-errors.test.js`。
- **验收方式**：工具列表新增 1 项；`src/` 下工具注册调用点计数 = 1（R1）；`skill_zh help` 覆盖 7 子命令 + 每个子命令至少 1 条示例（R3；`install` 文案随本批落地，handler 到 B5 换真实现）；description 33 字符（R4）；4 类失败（未知子命令 / 缺参 / 路径不存在 / 非法参数值）满足三段式（R5）；`npm test` 全绿。`SKILL_ZH_DEBUG=1` 的验收（原本列在本批）随实现顺延至 B3。

## B3 逻辑迁入与 `new` / `validate`（已完成）

- **内容**：
  - 把上游 `plugin/lib/` 迁到 `src/lib/`（`validate.ts`、`utils.ts`、`process.ts`、`skill-install.ts` 等），**以基线 `d4383924` 为准**（`.tmp/old/plugin/lib/**` 与该基线一致），仅改导入路径与必要的中文化，不重构算法。
  - `new`：用 `templates/`（中文模板）生成 `SKILL.md` + `references/`；目标已存在时拒绝并提示 `--force`。
  - `validate`：接 `validateSkill`，输出中文结论 + 逐条问题的改法（含 description 长度、目录名与 `name` 一致性），错误与提示分开计数、一并输出；`--strict` 把 description 长度与命名规范从「提示」升级为「错误」（结论改判 `未通过（N 处错误…）`，退出码非 0），缺省仍为提示。
- **涉及文件**：`src/lib/**`（迁入）、`src/cli/new.ts`、`src/cli/validate.ts`、`src/cli/help.ts`（`validate` 用法补 `--strict`）、`templates/**`、`test/new.test.js`、`test/validate.test.js`。（实际落地：测试文件为 `test/cli-new.test.js` / `test/cli-validate.test.js`，另同批改 `src/cli/dispatch.ts` 接线、`package.json` 的 `files` 加 `templates`，并调整 `test/cli-errors.test.js`、`test/dispatch-context.test.js` 里「占位子命令」的取样对象。）
- **验收方式**：对一个真实技能目录跑通 `new` → `validate`；对故意写坏的 `SKILL.md`（缺 `name` / 描述超长 / 目录名不匹配）逐条给出可照做的改法；同一份含「描述超长」的目录在缺省下只提示、加 `--strict` 后判 `未通过（1 处错误）`（同批问题全部列出，不是三段式）；`new` 覆盖保护生效；`npm test` 全绿。
- **2026-10-29 实测结论**：`npm run typecheck` 退出码 0；`npm test` 206 例（205 通过、0 失败、1 个既有 skip：`findProjectRoot` 兜底分支在本机不可达），其中新增 `cli-new` 5 例、`cli-validate` 8 例全绿。临时目录手工跑通 `new demo-skill --dir .` → `validate demo-skill --strict`（结论「通过」，description 36 字符）；对 1030 字符 description 的目录，缺省输出「通过 + 1 处提示」、加 `--strict` 输出「未通过（1 处问题）」并定位到 `SKILL.md:3`。可失败性：把 `strict` 判定改成常量 `false` 后 `cli-validate` 立刻 2 例失败，恢复后回到全绿。**遗留**：B2 顺延的 `SKILL_ZH_DEBUG=1` 调试开关未在本批落地，仍待补。

## B4 `eval` / `optimize`（已完成）

- **内容**：
  - `eval`：接 `runEval`，输出通过率、逐条 query 触发结果、失败用例清单；支持 `--runs`、`--workers`。
  - `optimize`：接 `runLoop` + `improveDescription`，训练/测试集切分，输出每轮通过率与最终 description；支持 `--iterations`。
  - 上游 `opencode run` 调用失败、provider 不可用等错误统一转三段式（R5）。
  - **评测隔离根按 SPEC `R6.2` 的 J1–J5 实现**（上游 `.tmp/old/plugin/lib/run-eval.ts` 的做法只作参考，不照抄）：
    - J1 拒绝整目录递归拷贝：`symlinkSync` 失败时降级为逐文件拷贝已知条目（配置文档、被引用的相对文件、技能目录白名单），其余跳过；单文件大小上限提为常量。
    - J2 项目根只来自调用方传入的上下文，**优先级固定为 `ToolContext.directory` → `worktree` → 三段式报错**（`错误：拿不到当前项目目录`）；**禁止 `process.cwd()`、禁止向上查找**——不再有 `findProjectRoot()` 那种无边界向上找（`.tmp/old/plugin/lib/run-eval.ts:275-287`，壳层调用点 `skill-creator.ts:367`/`:1091`）。向上查找只在「独立 CLI 场景」（无 `ToolContext`）保留为兜底，且必须排除 `~/.opencode` / `~/.config/opencode`（运行时/配置目录，不是项目根）、校验项目形态后**输出实际命中的根**（含来源）。B2 已落地透传骨架：`src/tool.ts` → `dispatch(input, ctx)` → handler 的 `projectDir`（`test/dispatch-context.test.js` 守着）。
    - J3 保留 canonical 守卫：被测技能本体、其祖先目录、`skills` 根自身、指向 skills 的别名永不进入 `evalRoot`。
    - J4 `evalRoot` 清理放 `finally`：正常结束、抛错、取消三条路径都删，预取消时不创建。
    - J5 `SKILL_ZH_DEBUG=1` 时可打印镜像清单（条目、类型、字节数、跳过原因）；默认只输出一行汇总。
    - J6 全局同名技能**自动屏蔽**：执行前枚举可见技能，命中与被测技能基础名相同的条目时，在 `evalRoot/.opencode/opencode.json` 写 `permission.skill.<基础名> = "deny"`，不修改、移动、删除用户任何目录（取代上游「命中即中止、要用户先删自己装的技能」，`.tmp/old/plugin/lib/run-eval.ts:210-215`、`:221-236`）。
    - J7 deny 写不进或目标版本不支持按名 deny 时**回退成冲突中止**，并把冲突实际路径 + 可复制的处置命令打进三段式；不静默放行。
    - J8 提供 `--no-shadow-guard`：关闭自动屏蔽，行为回到「检测到冲突即中止」。
    - J9 **镜像范围固定为方案 C（四项缺一不可）**：合成技能本体 + 项目根 `opencode.json(c)` 及其引用文件（丢了丢 provider / agent / model 与项目指令）+ `.opencode/` 除 `skills` 外全部条目 + `.opencode/skills/` 除被测技能外的兄弟技能；四项之外不放行，方式一律逐条目/逐文件 + 单文件大小上限。
  - **镜像方案已定 C（2026-10-29）**：保留兄弟技能与配置文档镜像，只修掉整目录递归拷贝。决策记录与理由（评测要预测真实竞争、`deny` 已解决同名遮挡、「拷多余」病根在递归拷贝而非镜像语义）见 [design/技能评测隔离问题.md](design/技能评测隔离问题.md)；`tools.md` 的 `eval` 说明同批按 C 写死。坑 F（同名遮挡）与镜像范围正交，方案 C 同样要处理。
  - **同批产出 `docs/ASYNC.md`**：登记 eval / optimize 的并发交互点——多 worker 并发调用 `opencode run` 的并发上限与配额、共享结果收集容器、单条 query 超时与取消、评测产物落盘的写入顺序与覆盖规则、临时目录清理。写法与门禁见项目文档规范；**已在本批创建 [ASYNC.md](ASYNC.md)**。
- **涉及文件**：`src/cli/eval.ts`、`src/cli/optimize.ts`、`src/cli/eval-common.ts`（共用参数/评测集/报告）、`src/lib/run-eval.ts`、`src/lib/run-loop.ts`、`src/lib/improve-description.ts`、`src/lib/debug.ts`（`SKILL_ZH_DEBUG`）、`docs/ASYNC.md`（同批新增）、`test/lib-run-eval-e2e.test.js`（迁上游 14 条端到端）、`test/lib-run-eval-j.test.js`（J1/J5–J9 + 源码门禁）、`test/cli-eval.test.js`、`test/cli-optimize.test.js`。
- **验收方式**：对一个真实技能 + 评测集跑通 `eval` 与 `optimize`，输出含通过率与最终 description；`--runs` / `--workers` / `--iterations` 缺值或非法值走三段式；评测产物落盘路径与文档一致；`docs/ASYNC.md` 的每条交互点都能指到具体 `src/` 位置（共享状态 / 保护手段 / 顺序契约 / 位置四要素齐全）；隔离根满足 R6.2——打桩 `symlinkSync` 失败后 `evalRoot` 无 `node_modules/`、`dist/`、`.git/`（J1）；子目录调用评测时路径基准为 `ToolContext.directory`（次选 `worktree`），`src/cli/**` 与 `src/tool.ts` 内 `process.cwd()` 真实调用数 = 0 且不做向上查找（J2）；从 home 下的临时目录调用时**不得**把 home 或 `~/.opencode` 当成项目根（J2，仅独立 CLI 兜底路径适用）；被测与兄弟技能同存时 `evalRoot` 内按内容哈希搜不到被测技能，三类别名均被拒（J3）；成功 / 抛错 / 取消三路径结束后临时根不存在（J4）；`SKILL_ZH_DEBUG=1` 的镜像清单与磁盘内容一致（J5）；探测目录放同名全局技能后，`evalRoot/.opencode/opencode.json` 出现 `permission.skill.<基础名> = "deny"` 且探测目录哈希不变（J6）；把该配置写入打桩成失败时以三段式中止、改法含实际路径与可复制命令（J7）；加 `--no-shadow-guard` 时不写 deny 且同名存在时中止（J8）；`evalRoot` 的顶层条目 = 合成技能 + 根配置文档及引用 + `.opencode/` 非 skills 条目 + 兄弟技能，无四项之外的内容且被测技能不在（J9）；`npm test` 全绿。

- **2026-10-29 实测结论**：`npm run typecheck` 退出码 0；`npm test` **256 例全绿（256 通过 / 0 失败 / 0 skip；本机支持符号链接，符号链接相关用例未 skip）**，其中新增 `lib-run-eval-e2e` 17 例（迁上游未迁的端到端 14 例 + J4 清理 3 例；假 `opencode` 放 PATH，无真实模型）、`cli-eval` 7 例、`cli-optimize` 5 例、`lib-run-eval-j` 12 例（J1/J5/J6/J7/J8/J9 + J1/J2 源码门禁 + 入口符号链接 / jsonc / 枚举不可用 / 整轮中止）。源码门禁 `cpSync(.*recursive` 在 `src/` 命中 0（`cpSync` 已整体移除）。手工用假 `opencode` 跑 `skill_zh eval ./skills/api-doc-writer --runs 1 --workers 1`：输出通过率 0.67（2/3）、逐条结果、失败用例、`镜像：3 个条目，链接镜像（跳过 0 项）` 与报告路径，未产生费用。可失败性：注释掉 `applySkillDeny` 后 `J6 命中同名技能时在隔离根写 deny` 立即变红（1 失败），还原后 1/1 通过。**遗留**：B2/B3 顺延的 `SKILL_ZH_DEBUG=1` 已在 B4 落地（镜像清单 + 跳过原因），但「原始异常堆栈」只进日志、不回给模型（保持 R5 三段式）。

## B5 `package` 与技能入包（已完成）

- **内容**：
  - **新增第 7 个子命令 `install`**：把包内 `skill/` 装到用户级技能目录（`~/.config/opencode/skills/opencode-skill-creator-zh/`），是冲突探测、白名单拷贝、元数据外置的唯一入口。**加它的理由**：安装器跑在插件启动钩子里，CLI 参数传不进去，所以「有冲突时怎么处置」只能由用户显式调用子命令完成。三条行为：
    1. `--dry-run`：只做探测与报告（同名技能、将写入/跳过的文件名），**不写盘**；
    2. `--force`：才用包内版本覆盖用户改过的 `SKILL.md`（覆盖前先把用户版本备份到状态目录）；
    3. 默认（无参，即启动钩子的行为）：**无冲突时静默安装**；有冲突（发现同名技能或检测到用户改过 `SKILL.md`）时**只提示、不覆盖**，提示里给出 `skill_zh install --dry-run` / `--force` 的下一步。
  - `install` 的 `help` 文案、示例与「可用子命令」列表已在 B2 落地（占位 handler 返回「尚未实现」三段式；SPEC R2/R3 断言改为覆盖 7 个），B5 已把 handler 换成真实现。
  - `package` 子命令：**只导出目录**（不产出 npm 包），`--out <产物路径>` 必填；导出后做结构自检（`SKILL.md` 存在、`references/` 存在、目录名 = `name`）。导出内容走同一份**白名单**（`SKILL.md`、`agents/**`、`references/**`、`templates/**`），不含安装器元数据。发布到 npm 由用户手动执行（`npm publish --access public`），子命令不代发。
  - 技能入包落地：`skill/` 与 `dist/` 平级随包分发；安装器把 `skill/` 装到 `~/.config/opencode/skills/opencode-skill-creator-zh/`。
  - **白名单拷贝**：安装与导出只写白名单四项，白名单外条目跳过（`SKILL_ZH_DEBUG=1` 时告警）；白名单比较不区分大小写（Windows/macOS 上 `SKILL.md` 与 `skill.md` 同一文件）。取代上游整目录递归拷（`.tmp/old/plugin/lib/skill-install.ts:74-85`）。
  - **元数据外置**：安装版本、属主文件清单（相对路径 + 内容哈希）、用户改动备份一律写 `~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json`（备份同目录、带时间戳），技能目录内**只留技能本体**。不沿用上游写在技能目录内的 `.opencode-skill-creator-version` / manifest / `SKILL.md.user-backup`（`.tmp/old/plugin/lib/skill-install.ts:19`、`:27`、`:324`）。
  - **外部目录探测**：安装前按 opencode v1.18.25 `packages/opencode/src/skill/index.ts:185-227` 的发现链探测同名技能（用户级 + 项目逐层的 `.claude/skills`、`.agents/skills`、`~/.config/opencode/{skill,skills}`、`skills.paths`），遵守 `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`；**只提示不改写**，提示里写明按扫描顺序当前哪个生效，以及真正能禁用的动作（改 `SKILL.md` 文件名 / 移出 `skills/` / 改 `name` / 权限 deny / 环境变量关外部来源）——**不给「重命名目录」**。
  - **用户改动保护**：`SKILL.md` 与状态文件记录的哈希不一致时默认不覆盖，提示 `--force`；`--force` 才用包内版本覆盖并把用户版本备份到状态目录。辅助文件仍随包更新。
  - 安装器**只**在目标技能目录与状态目录内写/删，不触碰其它技能目录（含上游 `opencode-skill-creator/`），也不像上游那样把同级 `skill-creator/` 改名归档（`.tmp/old/plugin/lib/skill-install.ts:297-313`、`:391-397`）。
  - 约束来源与完整测试点见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)；需求口径见 [SPEC.md 的 `R6.1`](SPEC.md#r61-技能安装约束)。
- **涉及文件**：`src/cli/install.ts`（新增：`--dry-run` / `--force` 与冲突提示）、`src/cli/package.ts`（导出白名单与 `--out` 校验）、`src/lib/skill-install.ts`（白名单拷贝、状态目录、外部目录探测、用户改动保护全部在这里）、`src/index.ts`（启动时安装钩子）、`test/package.test.js`、`test/skill-install.test.js`。
- **验收方式**：`skill_zh install --dry-run` 在无冲突目录下不产生任何文件（比对运行前后目录快照）；在探测目录放同名技能后，`--dry-run` 与默认行为都点名该路径且**不覆盖**；用户改过 `SKILL.md` 后默认安装不覆盖、`install --force` 才覆盖且用户版本进状态目录备份；`package` 缺 `--out` 时按「缺参」走三段式，给出带 `--out` 的示例；导出产物结构自检通过、与源技能目录逐文件一致且不含元数据（R6.1-I2）；`npm pack --dry-run` 含 `dist/`、`skill/`、`templates/`、`README.md` 且无源码泄漏（R6/R7）；本地装入后 `~/.config/opencode/skills/opencode-skill-creator-zh/` 内容 = 源 `skill/` 白名单集合，目录内无点开头条目、无 `*.user-backup`（R6.1-I1/I2）；构造含 `dist/`、`bin/`、`test/` 的源目录安装后目标无这些条目（R6.1-I1）；大小写变体（`skill.md`、`Skill.MD`）走同一判据（R6.1-I1 附带断言）；探测目录放同名技能时输出点名该路径且探测目录哈希不变（R6.1-I3）；手工改 `SKILL.md` 后重装内容不变 + 提示 `--force`，`--force` 后为包内版本且状态目录有备份（R6.1-I5）；与上游英文技能同时安装互不覆盖；卸载只删本包技能目录与状态文件。

- **2026-10-29 实测结论**：`npm run typecheck` 退出码 0；`npm test` **275 例全绿**（275 通过 / 0 失败 / 0 skip），新增 `cli-package` 6 例、`cli-install` 5 例、`lib-install-conflict` 7 例、重写 `lib-skill-install` 8 例。手工在临时 HOME 跑 `install --dry-run`：输出「预览（未写盘）」与将写入清单，运行后目标目录仍不存在；真实 `install`：目标目录 6 个文件 = 包内白名单集合（`SKILL.md`、`agents/analyzer.md`、`agents/comparator.md`、`agents/grader.md`、`references/schemas.md`、`templates/eval-review.html`），状态文件在 `.skill-zh-state/opencode-skill-creator-zh.json`，技能目录无点开头条目。可失败性：把白名单判定临时改成「全部放行」后 `lib-skill-install` 的「只拷白名单条目」立即变红；还原后回到全绿。

## B6 技能正文与文案口径统一（已完成）

- **内容**：
  - `skill/SKILL.md` 与 `skill/agents/*.md`、`skill/references/schemas.md` 中仍点名上游 `skill_*` 工具的段落，改写为 `skill_zh <子命令>` 口径。改写前统计（逐处核对，作验收基线）：`SKILL.md` 里 **9 个不同的上游工具名、共 14 处**——`skill_validate` 2、`skill_parse` 1、`skill_improve_description` 1、`skill_optimize_loop` 1、`skill_aggregate_benchmark` 2、`skill_generate_report` 1、`skill_serve_review` 2、`skill_stop_review` 2、`skill_export_static_review` 2；`agents/`、`references/`、`templates/` 内无工具名引用（`skill_name` / `skill_path` 是字段名，不算）。
  - 正文里的「配套插件工具一览」表按 **7 个子命令**重写（补 `install`）；benchmark 汇总与 HTML 报告相关步骤改写为「走 `eval` 的输出」，review / gold 相关步骤改写为「本版不提供工具，走手工流程」。
  - 文档一致性收尾：`README.md`、`docs/` 与 `skill/SKILL.md` 的子命令名、错误格式、安装路径三处口径对齐。
- **涉及文件**：`skill/SKILL.md`、`skill/agents/analyzer.md`、`skill/agents/comparator.md`、`skill/agents/grader.md`、`skill/references/schemas.md`、`README.md`、`docs/**`、[changes/skill-SKILL.20261029.md](changes/skill-SKILL.20261029.md)（技能正文属约定改动，需留痕）。
- **验收方式**：`skill/` 下搜 `skill_(validate|parse|eval|improve_description|optimize_loop|aggregate_benchmark|generate_report|serve_review|stop_review|export_static_review|add_gold_standard|list_gold_standards|remove_gold_standard|get_gold_advice)` 零命中；`skill_zh` 的 7 个子命令名在正文中出现且与 `HELP_TEXT` 一致；`skill/` 仍是唯一一份技能副本（R6/R7）；文档交叉引用链接可达。
- **2026-10-29 实测结论**：`skill/SKILL.md`、`skill/agents/*.md`、`skill/references/schemas.md` 全部改写完成——上述 14 处上游工具名 **14 → 0**（`skill/` 下用验收正则搜索命中 0）；正文 §8 表格为 7 个子命令（`help`/`new`/`validate`/`eval`/`optimize`/`package`/`install`）且与 `src/cli/help.ts` 的 `HELP_TEXT` 一致；`agents/` 三个文件未含工具名引用。改写内容与「本版不提供的能力」口径见 [changes/skill-SKILL.20261029.md](changes/skill-SKILL.20261029.md)。
