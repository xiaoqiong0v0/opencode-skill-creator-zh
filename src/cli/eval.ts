/**
 * `skill_zh eval`：跑触发率评测，输出通过率、逐条结果、失败用例与报告路径。
 *
 * 实现分层：参数解析 / 评测集读取在 `eval-common.ts`；评测本体在 `lib/run-eval.ts`
 * （隔离根、镜像、同名技能 deny 都在那里）。本文件只负责把结果整理成可读文本。
 *
 * 两条硬口径：
 * 1. 项目根只来自 `HandlerInput.projectDir`（`ToolContext.directory` → `worktree`），
 *    不读 `process.cwd()`、不向上查找（`docs/SPEC.md` R6.2-J2）。
 * 2. 执行期失败（含同名技能兜底中止）一律三段式，不把堆栈抛给模型（R5）。
 */

import { log } from "../lib/logger.js";
import { runEval } from "../lib/run-eval.js";
import {
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
import type { EvalResultItem } from "../lib/run-eval.js";

/** 结果里每条 query 的中文极性标签。 */
const POLARITY_LABEL = {
  should: "应触发",
  shouldNot: "不应触发",
} as const;

/**
 * 把「命中 x/y」渲染成一行逐条结果。
 *
 * @param result 单条评测结果
 * @returns 形如 `✓ 应触发 0.67（2/3）「query」` 的一行
 */
function renderResultLine(result: EvalResultItem): string {
  const mark = result.pass ? "✓" : "✗";
  const label = result.should_trigger ? POLARITY_LABEL.should : POLARITY_LABEL.shouldNot;
  const rate = result.trigger_rate.toFixed(2);
  return `  ${mark} ${label} ${rate}（${result.triggers}/${result.runs}）「${result.query}」`;
}

/**
 * 渲染失败用例分组。
 *
 * @param failures 失败条目
 * @returns 失败清单行（无失败时为空数组）
 */
function renderFailures(failures: EvalResultItem[]): string[] {
  if (failures.length === 0) return [];

  const missed = failures.filter((item) => item.should_trigger);
  const falsePositive = failures.filter((item) => !item.should_trigger);
  const lines = ["失败用例："];
  if (missed.length > 0) {
    lines.push(`  应触发未触发（${missed.length}）`);
    for (const item of missed) {
      lines.push(`    - 「${item.query}」 命中 ${item.triggers}/${item.runs}`);
    }
  }
  if (falsePositive.length > 0) {
    lines.push(`  不应触发却触发（${falsePositive.length}）`);
    for (const item of falsePositive) {
      lines.push(`    - 「${item.query}」 命中 ${item.triggers}/${item.runs}`);
    }
  }
  return lines;
}

/**
 * `eval` 子命令实现。
 *
 * @param input handler 入参（`positionals[0]` 为技能目录，其余为选项）
 * @returns 评测结论与报告路径；参数/评测集/执行失败时返回三段式
 */
export async function evalHandler(input: HandlerInput): Promise<DispatchResult> {
  const prepared = prepareEvalOptions(input, "eval");
  if (!prepared.ok) return prepared.result;
  const options = prepared.options;

  let output;
  try {
    output = await runEval({
      evalSet: options.evalSet,
      skillName: options.skillName,
      description: options.description,
      numWorkers: options.numWorkers,
      timeout: options.timeoutSeconds,
      // J2：项目根只来自调用方传入的上下文，绝不在这里读 process.cwd()。
      projectRoot: input.projectDir,
      runsPerQuery: options.runsPerQuery,
      triggerThreshold: DEFAULT_TRIGGER_THRESHOLD,
      triggerOnly: true,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      excludedSkillPath: options.skillPath,
      shadowGuard: options.shadowGuard,
    });
  } catch (error) {
    const guard = shadowGuardFailure(error, "eval", options.skillDisplay);
    if (guard !== null) {
      log.info(`eval 因同名技能中止：${error instanceof Error ? error.message : String(error)}`);
      return guard;
    }
    const isolation = isolationFailure(error);
    if (isolation !== null) {
      log.error("eval 隔离根准备失败", error instanceof Error ? error : new Error(String(error)));
      return isolation;
    }
    log.error("eval 执行失败", error instanceof Error ? error : new Error(String(error)));
    return executionFailure(error, "eval", options.skillDisplay);
  }

  const reportPath = writeJsonReport(options.logDir, "eval", {
    generated_at: new Date().toISOString(),
    project_root: input.projectDir,
    skill_path: options.skillPath,
    eval_set: options.evalSetDisplay,
    runs_per_query: options.runsPerQuery,
    num_workers: options.numWorkers,
    timeout_ms: options.timeoutSeconds * 1000,
    trigger_threshold: DEFAULT_TRIGGER_THRESHOLD,
    shadow_guard: options.shadowGuard,
    ...output,
  });

  const { summary } = output;
  const passRate = summary.total > 0 ? summary.passed / summary.total : 0;
  const failures = output.results.filter((item) => !item.pass);

  const lines = [
    `评测 ${options.skillDisplay}：通过率 ${passRate.toFixed(2)}（${summary.passed}/${summary.total}，每条 ${options.runsPerQuery} 次，阈值 ${DEFAULT_TRIGGER_THRESHOLD}）`,
    "逐条结果：",
    ...output.results.map(renderResultLine),
    ...renderFailures(failures),
  ];

  if (output.warnings.length > 0) {
    lines.push("告警：", ...output.warnings.map((warning) => `  - ${warning}`));
  }
  const mirrorLine = formatMirrorSummary(output.mirror);
  if (mirrorLine !== null) lines.push(mirrorLine);
  lines.push(`报告：${toDisplayPath(reportPath)}`);
  lines.push(
    `下一步：skill_zh optimize ${options.skillDisplay} --iterations 3（按失败用例改写 description）`,
  );

  log.info(
    `eval ${options.skillDisplay}：通过 ${summary.passed}/${summary.total}，报告 ${reportPath}`,
  );
  return { ok: true, output: lines.join("\n") };
}
