/**
 * 汇总：benchmark 目录的统计与差异，以及触发率评测（`eval`）的文本汇总。
 *
 * benchmark 部分迁自上游 `plugin/lib/aggregate.ts`（基线 `d4383924`），移植自上游 Python
 * 脚本 `scripts/aggregate_benchmark.py`；行为保持不变。`eval` 汇总（`summarizeEvalResults`
 * / `formatEvalSummary`）复用同一套统计口径（`calculateStats`），避免两处各算一套。
 *
 * 支持两种目录布局：
 *   - 工作区布局：<dir>/eval-N/{with_skill,without_skill}/run-N/grading.json
 *   - 旧布局：<dir>/runs/eval-N/{config}/run-N/grading.json
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { logErrorSummary } from "./debug.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 读取 `grading.json` 得到的一次运行结果。 */
interface RunResult {
  eval_id: number | string;
  run_number: number;
  pass_rate: number;
  passed: number;
  failed: number;
  total: number;
  time_seconds: number;
  tokens: number;
  tool_calls: number;
  errors: number;
  expectations: Record<string, unknown>[];
  notes: string[];
}

/** 一组数值的四项统计，数值均四舍五入到 4 位小数。 */
export interface Stats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

/** 单个配置（`with_skill` / `without_skill` 等）的统计块。 */
interface ConfigStats {
  pass_rate: Stats;
  time_seconds: Stats;
  tokens: Stats;
}

/** 与基线的差异行，数值已格式化成带符号字符串。 */
interface DeltaStats {
  pass_rate: string;
  time_seconds: string;
  tokens: string;
}

/** `run_summary` 里的一项：配置统计块或差异行。 */
type RunSummaryValue = ConfigStats | DeltaStats;

/** `grading.json` 中本模块读取的字段（缺字段按 0 / 空处理，与上游一致）。 */
interface GradingFile {
  summary?: {
    pass_rate?: number;
    passed?: number;
    failed?: number;
    total?: number;
  };
  timing?: { total_duration_seconds?: number };
  execution_metrics?: {
    total_tool_calls?: number;
    output_chars?: number;
    errors_encountered?: number;
  };
  expectations?: Record<string, unknown>[];
  user_notes_summary?: {
    uncertainties?: string[];
    needs_review?: string[];
    workarounds?: string[];
  };
}

/** 旧布局里独立的 `timing.json`。 */
interface TimingFile {
  total_duration_seconds?: number;
  total_tokens?: number;
}

/** `eval_metadata.json` 中本模块关心的字段。 */
interface EvalMetadata {
  eval_id?: number | string;
}

/** 生成 Markdown 时读取的 `metadata` 字段。 */
interface BenchmarkMetadata {
  skill_name?: string;
  executor_model?: string;
  timestamp?: string;
  evals_run?: Array<number | string>;
  runs_per_configuration?: number;
}

/** 汇总产物：`metadata` / `runs` / `run_summary` / `notes` 四段，字段名保持英文供下游消费。 */
export interface BenchmarkOutput {
  metadata: Record<string, unknown>;
  runs: Record<string, unknown>[];
  run_summary: Record<string, unknown>;
  notes: string[];
}

/** `loadRunResults` 的返回：按配置名分组的结果，以及出现过的 eval_id（已排序）。 */
interface LoadResultsOutput {
  results: Record<string, RunResult[]>;
  evalIds: Array<number | string>;
}

/**
 * 比较两个 eval_id，数字优先按数值、其余按带数字感知的本地化字符串顺序。
 *
 * @param a 左侧 eval_id
 * @param b 右侧 eval_id
 * @returns 负数表示 `a` 在前，正数表示 `b` 在前
 */
