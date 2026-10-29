/**
 * `skill_zh optimize`：按评测失败迭代改写 description，输出每轮通过率与最终 description。
 *
 * 实现分层：参数解析 / 评测集读取在 `eval-common.ts`；训练/测试集切分、评测、改写与
 * 选优在 `lib/run-loop.ts`。本文件只负责参数默认值、报告落盘与可读输出。
 *
 * 项目根只用 `HandlerInput.projectDir`（`ToolContext.directory` → `worktree`），
 * 不读 `process.cwd()`、不向上查找（`docs/SPEC.md` R6.2-J2）。
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { log } from "../lib/logger.js";
import { runLoop } from "../lib/run-loop.js";
import { formatError } from "./errors.js";
import {
  DEFAULT_HOLDOUT,
  DEFAULT_ITERATIONS,
  DEFAULT_TRIGGER_THRESHOLD,
  executionFailure,
  formatMirrorSummary,
  isolationFailure,
  prepareEvalOptions,
  shadowGuardFailure,
  toDisplayPath,
  writeJsonReport,
} from "./eval-common.js";
import type { DispatchResult, HandlerInput } from "./types.js";
import type { LoopHistoryEntry } from "../lib/run-loop.js";

/** 每次 optimize 的独立产物子目录前缀（避免多次运行互相覆盖）。 */
const RUN_DIR_PREFIX = "optimize";
/** 实时报告文件名（HTML 由 `runLoop` 在每轮刷新）。 */
const LIVE_REPORT_FILE = "optimize-report.html";

/**
 * 渲染一轮的通过率。
 *
 * @param entry 该轮历史记录
 * @returns 形如 `第 1 轮  训练 3/5  测试 1/3` 的一行
 */
function renderRound(entry: LoopHistoryEntry): string {
  const train = `训练 ${entry.train_passed}/${entry.train_total}`;
  const test =
    entry.test_total === null ? "测试 —" : `测试 ${entry.test_passed}/${entry.test_total}`;
  return `  第 ${entry.iteration} 轮  ${train}  ${test}`;
}

/**
 * `optimize` 子命令实现。
 *
 * @param input handler 入参（`positionals[0]` 为技能目录，`--iterations` 等为选项）
 * @returns 每轮分数与最终 description；参数/评测集/执行失败时返回三段式
 */
export async function optimizeHandler(input: HandlerInput): Promise<DispatchResult> {
  const prepared = prepareEvalOptions(input, "optimize");
  if (!prepared.ok) return prepared.result;
  const options = prepared.options;

  const iterationsFlag = input.flags.iterations;
  const iterations = (() => {
    if (iterationsFlag === undefined) return DEFAULT_ITERATIONS;
    if (typeof iterationsFlag !== "string") return null;
    if (!/^\d+$/.test(iterationsFlag) || Number(iterationsFlag) <= 0) return null;
    return Number(iterationsFlag);
  })();
  if (iterations === null) {
    const raw = typeof iterationsFlag === "string" ? iterationsFlag : "（缺值）";
    return {
      ok: false,
      output: formatError(
        `参数 --iterations 非法：${raw}（只接受正整数）`,
        `改用正整数，例如 skill_zh optimize ${options.skillDisplay} --iterations ${DEFAULT_ITERATIONS}`,
      ),
    };
  }

  // 每次运行落独立子目录：实时 HTML 与改善对话记录都按
  // `<logDir>/optimize-<时间戳>-<随机>/` 隔离，避免两次 optimize 的
  // `optimize-report.html` / `improve_iter_<n>.json` 互相覆盖。
  const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(
    options.logDir,
    `${RUN_DIR_PREFIX}-${runStamp}-${randomBytes(2).toString("hex")}`,
  );
  mkdirSync(runDir, { recursive: true });
  const liveReportPath = join(runDir, LIVE_REPORT_FILE);

  let output;
  try {
    output = await runLoop({
      evalSet: options.evalSet,
      skillPath: options.skillPath,
      numWorkers: options.numWorkers,
      timeout: options.timeoutSeconds,
      maxIterations: iterations,
      runsPerQuery: options.runsPerQuery,
      triggerThreshold: DEFAULT_TRIGGER_THRESHOLD,
      triggerOnly: true,
      holdout: DEFAULT_HOLDOUT,
      model: options.model,
      agent: options.agent,
      verbose: false,
      liveReportPath,
      logDir: runDir,
      // J2：项目根只来自调用方传入的上下文。
      projectRoot: input.projectDir,
      excludedSkillPath: options.skillPath,
      shadowGuard: options.shadowGuard,
    });
  } catch (error) {
    const guard = shadowGuardFailure(error, "optimize", options.skillDisplay);
    if (guard !== null) {
      log.info(
        `optimize 因同名技能中止：${error instanceof Error ? error.message : String(error)}`,
      );
      return guard;
    }
    const isolation = isolationFailure(error);
    if (isolation !== null) {
      log.error(
        "optimize 隔离根准备失败",
        error instanceof Error ? error : new Error(String(error)),
      );
      return isolation;
    }
    log.error("optimize 执行失败", error instanceof Error ? error : new Error(String(error)));
    return executionFailure(error, "optimize", options.skillDisplay);
  }

  const reportPath = writeJsonReport(runDir, "optimize", {
    generated_at: new Date().toISOString(),
    project_root: input.projectDir,
    skill_path: options.skillPath,
    eval_set: options.evalSetDisplay,
    runs_per_query: options.runsPerQuery,
    num_workers: options.numWorkers,
    iterations,
    shadow_guard: options.shadowGuard,
    ...output,
  });

  const lines = [
    `优化 ${options.skillDisplay}：${output.iterations_run} 轮（训练 ${output.train_size} / 测试 ${output.test_size}，holdout ${DEFAULT_HOLDOUT}）`,
    ...output.history.map(renderRound),
  ];

  const finalLabel =
    output.best_test_score !== null
      ? `测试集 ${output.best_test_score}`
      : `训练集 ${output.best_train_score}`;
  lines.push(`最终 description（${finalLabel}）：`, `  ${output.best_description}`);
  const mirrorLine = formatMirrorSummary(output.mirror);
  if (mirrorLine !== null) lines.push(mirrorLine);
  lines.push(`报告：${toDisplayPath(reportPath)}`);
  if (output.history.length > 0) lines.push(`实时报告：${toDisplayPath(liveReportPath)}`);
  lines.push(
    `下一步：把上面的 description 写回 ${options.skillDisplay}/SKILL.md 的 frontmatter，再跑一次 skill_zh eval ${options.skillDisplay} 复核`,
  );

  log.info(
    `optimize ${options.skillDisplay}：${output.iterations_run} 轮，最佳 ${output.best_score}，报告 ${reportPath}`,
  );
  return { ok: true, output: lines.join("\n") };
}
