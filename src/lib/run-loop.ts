/**
 * 「评测 → 改善」循环编排器。
 *
 * 迁自上游 `plugin/lib/run-loop.ts`（基线 `d4383924`），行为保持不变：把评测集切成
 * 训练/测试两部分，反复评测当前描述并让模型依据失败结果改写它，记录历史、写实时
 * HTML 报告，最后返回表现最好的一次描述。
 *
 * 两处被测试钉住、不得回退的契约：
 * 1. 循环必须使用调用方传入的 `projectRoot`，绝不能用 process-cwd 派生值（上游在循环
 *    开头调用 `findProjectRoot()` 就是这条回归本身）；改善子进程也钉到同一个根。
 * 2. 调用方的 `signal` 必须同时传给评测阶段与改善子进程。
 *
 * `verbose` 下的进度日志沿用上游英文原文：它们属于会被外部观察到的输出，行为等价
 * 迁移不在本批中文化。
 */

import { writeFileSync } from "node:fs";

import { improveDescription } from "./improve-description.js";
import { generateHtml } from "./report.js";
import { abortError, buildEvalWarnings, runEval } from "./run-eval.js";
import { parseSkillMd } from "./utils.js";

import type { HistoryEntry } from "./improve-description.js";
import type { EvalItem, EvalOutput, EvalResultItem } from "./run-eval.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 切分评测集时用于打乱顺序的默认种子（固定种子 = 可复现的切分）。 */
const DEFAULT_SPLIT_SEED = 42;
/** xorshift32 输出归一化用的模数。 */
const RANDOM_MODULUS = 10000;
/** verbose 模式下迭代分隔线的宽度。 */
const VERBOSE_RULE = "=".repeat(60);
/** 历史记录里以该前缀开头的字段（holdout 分数）在喂给改善模型前必须剔除。 */
const HOLDOUT_FIELD_PREFIX = "test_";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 按 `should_trigger` 分层把评测集切成训练集与测试集。
 *
 * 用固定种子的 xorshift32 + Fisher-Yates 打乱：同一份评测集每次切分结果一致，避免
 * 训练/测试边界随机漂移。正负两类各自按 `holdout` 比例抽取，且每类至少抽 1 条进测试集。
 *
 * @param evalSet 完整评测集
 * @param holdout 测试集比例（0~1）
 * @param seed 打乱种子
 * @returns `[训练集, 测试集]`
 */