function compareEvalIds(a: number | string, b: number | string): number {
  const parseNumeric = (value: number | string): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  };

  const aNum = parseNumeric(a);
  const bNum = parseNumeric(b);
  if (aNum !== null && bNum !== null) return aNum - bNum;

  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/**
 * 推算「每个配置每个 eval 跑了几次」。
 *
 * 取所有配置、所有 eval 里次数的**最小值**；任一配置缺 eval 或没有运行都会把结果压到
 * 0，以此暴露不完整的基准目录。
 *
 * @param results 按配置名分组的运行结果
 * @param evalIds 出现过的 eval_id 列表
 * @returns 每个配置每个 eval 的运行次数；没有任何数据时返回 0
 */
function computeRunsPerConfiguration(
  results: Record<string, RunResult[]>,
  evalIds: Array<number | string>,
): number {
  const counts: number[] = [];

  for (const runs of Object.values(results)) {
    if (runs.length === 0) {
      counts.push(0);
      continue;
    }

    const byEval = new Map<string, Set<number>>();

    for (const run of runs) {
      const evalKey = String(run.eval_id);
      const seenRuns = byEval.get(evalKey);
      if (seenRuns) {
        seenRuns.add(run.run_number);
      } else {
        byEval.set(evalKey, new Set<number>([run.run_number]));
      }
    }

    if (evalIds.length === 0) {
      counts.push(0);
      continue;
    }

    for (const evalId of evalIds) {
      const set = byEval.get(String(evalId));
      counts.push(set ? set.size : 0);
    }
  }

  if (counts.length === 0) return 0;
  return Math.min(...counts);
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 计算一组数值的均值、标准差（样本标准差，n-1）、最小值与最大值。
 *
 * @param values 待统计的数值（空数组表示没有任何运行）
 * @returns 四项统计；空数组时全为 0
 */
function calculateStats(values: number[]): Stats {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }

  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;

  let stddev = 0;
  if (n > 1) {
    const variance = values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1);
    stddev = Math.sqrt(variance);
  }

  return {
    mean: Math.round(mean * 10000) / 10000,
    stddev: Math.round(stddev * 10000) / 10000,
    min: Math.round(Math.min(...values) * 10000) / 10000,
    max: Math.round(Math.max(...values) * 10000) / 10000,
  };
}

/**
 * 把底层错误压成一行原因（优先错误码，便于用户搜索与定位）。
 *
 * @param error 捕获到的异常
 * @returns 错误码（`ENOENT`、`ENOTDIR` 等）；没有错误码时退回 message
 */
function reasonOf(error: unknown): string {
  return error instanceof Error
    ? ((error as NodeJS.ErrnoException).code ?? error.message)
    : String(error);
}

/**
 * 判断某个路径当前是否解析为目录（跟随符号链接）。
 *
 * @param path 待判定的路径
 * @returns 解析成功且是目录时为 `true`；不存在、断链、普通文件、无权限一律 `false`
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 单个目录项的判定结果：无法解析时 `error` 为具体异常，否则只给出是否目录。 */
interface DirEntryProbe {
  isDir: boolean;
  error?: unknown;
}

/**
 * 判定一个目录项是否是（或指向）目录。
 *
 * 先 `lstat` 看条目**本身**：`readdirSync` 会把断链符号链接 / junction 也列出来，
 * 直接 `stat` 会在目标缺失时抛 `ENOENT`。是链接时再 `stat` 探目标——不能只看 `lstat`，
 * 否则「指向目录的合法链接」会被误判成非目录。任一步抛错都归为「不可解析」。
 *
 * @param full 目录项的完整路径
 * @returns 判定结果；`error` 非空表示该项无法解析
 */
function probeDirEntry(full: string): DirEntryProbe {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(full);
  } catch (error) {
    return { isDir: false, error };
  }

  if (stats.isSymbolicLink()) {
    try {
      stats = statSync(full);
    } catch (error) {
      return { isDir: false, error };
    }
  }

  return { isDir: stats.isDirectory() };
}

