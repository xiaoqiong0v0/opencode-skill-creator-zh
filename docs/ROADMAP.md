# ROADMAP —— 从「14 个英文工具」到「1 个中文 CLI 工具」

逐批实施清单，每批按 **内容 → 涉及文件 → 验收方式** 写。顺序即实施顺序；B2 是地基，B3/B4 可并行，B5/B6 收尾。

基线：上游 `antongulin/opencode-skill-creator` v0.3.6，commit `d4383924e3d5bd3088195606d23fbdf25284d550`。

`.tmp/old/` **不是上游原文**，而是含 2 个 fork 提交的中间态（`69bcb56` 汉化技能、`221bb4e` 中文 CLI 骨架）：`plugin/package.json` 已改名、`plugin/skill/` 已汉化、`plugin/single-tool.ts` 已有 CLI 原型；**只有 `plugin/lib/**` 与基线 `d4383924` 一致**。B2/B3 迁 `lib/` 时一律以 `d4383924` 为基线，其余文件只当 fork 中间态参考，不得当作上游原文引用。

状态：B0 已完成；B1–B6 未开始。

---

## B0 阶段 0：挂起旧仓与新仓初始化（已完成）

- **内容**：旧仓（含 2 个 fork 提交的中间态，见上文基线说明）整体移入 `.tmp/old/`，此后不再修改；新仓 `git init -b main`，**当前 0 提交**——文档层与 `skill/` 只落盘、尚未入库；技能目录取自 `.tmp/old/plugin/skill/`（已汉化版）原样拷贝到 `skill/`。
- **涉及文件**：`.tmp/old/**`（fork 中间态，只读，**不作为上游原文基线**）、`.gitignore`（沿用已有忽略项）、`skill/**`（6 个文件：`SKILL.md`、`agents/analyzer.md`、`agents/comparator.md`、`agents/grader.md`、`references/schemas.md`、`templates/eval-review.html`）、`README.md`、`docs/**`。
- **验收方式**：`skill/` 与 `.tmp/old/plugin/skill/` 逐文件 SHA256 一致（6/6）；`.gitignore` 含 `node_modules/`、`dist/`、`.tmp/`、`.io/`；文档中文且不含指向外部技能目录的引用；当前 `git status --short` 只显示未跟踪的 `.gitignore`、`README.md`、`docs/`、`skill/`（仓库 0 提交，验收不依赖 `git log`）。

## B1 工程骨架

- **内容**：
  - `package.json`：包名 `@xiaoqiong0v0/opencode-skill-creator-zh`、版本 `0.1.0`、`type: module`、`main` 指向 `dist/index.js`、`files: ["dist","skill","README.md"]`、`engines.node >= 18`、license `Apache-2.0`。
  - 脚本：`prebuild` 清 `dist/`；`build` = `tsc`；`typecheck` = `tsc --noEmit`；`test` = `node --test "test/**/*.test.js"`；`prepack` = `npm run build && npm test`。
  - `tsconfig.json`：`module`/`moduleResolution` = `NodeNext`、`target` 与 Node ≥18 匹配、`strict` 打开、`declaration: false`、`outDir: dist`、`include` 覆盖 `src/` 与 `test/`（口径见 [CONVENTIONS.md](CONVENTIONS.md)）。
  - 目录骨架：`src/`、`src/lib/`、`src/cli/`、`test/`、`scripts/`、`templates/`（`src/` 内先只放占位导出，保证 `build` 可跑）。
  - 根 `LICENSE`：已就位（Apache-2.0，与 `.tmp/old/LICENSE` 逐字节一致），本批只核对存在、不重写。
- **涉及文件**：`package.json`、`tsconfig.json`、`package-lock.json`（首次 `npm install` 生成）、`LICENSE`、`src/**`、`test/**`、`scripts/**`。
- **验收方式**：`npm run typecheck` 退出码 0；`npm run build` 产出 `dist/` 且 `git status` 不显示 `dist/`（已被忽略）；重复 `npm run build` 不会残留上一版文件；`npm pack --dry-run` 只列 `dist/`、`skill/`、`README.md`（及 LICENSE/package.json 等 npm 必带项）。

## B2 单工具壳：注册 / 分发 / help / 错误格式