function splitEvalSet(
  evalSet: EvalItem[],
  holdout: number,
  seed: number = DEFAULT_SPLIT_SEED,
): [EvalItem[], EvalItem[]] {
  // 简单的种子化 xorshift32 伪随机数发生器
  let state = seed;
  function rand(): number {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return ((state >>> 0) % RANDOM_MODULUS) / RANDOM_MODULUS;
  }

  const trigger = evalSet.filter((e) => e.should_trigger);
  const noTrigger = evalSet.filter((e) => !e.should_trigger);

  // 用种子化随机数的 Fisher-Yates 洗牌
  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const shuffledTrigger = shuffle(trigger);
  const shuffledNoTrigger = shuffle(noTrigger);

  const nTriggerTest = Math.max(1, Math.floor(shuffledTrigger.length * holdout));
  const nNoTriggerTest = Math.max(
    1,
    Math.floor(shuffledNoTrigger.length * holdout),
  );

  const testSet = [
    ...shuffledTrigger.slice(0, nTriggerTest),
    ...shuffledNoTrigger.slice(0, nNoTriggerTest),
  ];
  const trainSet = [
    ...shuffledTrigger.slice(nTriggerTest),
    ...shuffledNoTrigger.slice(nNoTriggerTest),
  ];

  return [trainSet, testSet];
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** `runLoop` 的入参。 */
export interface RunLoopOptions {
  evalSet: EvalItem[];
  skillPath: string;
  descriptionOverride?: string | null;
  numWorkers: number;
  timeout: number;
  maxIterations: number;
  runsPerQuery: number;
  triggerThreshold: number;
  triggerOnly: boolean;
  holdout: number;
  model: string | undefined;
  agent: string | undefined;
  verbose: boolean;
  liveReportPath?: string | null;
  logDir?: string | null;
  /**
   * 本次循环评测所在的项目根（配置/技能都从这里解析）。必填：V2 实例必须评测自己
   * 所在的位置，而不是进程 cwd。
   */
  projectRoot: string;
  /** 调用方持有的取消信号；同时传给评测阶段与改善子进程。 */
  signal?: AbortSignal;
  /**
   * 被测技能自己的目录（本次循环的候选）。它被排除在隔离评测根之外，原始正文无法
   * 泄漏进去。不传 -> 不做额外排除。
   */
  excludedSkillPath?: string;
}

/** 单次迭代的历史记录：描述 + 训练/测试集分数 + 逐条结果。 */
export interface LoopHistoryEntry extends HistoryEntry {
  iteration: number;
  description: string;
  train_passed: number;
  train_failed: number;
  train_total: number;
  test_passed: number | null;
  test_failed: number | null;
  test_total: number | null;
  passed: number;
  failed: number;
  total: number;
  results: EvalResultItem[];
  train_results?: EvalResultItem[];
  test_results?: EvalResultItem[] | null;
}

/** `runLoop` 的输出（JSON 字段名保持英文，供下游脚本消费）。 */
export interface RunLoopOutput {
  exit_reason: string;
  original_description: string;
  best_description: string;
  best_score: string;
  best_train_score: string;
  best_test_score: string | null;
  final_description: string;
  iterations_run: number;
  holdout: number;
  train_size: number;
  test_size: number;
  history: LoopHistoryEntry[];
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 跑「评测 → 改善」循环，返回最好的一轮描述。
 *
 * 每轮把训练集与测试集合成一批一起评测（并行度更高），再按位置切回两侧；训练集全部
 * 通过即提前结束，否则让模型依据训练集失败结果改写描述进入下一轮。中途给了
 * `liveReportPath` 就写一份自动刷新的实时报告。喂给改善模型的历史会剔除所有
 * `test_*` 字段（holdout 分数不能泄漏给优化模型）。
 *
 * @param opts 评测集、技能路径、迭代/并行/阈值等循环参数、项目根与取消信号
 * @returns 结束原因、原始/最佳/最终描述、各维度分数与完整历史
 * @throws 调用方取消时抛 `AbortError`
 */
export async function runLoop(opts: RunLoopOptions): Promise<RunLoopOutput> {
  const {
    evalSet,
    skillPath,
    descriptionOverride,
    numWorkers,
    timeout,
    maxIterations,
    runsPerQuery,
    triggerThreshold,
    triggerOnly,
    holdout,
    model,
    agent,
    verbose,
    liveReportPath,
    logDir,
    projectRoot,
    signal,
    excludedSkillPath,
  } = opts;

  if (signal?.aborted) throw abortError();
  const {
    name,
    description: originalDescription,
    fullContent: content,
  } = parseSkillMd(skillPath);
  // 本次循环的候选永远是被测技能本身：把它（以及任何会连带拷它的祖先引用）排除在
  // 隔离评测根之外。
  const excludePath = excludedSkillPath ?? skillPath;
  let currentDescription = descriptionOverride ?? originalDescription;

  // holdout > 0 时切成训练/测试两份
  let trainSet: EvalItem[];
  let testSet: EvalItem[];
  if (holdout > 0) {
    [trainSet, testSet] = splitEvalSet(evalSet, holdout);
    if (verbose) {
      console.error(
        `Split: ${trainSet.length} train, ${testSet.length} test (holdout=${holdout})`,
      );
    }
  } else {
    trainSet = evalSet;
    testSet = [];
  }

  const history: LoopHistoryEntry[] = [];
  let exitReason = "unknown";

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (signal?.aborted) throw abortError();
    if (verbose) {
      console.error(`\n${VERBOSE_RULE}`);
      console.error(`Iteration ${iteration}/${maxIterations}`);
      console.error(`Description: ${currentDescription}`);
      console.error(VERBOSE_RULE);
    }

    // 训练集与测试集合成一批一起评测，换取更高并行度
    const allQueries = [...trainSet, ...testSet];
    const t0 = Date.now();
    const allResults = await runEval({
      evalSet: allQueries,
      skillName: name,
      description: currentDescription,
      numWorkers,
      timeout,
      // 必须是调用方传入的项目根（见文件头契约 1）
      projectRoot,
      runsPerQuery,
      triggerThreshold,
      triggerOnly,
      model,
      agent,
      signal,
      excludedSkillPath: excludePath,
    });
    const evalElapsed = (Date.now() - t0) / 1000;

    // 按位置把结果切回训练/测试。runEval 的契约是「每条评测集条目一条结果、按评测集
    // 顺序返回」（按下标聚合），而 allQueries 就是 [...trainSet, ...testSet]，所以这个
    // 切片是精确的。改成按 query 文本匹配会把跨 holdout 边界重复的 query 都算到一侧，
    // 污染 holdout 分数。
    const trainResultList = allResults.results.slice(0, trainSet.length);
    const testResultList = allResults.results.slice(trainSet.length);
    const trainWarnings = buildEvalWarnings(trainResultList);
    const testWarnings = buildEvalWarnings(testResultList);

    const trainPassed = trainResultList.filter((r) => r.pass).length;
    const trainTotal = trainResultList.length;
    const trainRunErrors = trainResultList.reduce((acc, r) => acc + r.errors, 0);
    const trainSummary = {
      passed: trainPassed,
      failed: trainTotal - trainPassed,
      total: trainTotal,
      run_errors: trainRunErrors,
      queries_with_errors: trainResultList.filter((r) => r.errors > 0).length,
    };
    const trainResults: EvalOutput = {
      skill_name: name,
      description: currentDescription,
      results: trainResultList,
      warnings: trainWarnings,
      summary: trainSummary,
    };

    let testResults: EvalOutput | null = null;
    let testSummary: EvalOutput["summary"] | null = null;
    if (testSet.length > 0) {
      const testPassed = testResultList.filter((r) => r.pass).length;
      const testTotal = testResultList.length;
      const testRunErrors = testResultList.reduce((acc, r) => acc + r.errors, 0);
      testSummary = {
        passed: testPassed,
        failed: testTotal - testPassed,
        total: testTotal,
        run_errors: testRunErrors,
        queries_with_errors: testResultList.filter((r) => r.errors > 0).length,
      };
      testResults = {
        skill_name: name,
        description: currentDescription,
        results: testResultList,
        warnings: testWarnings,
        summary: testSummary,
      };
    }

    history.push({
      iteration,
      description: currentDescription,
      train_passed: trainSummary.passed,
      train_failed: trainSummary.failed,
      train_total: trainSummary.total,
      train_results: trainResultList,
      test_passed: testSummary?.passed ?? null,
      test_failed: testSummary?.failed ?? null,
      test_total: testSummary?.total ?? null,
      test_results: testResultList.length > 0 ? testResultList : null,
      // 与报告生成器保持兼容
      passed: trainSummary.passed,
      failed: trainSummary.failed,
      total: trainSummary.total,
      results: trainResultList,
    });

    // 给了路径就写实时报告
    if (liveReportPath) {
      const partialOutput: Record<string, unknown> = {
        original_description: originalDescription,
        best_description: currentDescription,
        best_score: "in progress",
        iterations_run: history.length,
        holdout,
        train_size: trainSet.length,
        test_size: testSet.length,
        history,
      };
      writeFileSync(
        liveReportPath,
        generateHtml(partialOutput, { autoRefresh: true, skillName: name }),
      );
    }

    if (verbose) {
      console.error(
        `Train: ${trainSummary.passed}/${trainSummary.total} passed (${evalElapsed.toFixed(1)}s)`,
      );
      if (testSummary) {
        console.error(
          `Test:  ${testSummary.passed}/${testSummary.total} passed`,
        );
      }
      for (const warning of new Set([...trainWarnings, ...testWarnings])) {
        console.error(`Warning: ${warning}`);
      }
    }

    if (trainSummary.failed === 0) {
      exitReason = `all_passed (iteration ${iteration})`;
      if (verbose) {
        console.error(`\nAll train queries passed on iteration ${iteration}!`);
      }
      break;
    }

    if (iteration === maxIterations) {
      exitReason = `max_iterations (${maxIterations})`;
      if (verbose) {
        console.error(`\nMax iterations reached (${maxIterations}).`);
      }
      break;
    }

    // 依据训练集结果改写描述
    if (signal?.aborted) throw abortError();
    if (verbose) {
      console.error("\nImproving description...");
    }

    const t1 = Date.now();
    // 从历史里剔除测试集分数，避免改善模型看到 holdout 结果
    const blindedHistory: HistoryEntry[] = history.map((h) => {
      const stripped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith(HOLDOUT_FIELD_PREFIX)) stripped[k] = v;
      }
      // 边界处集中断言：剥掉 `test_*` 后剩下的键仍是合法 HistoryEntry，但静态类型
      // 无法从不含必填键的 Record 推出，故经 `unknown` 过渡。
      return stripped as unknown as HistoryEntry;
    });

    const newDescription = await improveDescription({
      skillName: name,
      skillContent: content,
      currentDescription,
      evalResults: trainResults,
      history: blindedHistory,
      model,
      logDir,
      iteration,
      // 改善子进程钉到同一个项目根，并继承调用方的取消信号（见文件头契约 1、2）
      projectRoot,
      signal,
    });
    const improveElapsed = (Date.now() - t1) / 1000;

    if (verbose) {
      console.error(
        `Proposed (${improveElapsed.toFixed(1)}s): ${newDescription}`,
      );
    }

    currentDescription = newDescription;
  }

  // 按测试集分数挑最好的一轮；没有测试集就看训练集。
  // 注意：`history` 为空（`maxIterations <= 0`）时会抛 TypeError —— 上游行为，未修，
  // 登记在 `docs/design/上游携带缺陷台账.md`。
  let best: LoopHistoryEntry;
  if (testSet.length > 0) {
    best = history.reduce((a, b) =>
      (a.test_passed ?? 0) >= (b.test_passed ?? 0) ? a : b,
    );
  } else {
    best = history.reduce((a, b) =>
      (a.train_passed ?? 0) >= (b.train_passed ?? 0) ? a : b,
    );
  }

  const bestScore =
    testSet.length > 0
      ? `${best.test_passed}/${best.test_total}`
      : `${best.train_passed}/${best.train_total}`;

  if (verbose) {
    console.error(`\nExit reason: ${exitReason}`);
    console.error(`Best score: ${bestScore} (iteration ${best.iteration})`);
  }

  return {
    exit_reason: exitReason,
    original_description: originalDescription,
    best_description: best.description,
    best_score: bestScore,
    best_train_score: `${best.train_passed}/${best.train_total}`,
    best_test_score:
      testSet.length > 0 ? `${best.test_passed}/${best.test_total}` : null,
    final_description: currentDescription,
    iterations_run: history.length,
    holdout,
    train_size: trainSet.length,
    test_size: testSet.length,
    history,
  };
}