/**
 * 列出目录下满足命名规则的子目录（绝对路径，按字典序排序）。
 *
 * 目录项逐个 `probeDirEntry` 判定（`lstat` + 链接探目标）：断链链接、不可解析项**跳过**
 * 并打一条中文警告，父目录不存在 / 不是目录 / 列不出来时按「没有子目录」返回。这样一次
 * 坏链接不会让整次汇总中止——与 `loadRunResults` 自己声明的「只警告并跳过，不中断整体
 * 汇总」口径一致。本模块没有 `issues` 通道，跳过原因只能走 `console.error`。
 *
 * @param dir 待扫描的父目录
 * @param pattern 目录名需匹配的正则；省略则不按名字过滤
 * @returns 匹配的子目录路径数组；父目录不存在 / 不可解析 / 不是目录时返回空数组
 */
function sortedDirs(dir: string, pattern?: RegExp): string[] {
  // 父目录可能不存在，也可能是同名普通文件或断链链接：一律按「没有子目录」处理，
  // 交给调用方按业务口径告警（例如「未找到任何 eval 目录」），不在这里抛 ENOTDIR。
  if (!isDirectory(dir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    console.error(`警告：目录不可读取，已跳过：${dir}（${reasonOf(error)}）`);
    return [];
  }

  const matched: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);
    const probe = probeDirEntry(full);
    if (probe.error !== undefined) {
      console.error(`警告：目录项不可解析，已跳过：${full}（${reasonOf(probe.error)}）`);
      continue;
    }
    // 普通文件是正常内容（`eval_metadata.json`、同名的 `runs` 占位文件等），静默忽略。
    if (!probe.isDir) continue;
    if (pattern && !pattern.test(name)) continue;
    matched.push(full);
  }

  return matched.sort();
}

// ---------------------------------------------------------------------------
// 读取运行结果
// ---------------------------------------------------------------------------

/**
 * 扫描基准目录，把每个 `grading.json` 读成一条运行结果。
 *
 * 目录布局先探测 `runs/`（旧布局，**必须是目录**才算），没有再退回基准目录本身（工作区
 * 布局）。单个 `run-*` 目录的问题（名字不合规、缺 `grading.json`、JSON 损坏）只打印警告
 * 并跳过，不中断整体汇总——与上游一致；断链链接 / 同名文件同理，不抛底层错误。
 *
 * @param benchmarkDir 基准目录
 * @returns 按配置名分组的结果与已排序的 eval_id 列表
 */