- **内容**：
  - `src/index.ts`：V1 入口 `export default { id: "opencode-skill-creator-zh", server }`，`server` 内**唯一 1 处**工具注册，注册 `skill_zh`（`args: string`，description 用定稿值）。
  - `src/cli/`：`parseArgs`（支持 `--flag value` 与 `--flag=value`）、`dispatch`（6 子命令表）、`help.ts`（`HELP_TEXT`）、`errors.ts`（三段式构造器）。
  - **优先复用既有壳**：`.tmp/old/plugin/single-tool.ts` 已有 `skill_zh` 原型（`SUBCOMMANDS` L19–26、`TOOL_DESCRIPTION` L31 即定稿原文、`HELP_TEXT` L37–68 含 6 条示例），迁入时以它为基础改写，**不要从零重写**；其中 `package` 相关文案（「或 npm 包」、示例 `--out ./dist`）需按「只导出目录 + `--out` 必填」改写。
  - 错误覆盖 **4 类**（与 SPEC R5/R7 一致）：未知子命令 / 缺参 / 路径不存在 / 非法参数值，全部走 `errors.ts`；本批除 `help` 外子命令返回「尚未实现 + 对应 B3/B4/B5 批次」，不抛堆栈。
  - 调试开关：调用进程设 `SKILL_ZH_DEBUG=1` 时输出执行细节与原始错误；未置位时不外泄内部路径与堆栈（对应 [tools.md](tools.md) 通用约定的「调试」行）。
- **涉及文件**：`src/index.ts`、`src/cli/parse-args.ts`、`src/cli/dispatch.ts`、`src/cli/help.ts`、`src/cli/errors.ts`、`test/cli-help.test.js`、`test/cli-errors.test.js`。
- **验收方式**：工具列表新增 1 项；`src/` 下工具注册调用点计数 = 1（R1）；`skill_zh help` 覆盖 6 子命令 + 6 示例（R3）；description 33 字符（R4）；4 类失败（未知子命令 / 缺参 / 路径不存在 / 非法参数值）满足三段式（R5）；`SKILL_ZH_DEBUG=1` 时才出现内部细节；`npm test` 全绿。

## B3 逻辑迁入与 `new` / `validate`

- **内容**：
  - 把上游 `plugin/lib/` 迁到 `src/lib/`（`validate.ts`、`utils.ts`、`process.ts`、`skill-install.ts` 等），**以基线 `d4383924` 为准**（`.tmp/old/plugin/lib/**` 与该基线一致），仅改导入路径与必要的中文化，不重构算法。
  - `new`：用 `templates/`（中文模板）生成 `SKILL.md` + `references/`；目标已存在时拒绝并提示 `--force`。
  - `validate`：接 `validateSkill`，输出中文结论 + 逐条问题的改法（含 description 长度、目录名与 `name` 一致性）；`--strict` 把 description 长度与命名规范从「提示」升级为「错误」（非零退出 + 三段式），缺省仍为提示。
- **涉及文件**：`src/lib/**`（迁入）、`src/cli/new.ts`、`src/cli/validate.ts`、`src/cli/help.ts`（`validate` 用法补 `--strict`）、`templates/**`、`test/new.test.js`、`test/validate.test.js`。
- **验收方式**：对一个真实技能目录跑通 `new` → `validate`；对故意写坏的 `SKILL.md`（缺 `name` / 描述超长 / 目录名不匹配）逐条给出可照做的改法；同一份含「描述超长」的目录在缺省下只提示、加 `--strict` 后判失败并走三段式；`new` 覆盖保护生效；`npm test` 全绿。

## B4 `eval` / `optimize`

- **内容**：
  - `eval`：接 `runEval`，输出通过率、逐条 query 触发结果、失败用例清单；支持 `--runs`、`--workers`。
  - `optimize`：接 `runLoop` + `improveDescription`，训练/测试集切分，输出每轮通过率与最终 description；支持 `--iterations`。
  - 上游 `opencode run` 调用失败、provider 不可用等错误统一转三段式（R5）。
  - **同批产出 `docs/ASYNC.md`**：登记 eval / optimize 的并发交互点——多 worker 并发调用 `opencode run` 的并发上限与配额、共享结果收集容器、单条 query 超时与取消、评测产物落盘的写入顺序与覆盖规则、临时目录清理。写法与门禁见项目文档规范；**本批只在计划里立项，不在当前批次创建空文件**。
