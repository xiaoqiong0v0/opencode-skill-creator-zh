# 异步 / 并发交互点清单

[文档索引](README.md) · [需求与验收](SPEC.md) · [实施批次](ROADMAP.md)

本文件把 `eval` / `optimize` 里**隐性的并发契约显性化**：每个交互点写清四要素——**共享状态**、**保护手段**、**顺序契约**、**位置**。新增或改动并发点必须同批更新本文件，并在测试里留下可失败断言；否则视为未完成（门禁见 §8）。

> 适用范围：`skill_zh eval` / `skill_zh optimize` 及其底层 `src/lib/run-eval.ts`、`src/lib/run-loop.ts`、`src/lib/process.ts`、`src/lib/improve-description.ts`。`new` / `validate` 是纯同步实现，不在此列。

## 总览

| # | 交互点 | 共享状态 | 一句话保护手段 |
|---|---|---|---|
| 1 | [多 worker 结果收集](#1-多-worker-结果收集) | `jobResults` / `idx` / `mirrorTotals` | 单线程串行临界区，不跨 `await` |
| 2 | [opencode 子进程池](#2-opencode-子进程池) | 同时存活的子进程数、provider 配额 | worker 数封顶 + 每个 worker 串行 await |
| 3 | [evalRoot 生命周期](#3-evalroot-生命周期) | 系统临时目录 | 每 query 独立 `mkdtemp`，`finally` 删除 |
| 4 | [deny 配置写入时机](#4-deny-配置写入时机) | 隔离根内 `.opencode/opencode.json` | spawn 前写入 + 符号链接先摘链 |
| 5 | [报告与日志落盘](#5-报告与日志落盘) | `logDir` 下的文件 | 唯一文件名 / 单写者 |
| 6 | [取消信号传播](#6-取消信号传播) | `AbortSignal` | 队列检查 + 子进程 SIGTERM→SIGKILL |
| 7 | [调试输出](#7-调试输出) | stderr | 整行写，顺序不作保证 |

## 1. 多 worker 结果收集

- **共享状态**：`jobResults`（逐次运行结果数组）、`idx`（共享任务游标）、`mirrorTotals`（镜像汇总计数器）、`fatalError`（隔离准备失败的整轮中止标记）。
- **保护手段**：Node 单进程事件循环 + 临界区内没有 `await`：`idx++` 取任务、`jobResults.push(...)`、`mirrorTotals.entries += ...`、`fatalError = e` 都在同一个同步片段里完成，因此不需要锁；也不做跨进程共享（每个 query 是独立子进程，结果只回到父进程内存）。
- **顺序契约**：结果以 **`itemIndex`**（评测集数组下标）为聚合键，绝不按 query 文本分组——重复 query 保持独立；返回顺序固定为评测集顺序，`runLoop` 依赖这个顺序把结果按位置切回训练/测试集。镜像汇总只做加法，与完成顺序无关。`fatalError` 非空时其他 worker 不再取任务，整轮以该错误 reject，**不产出评分/报告**（J7）。
- **位置**：`src/lib/run-eval.ts` 的 `runEval`（游标与 `mirrorTotals`）、`worker()`、`aggregateEvalResults()`。

## 2. opencode 子进程池

- **共享状态**：同时存活的 `opencode run` 子进程数量，以及与之绑定的 provider 配额 / 费用。
- **保护手段**：worker 数量 = `min(numWorkers, jobs.length)`，默认 `--workers 1`；每个 worker **串行** `await` 一个子进程，不出现无界并发；`runProcess` 统一 `stdio: ["ignore","pipe","pipe"]`（stdin 关闭，避免 `opencode` 阻塞），超时先 `SIGTERM`、默认 1 s 宽限后 `SIGKILL`。
- **顺序契约**：子进程只在「同名技能枚举 → deny 预检」完成之后启动；每个 query 使用自己的 `cwd` 与 `PWD`（都钉到该 query 的 `evalRoot`），不继承调用方 PWD；提前命中触发时主动结束该子进程（`triggerOnly`）；`optimize` 的改善子进程与评测共用同一个 `--timeout`（秒）。
- **位置**：`src/lib/run-eval.ts` `runEval` 的 `workers` 构造与 `runSingleQuery`；`src/lib/process.ts` `runProcess`。

## 3. evalRoot 生命周期

- **共享状态**：系统临时目录下的 `opencode-skill-eval-*` 目录。
- **保护手段**：**每个 query 独立** `mkdtempSync`，绝不跨 worker 复用或共享（并行 worker 互相看不见对方合成的技能）；清理放在 `finally`，正常结束 / 抛错 / 取消三条路径都删除；`rmSync` 失败只写调试日志，**不得掩盖原始错误**；调用前已取消则既不建目录也不 spawn；deny 预检用的探针根同样是独立 `mkdtemp` + `finally`。
- **顺序契约**：镜像 → 写 deny → 写合成 `SKILL.md` → spawn；删除只发生在该 query 的 `finally`，且在子进程退出（或被杀死）之后。
- **位置**：`src/lib/run-eval.ts` `runSingleQuery`（`mkdtempSync` / `finally`）、`preflightSkillDeny`。

## 4. deny 配置写入时机

- **共享状态**：`evalRoot/.opencode/opencode.json` 或 `.opencode/opencode.jsonc`（**仅在隔离根内**，与用户目录无关；优先写项目实际存在的那个文件，都没有则新建 `opencode.json`）。
- **保护手段**：每个 `evalRoot` 各自写一份；写入前先读入现有 JSONC 再合并，不丢其它 `permission` 键；目标若是指向用户源文件的符号链接，**先 `unlink` 再写普通文件**，杜绝写穿；主进程内写入是同步 `fs` 调用，不存在并发写同一文件的窗口。单条 query 写入失败按 J7 **中止整轮**（不记为单条错误）。
- **顺序契约**：枚举可见技能**每次 `runEval` 调用一次**（`optimize` 每轮各一次）；命中同名时先在探针根验证「deny 能写进去」，验证失败立刻以 `ShadowGuardError` 中止（不 spawn 任何评测子进程）；正式写入发生在每个 query「镜像完成之后、spawn 之前」。`--no-shadow-guard` 时不写 deny，改为命中即中止。
- **位置**：`src/lib/run-eval.ts` `applySkillDeny`、`preflightSkillDeny`、`resolveShadowGuard`、`runSingleQuery` 内的调用点。

## 5. 报告与日志落盘

- **共享状态**：`<logDir>` 下的报告文件（`eval` 默认 `<技能目录>/.evals/`；`optimize` 默认 `<技能目录>/.evals/optimize-<时间戳>-<随机>/`）。
- **保护手段**：`eval` 结束后**单次**写 JSON，文件名 = `eval-<ISO 时间戳>-<4 位随机后缀>.json`，同一毫秒的并发调用也不会互相覆盖；`optimize` 每次运行落**独立子目录**，其中的实时 HTML 由 `runLoop` **串行迭代**覆盖写（单写者），每轮的改善记录写成 `improve_iter_<n>.json`；worker 只回填内存结果，**不写文件**。
- **顺序契约**：先 `mkdirSync(logDir, { recursive: true })` 再写；报告在评测/循环结束后写，不参与评分；`optimize` 的 HTML 在每轮结束后刷新、JSON 在循环结束后写。
- **位置**：`src/cli/eval-common.ts` `writeJsonReport`；`src/lib/run-loop.ts` `liveReportPath` 写入点与 `improveDescription` 调用；`src/lib/improve-description.ts` 的 `logDir` 写入。

## 6. 取消信号传播

- **共享状态**：调用方传入的 `AbortSignal`（同一实例贯穿评测与改善子进程）。
- **保护手段**：`runEval` 在每个 worker 取任务前检查 `signal.aborted`；`runProcess` 监听 `abort`，先 `SIGTERM`、宽限期后 `SIGKILL`，并把结果标记为 `aborted`；`runLoop` 在每轮开头、评测前、改善前都检查。
- **顺序契约**：预取消（调用前已 abort）**不 spawn、不建 evalRoot**；运行中取消以 `AbortError` 上报，**绝不计成一条失败的评测结果**（否则会把「没跑完」误报成阴性）；排队中的任务在取消后不再启动。
- **位置**：`src/lib/run-eval.ts` `runEval` / `worker` / `runSingleQuery`；`src/lib/run-loop.ts` `improveDescription` 调用；`src/lib/process.ts` `runProcess` 的 abort 处理。

## 7. 调试输出

- **共享状态**：stderr（多 worker 并发写）。
- **保护手段**：每条调试信息一次 `console.error` 整行输出（不把一条清单拆成多次写）；仅 `SKILL_ZH_DEBUG=1` 时启用，默认完全静默。
- **顺序契约**：**行内容完整，但跨 worker 的相对顺序不作保证**——排查时按条目路径过滤，不要依赖先后；默认只由 CLI 输出一行镜像汇总。
- **位置**：`src/lib/debug.ts`；`src/lib/run-eval.ts` `printMirrorReport`。

## 8. 检查方式（门禁）

| 交互点 | 可失败断言（测试） |
|---|---|
| 多 worker 结果收集 | `lib-run-eval-e2e`：重复 query 保持两条独立结果；多跑次触发率按条目聚合 |
| 子进程池 | `lib-run-eval-e2e`：提前命中触发即结束；超时记错误；非 0 退出记错误 |
| evalRoot 生命周期 | `lib-run-eval-e2e`：取消后每个已启动子进程的 cwd 都已删除；预取消不产生启动记录；非 0 退出 / 超时后隔离根不存在；`rmSync` 抛错时原始错误仍可见；入口符号链接不跟随 |
| deny 写入时机 | `lib-run-eval-j`：J6 deny 写入且用户目录哈希不变（jsonc 优先）；J7 写入失败不 spawn、单条 query 写入失败整轮中止；J8 `--no-shadow-guard` 不写 deny |
| 报告落盘 | `cli-eval` / `cli-optimize`：报告路径存在且 JSON 内容完整；`optimize` 每次运行独立子目录（HTML / JSON / `improve_iter_<n>.json` 同目录） |
| 取消传播 | `lib-run-eval-e2e`：运行中取消抛 `AbortError`、排队任务不启动、忽略 SIGTERM 时升级 SIGKILL |
| 调试输出 | `lib-run-eval-j`：J5 调试清单命中超限/白名单外条目；未开调试时无逐条输出 |

> 新增并发交互点时，先在本表补一行、再补一条会失败的断言；只写注释或文档不算落地。