function loadRunResults(benchmarkDir: string): LoadResultsOutput {
  // 两种目录布局都要支持；`runs` 必须**是目录**才算旧布局——同名普通文件（占位残留、
  // 手工误建）按「不存在」处理，否则随后的 readdirSync 会抛 ENOTDIR 让整次汇总中止。
  const runsDir = join(benchmarkDir, "runs");
  const usesLegacyLayout = isDirectory(runsDir);
  // eval 目录只扫一次：扫两遍会让同一坏链接的告警重复出现。
  const evalDirs = sortedDirs(usesLegacyLayout ? runsDir : benchmarkDir, /^eval-/);

  if (!usesLegacyLayout && evalDirs.length === 0) {
    console.error(`未在 ${benchmarkDir} 或 ${runsDir} 找到任何 eval 目录`);
    return { results: {}, evalIds: [] };
  }

  const results: Record<string, RunResult[]> = {};
  const evalIds = new Set<number | string>();

  for (const [evalIdx, evalDir] of evalDirs.entries()) {
    const metadataPath = join(evalDir, "eval_metadata.json");
    let evalId: number | string = evalIdx;
    if (existsSync(metadataPath)) {
      try {
        const meta = JSON.parse(readFileSync(metadataPath, "utf-8")) as EvalMetadata;
        evalId = meta.eval_id ?? evalIdx;
      } catch {
        /* 元数据损坏时退回目录序号，与上游一致：静默忽略 */
      }
    } else {
      const parsedEvalId = Number.parseInt(
        basename(evalDir).split("-")[1] ?? "",
        10,
      );
      if (Number.isFinite(parsedEvalId)) {
        evalId = parsedEvalId;
      }
    }
    let hasLoadedRuns = false;

    // 配置目录按实际存在的名字动态发现，不写死 with_skill / without_skill
    for (const configDir of sortedDirs(evalDir)) {
      // 没有 run-* 子目录的目录不算配置目录
      if (sortedDirs(configDir, /^run-/).length === 0) continue;

      const config = basename(configDir);
      if (!results[config]) results[config] = [];

      for (const runDir of sortedDirs(configDir, /^run-/)) {
        const parsedRunNumber = Number.parseInt(
          basename(runDir).split("-")[1] ?? "",
          10,
        );
        if (!Number.isFinite(parsedRunNumber)) {
          console.error(`警告：run 目录名不合规，已跳过：${runDir}`);
          continue;
        }

        const runNumber = parsedRunNumber;
        const gradingFile = join(runDir, "grading.json");

        if (!existsSync(gradingFile)) {
          console.error(`警告：缺少 grading.json，已跳过：${runDir}`);
          continue;
        }

        let grading: GradingFile;
        try {
          grading = JSON.parse(readFileSync(gradingFile, "utf-8")) as GradingFile;
        } catch (error) {
          logErrorSummary(`警告：grading.json 不是合法 JSON，已跳过：${gradingFile}`, error);
          continue;
        }

        const summary = grading.summary ?? {};
        const result: RunResult = {
          eval_id: evalId,
          run_number: runNumber,
          pass_rate: summary.pass_rate ?? 0,
          passed: summary.passed ?? 0,
          failed: summary.failed ?? 0,
          total: summary.total ?? 0,
          time_seconds: 0,
          tokens: 0,
          tool_calls: 0,
          errors: 0,
          expectations: grading.expectations ?? [],
          notes: [],
        };

        // 耗时优先取 grading.json 内嵌的 timing
        const timing = grading.timing ?? {};
        result.time_seconds = timing.total_duration_seconds ?? 0;
        const timingFile = join(runDir, "timing.json");
        if (result.time_seconds === 0 && existsSync(timingFile)) {
          try {
            const timingData = JSON.parse(
              readFileSync(timingFile, "utf-8"),
            ) as TimingFile;
            result.time_seconds = timingData.total_duration_seconds ?? 0;
            result.tokens = timingData.total_tokens ?? 0;
          } catch {
            /* 单独的 timing.json 损坏时静默忽略，与上游一致 */
          }
        }

        // 执行指标
        const metrics = grading.execution_metrics ?? {};
        result.tool_calls = metrics.total_tool_calls ?? 0;
        if (!result.tokens) result.tokens = metrics.output_chars ?? 0;
        result.errors = metrics.errors_encountered ?? 0;

        // 期望项缺字段只告警，不影响汇总
        for (const exp of result.expectations) {
          if (!("text" in exp) || !("passed" in exp)) {
            console.error(
              `警告：${gradingFile} 里的 expectation 缺必填字段（text、passed、evidence）`,
            );
          }
        }

        // 人工备注
        const notesSummary = grading.user_notes_summary ?? {};
        const notes: string[] = [];
        if (notesSummary.uncertainties) notes.push(...notesSummary.uncertainties);
        if (notesSummary.needs_review) notes.push(...notesSummary.needs_review);
        if (notesSummary.workarounds) notes.push(...notesSummary.workarounds);
        result.notes = notes;

        results[config].push(result);
        hasLoadedRuns = true;
      }
    }

    if (hasLoadedRuns) {
      evalIds.add(evalId);
    }
  }

  return {
    results,
    evalIds: [...evalIds].sort(compareEvalIds),
  };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

/**
 * 汇总各配置的统计，并算出「第一个配置减第二个配置」的差异。
 *
 * 差异行固定放在最后：`generateMarkdown` 依赖 `Object.keys` 的顺序把前两项当两个
 * 配置，差异行单独取 `delta` 键。
 *
 * @param results 按配置名分组的运行结果
 * @returns 每个配置的统计块，外加 `delta` 差异行；没有任何配置时只返回零值 `delta`
 */
function aggregateResults(
  results: Record<string, RunResult[]>,
): Record<string, RunSummaryValue> {
  const configs = Object.keys(results);
  const table: Record<string, ConfigStats> = {};

  if (configs.length === 0) {
    return {
      delta: {
        pass_rate: "+0.00",
        time_seconds: "+0.0",
        tokens: "+0",
      },
    };
  }

  for (const config of configs) {
    const runs = results[config] ?? [];
    if (runs.length === 0) {
      table[config] = {
        pass_rate: { mean: 0, stddev: 0, min: 0, max: 0 },
        time_seconds: { mean: 0, stddev: 0, min: 0, max: 0 },
        tokens: { mean: 0, stddev: 0, min: 0, max: 0 },
      };
      continue;
    }

    table[config] = {
      pass_rate: calculateStats(runs.map((r) => r.pass_rate)),
      time_seconds: calculateStats(runs.map((r) => r.time_seconds)),
      tokens: calculateStats(runs.map((r) => r.tokens)),
    };
  }

  // 只有两个及以上配置时才有基线可比
  const primary = table[configs[0]];
  const baseline = configs.length >= 2 ? table[configs[1]] : undefined;

  const deltaPR = (primary?.pass_rate.mean ?? 0) - (baseline?.pass_rate.mean ?? 0);
  const deltaTime =
    (primary?.time_seconds.mean ?? 0) - (baseline?.time_seconds.mean ?? 0);
  const deltaTokens = (primary?.tokens.mean ?? 0) - (baseline?.tokens.mean ?? 0);

  return {
    ...table,
    delta: {
      pass_rate: `${deltaPR >= 0 ? "+" : ""}${deltaPR.toFixed(2)}`,
      time_seconds: `${deltaTime >= 0 ? "+" : ""}${deltaTime.toFixed(1)}`,
      tokens: `${deltaTokens >= 0 ? "+" : ""}${Math.round(deltaTokens)}`,
    },
  };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 从运行结果生成完整的 benchmark 对象。
 *
 * @param benchmarkDir 基准目录（支持工作区布局与旧 `runs/` 布局）
 * @param skillName 技能名；省略时写占位符 `<skill-name>`
 * @param skillPath 技能路径；省略时写占位符 `<path/to/skill>`
 * @returns 含 `metadata` / `runs` / `run_summary` / `notes` 的汇总产物
 */
export function generateBenchmark(
  benchmarkDir: string,
  skillName = "",
  skillPath = "",
): BenchmarkOutput {
  const loaded = loadRunResults(benchmarkDir);
  const results = loaded.results;
  const runSummary = aggregateResults(results);

  // 逐条摊平 runs 数组，保持「按配置、再按配置内读取顺序」
  const runs: Record<string, unknown>[] = [];
  for (const config of Object.keys(results)) {
    for (const result of results[config]) {
      runs.push({
        eval_id: result.eval_id,
        configuration: config,
        run_number: result.run_number,
        result: {
          pass_rate: result.pass_rate,
          passed: result.passed,
          failed: result.failed,
          total: result.total,
          time_seconds: result.time_seconds,
          tokens: result.tokens,
          tool_calls: result.tool_calls,
          errors: result.errors,
        },
        expectations: result.expectations,
        notes: result.notes,
      });
    }
  }

  const runsPerConfiguration = computeRunsPerConfiguration(results, loaded.evalIds);

  return {
    metadata: {
      skill_name: skillName || "<skill-name>",
      skill_path: skillPath || "<path/to/skill>",
      executor_model: "<model-name>",
      analyzer_model: "<model-name>",
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      evals_run: loaded.evalIds,
      runs_per_configuration: runsPerConfiguration,
    },
    runs,
    run_summary: runSummary,
    notes: [],
  };
}

/**
 * 触发率评测的一行结果（`EvalResultItem` 的最小子集，直接传入即可）。
 */
export interface EvalSummaryRow {
  query: string;
  should_trigger: boolean;
  trigger_rate: number;
  pass: boolean;
}

/** 按 `should_trigger` 分组的汇总块。 */
export interface EvalSummaryGroup {
  /** 该组期望是否触发。 */
  should_trigger: boolean;
  /** 中文组名。 */
  label: string;
  total: number;
  passed: number;
  failed: number;
  /** 该组通过率（0–1）。 */
  pass_rate: number;
  /** 该组逐条触发率的统计（复用 benchmark 的均值/标准差口径）。 */
  trigger_rate: Stats;
}

/** 重复 query 分组。 */
export interface EvalDuplicateGroup {
  query: string;
  total: number;
  passed: number;
}

/** 触发率评测的文本汇总数据。 */
export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  /** 总通过率（0–1）。 */
  pass_rate: number;
  /** 全部条目触发率的统计。 */
  trigger_rate: Stats;
  groups: EvalSummaryGroup[];
  duplicates: EvalDuplicateGroup[];
}

/** 两个极性分组的固定顺序与中文名。 */
const EVAL_GROUP_LABELS: ReadonlyArray<readonly [boolean, string]> = [
  [true, "应触发"],
  [false, "不应触发"],
];

/**
 * 汇总一轮触发率评测的结果。
 *
 * 统计口径与 benchmark 汇总共用 `calculateStats`（均值 / 标准差 / 最值），不在这里另算。
 *
 * @param rows 逐条评测结果（按评测集顺序；重复 query 各自独立）
 * @returns 总通过率、按极性分组、重复 query 分组
 */
export function summarizeEvalResults(rows: readonly EvalSummaryRow[]): EvalSummary {
  const total = rows.length;
  const passed = rows.filter((row) => row.pass).length;

  const groups: EvalSummaryGroup[] = EVAL_GROUP_LABELS.map(([shouldTrigger, label]) => {
    const subset = rows.filter((row) => row.should_trigger === shouldTrigger);
    const groupPassed = subset.filter((row) => row.pass).length;
    return {
      should_trigger: shouldTrigger,
      label,
      total: subset.length,
      passed: groupPassed,
      failed: subset.length - groupPassed,
      pass_rate: subset.length > 0 ? groupPassed / subset.length : 0,
      trigger_rate: calculateStats(subset.map((row) => row.trigger_rate)),
    };
  });

  // 重复 query 按「首次出现顺序」分组，便于用户定位评测集里写重的条目。
  const byQuery = new Map<string, { total: number; passed: number }>();
  for (const row of rows) {
    const entry = byQuery.get(row.query) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (row.pass) entry.passed += 1;
    byQuery.set(row.query, entry);
  }
  const duplicates: EvalDuplicateGroup[] = [...byQuery.entries()]
    .filter(([, entry]) => entry.total > 1)
    .map(([query, entry]) => ({ query, total: entry.total, passed: entry.passed }));

  return {
    total,
    passed,
    failed: total - passed,
    pass_rate: total > 0 ? passed / total : 0,
    trigger_rate: calculateStats(rows.map((row) => row.trigger_rate)),
    groups,
    duplicates,
  };
}

/**
 * 把评测汇总渲染成中文文本行（`eval` 输出用）。
 *
 * @param summary `summarizeEvalResults` 的产物
 * @returns 以「汇总：」开头的文本行
 */
export function formatEvalSummary(summary: EvalSummary): string[] {
  const rate = (value: number): string => value.toFixed(2);
  const stats = (value: Stats): string => `${rate(value.mean)} ± ${rate(value.stddev)}`;
  const lines = [
    "汇总：",
    `  总通过率 ${rate(summary.pass_rate)}（${summary.passed}/${summary.total}），失败 ${summary.failed} 条；触发率均值 ${stats(summary.trigger_rate)}`,
  ];
  for (const group of summary.groups) {
    lines.push(
      `  ${group.label}：${group.total} 条，通过 ${group.passed}（${rate(group.pass_rate)}），失败 ${group.failed}；触发率均值 ${stats(group.trigger_rate)}`,
    );
  }
  if (summary.duplicates.length > 0) {
    const detail = summary.duplicates
      .map((group) => `「${group.query}」×${group.total}（通过 ${group.passed}/${group.total}）`)
      .join("；");
    lines.push(`  重复 query：${summary.duplicates.length} 组，${detail}`);
  } else {
    lines.push("  重复 query：无");
  }
  return lines;
}

/**
 * 把 benchmark 数据渲染成人类可读的 Markdown。
 *
 * @param benchmark `generateBenchmark` 的产物
 * @returns 含标题、明细表与可选备注段的 Markdown 文本
 */
export function generateMarkdown(benchmark: BenchmarkOutput): string {
  const metadata = benchmark.metadata as BenchmarkMetadata;
  const runSummary = benchmark.run_summary as Record<string, RunSummaryValue>;

  // 前两个非 delta 键就是「实验组 / 基线」，缺省时用占位名
  const configs = Object.keys(runSummary).filter((k) => k !== "delta");
  const configA = configs[0] ?? "config_a";
  const configB = configs[1] ?? "config_b";
  const labelA = configA.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
  const labelB = configB.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());

  const a = (runSummary[configA] ?? {}) as Partial<ConfigStats>;
  const b = (runSummary[configB] ?? {}) as Partial<ConfigStats>;
  const delta = (runSummary.delta ?? {}) as Partial<DeltaStats>;

  const lines = [
    `# Skill Benchmark: ${metadata.skill_name}`,
    "",
    `**Model**: ${metadata.executor_model}`,
    `**Date**: ${metadata.timestamp}`,
    `**Evals**: ${(metadata.evals_run ?? []).join(", ")} (${metadata.runs_per_configuration} runs each per configuration)`,
    "",
    "## Summary",
    "",
    `| Metric | ${labelA} | ${labelB} | Delta |`,
    "|--------|------------|---------------|-------|",
  ];

  const fmtPR = (s: Stats | undefined): string =>
    s && typeof s.mean === "number" && typeof s.stddev === "number"
      ? `${(s.mean * 100).toFixed(0)}% ± ${(s.stddev * 100).toFixed(0)}%`
      : "—";
  const fmtTime = (s: Stats | undefined): string =>
    s && typeof s.mean === "number" && typeof s.stddev === "number"
      ? `${s.mean.toFixed(1)}s ± ${s.stddev.toFixed(1)}s`
      : "—";
  const fmtTokens = (s: Stats | undefined): string =>
    s && typeof s.mean === "number" && typeof s.stddev === "number"
      ? `${s.mean.toFixed(0)} ± ${s.stddev.toFixed(0)}`
      : "—";

  lines.push(
    `| Pass Rate | ${fmtPR(a.pass_rate)} | ${fmtPR(b.pass_rate)} | ${delta.pass_rate ?? "—"} |`,
  );
  lines.push(
    `| Time | ${fmtTime(a.time_seconds)} | ${fmtTime(b.time_seconds)} | ${delta.time_seconds ?? "—"}s |`,
  );
  lines.push(
    `| Tokens | ${fmtTokens(a.tokens)} | ${fmtTokens(b.tokens)} | ${delta.tokens ?? "—"} |`,
  );

  if (benchmark.notes?.length) {
    lines.push("", "## Notes", "");
    for (const note of benchmark.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}