- **涉及文件**：`src/cli/eval.ts`、`src/cli/optimize.ts`、`src/lib/run-eval.ts`、`src/lib/run-loop.ts`、`src/lib/improve-description.ts`、`docs/ASYNC.md`（同批新增）、`test/eval.test.js`、`test/optimize.test.js`。
- **验收方式**：对一个真实技能 + 评测集跑通 `eval` 与 `optimize`，输出含通过率与最终 description；`--runs` / `--workers` / `--iterations` 缺值或非法值走三段式；评测产物落盘路径与文档一致；`docs/ASYNC.md` 的每条交互点都能指到具体 `src/` 位置（共享状态 / 保护手段 / 顺序契约 / 位置四要素齐全）；`npm test` 全绿。

## B5 `package` 与技能入包

- **内容**：
  - `package` 子命令：**只导出目录**（不产出 npm 包），`--out <产物路径>` 必填；导出后做结构自检（`SKILL.md` 存在、`references/` 存在、目录名 = `name`）。发布到 npm 由用户手动执行（`npm publish --access public`），子命令不代发。
  - 技能入包落地：`skill/` 与 `dist/` 平级随包分发；安装器把 `skill/` 装到 `~/.config/opencode/skills/opencode-skill-creator-zh/`，升级时保留用户对 `SKILL.md` 的改动。
  - 安装器**只**在目标技能目录内写/删，不触碰其它技能目录（含上游 `opencode-skill-creator/`）。
- **涉及文件**：`src/cli/package.ts`、`src/lib/skill-install.ts`、`src/index.ts`（启动时安装钩子）、`test/package.test.js`、`test/skill-install.test.js`。
- **验收方式**：`package` 缺 `--out` 时按「缺参」走三段式，给出带 `--out` 的示例；导出产物结构自检通过、与源技能目录逐文件一致；`npm pack --dry-run` 含 `dist/`、`skill/`、`README.md` 且无源码泄漏（R6/R7）；本地装入后 `~/.config/opencode/skills/opencode-skill-creator-zh/` 内容与包内 `skill/` 一致；与上游英文技能同时安装互不覆盖；卸载只删本包技能目录。

## B6 技能正文与文案口径统一

- **内容**：
  - `skill/SKILL.md` 与 `skill/agents/*.md`、`skill/references/schemas.md` 中仍点名上游 `skill_*` 工具的段落，改写为 `skill_zh <子命令>` 口径。当前统计（逐处核对，可直接作验收基线）：`SKILL.md` 里 **9 个不同的上游工具名、共 14 处**——`skill_validate` 2、`skill_parse` 1、`skill_improve_description` 1、`skill_optimize_loop` 1、`skill_aggregate_benchmark` 2、`skill_generate_report` 1、`skill_serve_review` 2、`skill_stop_review` 2、`skill_export_static_review` 2；`agents/`、`references/`、`templates/` 内无工具名引用（`skill_name` / `skill_path` 是字段名，不算）。
  - 正文里的「§8 配套插件工具一览」表按 6 子命令重写；benchmark 汇总与 HTML 报告相关步骤改写为「走 `eval` 的输出」，review / gold 相关步骤改写为「本版不提供工具，走手工流程」。
  - 文档一致性收尾：`README.md`、`docs/` 与 `skill/SKILL.md` 的子命令名、错误格式、安装路径三处口径对齐。
- **涉及文件**：`skill/SKILL.md`、`skill/agents/analyzer.md`、`skill/agents/comparator.md`、`skill/agents/grader.md`、`skill/references/schemas.md`、`README.md`、`docs/**`、`docs/changes/skill-SKILL.<YYYYMMDD>.md`（技能正文属约定改动，需留痕）。
- **验收方式**：`skill/` 下搜 `skill_(validate|parse|eval|improve_description|optimize_loop|aggregate_benchmark|generate_report|serve_review|stop_review|export_static_review|add_gold_standard|list_gold_standards|remove_gold_standard|get_gold_advice)` 零命中；`skill_zh` 6 子命令名在正文中出现且与 `HELP_TEXT` 一致；`skill/` 仍是唯一一份技能副本（R6/R7）；文档交叉引用链接可达。
