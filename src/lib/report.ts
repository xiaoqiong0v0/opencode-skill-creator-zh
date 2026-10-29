/**
 * 生成描述优化过程的 HTML 报告。
 *
 * 迁自上游 `plugin/lib/report.ts`（基线 `d4383924`），移植自上游 Python 脚本
 * `scripts/generate_report.py`；行为保持不变，页面文案与样式也沿用上游原文。
 *
 * 产出单文件自包含 HTML：注释里的页面文案、内联样式与字体外链由用户浏览器直接加载，
 * 不在本地起服务。
 */

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 转义 HTML 文本中的四个特殊字符。
 *
 * 只处理 `&`、`<`、`>`、`"`（与上游一致，不处理单引号），顺序上先替换 `&` 以免二次转义。
 *
 * @param text 原始文本
 * @returns 可安全插入 HTML 文本节点或双引号属性的文本
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// 类型（按宽松处理：接受 run_loop 输出里可能出现的数据形状）
// ---------------------------------------------------------------------------

/** 表头用的 query 及其应有极性。 */
interface QueryInfo {
  query: string;
  should_trigger: boolean;
}

/** 单条 query 在一次迭代里的结果。 */
interface ResultItem {
  query: string;
  should_trigger?: boolean;
  pass: boolean;
  triggers: number;
  runs: number;
}

/** 一次迭代（一条描述）的记录；后半段字段为旧版兼容字段。 */
interface HistoryEntry {
  iteration?: number;
  description?: string;
  train_passed?: number;
  train_total?: number;
  train_results?: ResultItem[];
  test_passed?: number | null;
  test_total?: number | null;
  test_results?: ResultItem[] | null;
  // 旧版兼容字段
  passed?: number;
  total?: number;
  results?: ResultItem[];
}

/** 报告数据（形状来自 run_loop 的输出）。 */
interface ReportData {
  history?: HistoryEntry[];
  holdout?: number;
  original_description?: string;
  best_description?: string;
  best_score?: string;
  best_test_score?: string | null;
  best_train_score?: string | null;
  iterations_run?: number;
  train_size?: number;
  test_size?: number;
}

/** `generateHtml` 的可选项。 */
export interface GenerateHtmlOptions {
  /** 是否插入每 5 秒自动刷新的 meta 标签（优化进行中时用）。 */
  autoRefresh?: boolean;
  /** 技能名；给出时作为页面标题前缀。 */
  skillName?: string;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 生成描述优化的 HTML 报告。
 *
 * 表头与每行的列都按第一次迭代的 query 列表展开；历史记录里缺某条 query 的结果时按
 * 未通过渲染（`r?.pass ?? false`），因此后加入的 query 不会改变既有列的位置。
 *
 * @param data run_loop 输出的报告数据（`history` / 原始与最佳描述 / 各项分数）
 * @param opts 自动刷新开关与技能名
 * @returns 完整 HTML 文本
 * @throws `history` 为空数组时抛 `TypeError`（上游行为：空数据会在求最佳迭代处 reduce
 *         一个空数组，未修，见 `docs/design/上游携带缺陷台账.md`）
 */
export function generateHtml(
  data: Record<string, unknown>,
  opts: GenerateHtmlOptions = {},
): string {
  const d = data as unknown as ReportData;
  const { autoRefresh = false, skillName = "" } = opts;
  const history = d.history ?? [];
  const titlePrefix = skillName ? escapeHtml(skillName) + " \u2014 " : "";

  // 列集合取自第一次迭代：后续迭代不再新增列
  const trainQueries: QueryInfo[] = [];
  const testQueries: QueryInfo[] = [];
  if (history.length > 0) {
    const first = history[0];
    for (const r of first.train_results ?? first.results ?? []) {
      trainQueries.push({ query: r.query, should_trigger: r.should_trigger ?? true });
    }
    if (first.test_results) {
      for (const r of first.test_results) {
        testQueries.push({ query: r.query, should_trigger: r.should_trigger ?? true });
      }
    }
  }

  const refreshTag = autoRefresh
    ? '    <meta http-equiv="refresh" content="5">\n'
    : "";

  const parts: string[] = [];

  // 页面头部（含全部内联样式与 Google Fonts 外链，样式原样照搬上游）
  parts.push(`<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
${refreshTag}    <title>${titlePrefix}Skill Description Optimization</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&family=Lora:wght@400;500&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Lora', Georgia, serif;
            max-width: 100%;
            margin: 0 auto;
            padding: 20px;
            background: #faf9f5;
            color: #141413;
        }
        h1 { font-family: 'Poppins', sans-serif; color: #141413; }
        .explainer {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #e8e6dc;
            color: #b0aea5;
            font-size: 0.875rem;
            line-height: 1.6;
        }
        .summary {
            background: white;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #e8e6dc;
        }
        .summary p { margin: 5px 0; }
        .best { color: #788c5d; font-weight: bold; }
        .table-container {
            overflow-x: auto;
            width: 100%;
        }
        table {
            border-collapse: collapse;
            background: white;
            border: 1px solid #e8e6dc;
            border-radius: 6px;
            font-size: 12px;
            min-width: 100%;
        }
        th, td {
            padding: 8px;
            text-align: left;
            border: 1px solid #e8e6dc;
            white-space: normal;
            word-wrap: break-word;
        }
        th {
            font-family: 'Poppins', sans-serif;
            background: #141413;
            color: #faf9f5;
            font-weight: 500;
        }
        th.test-col {
            background: #6a9bcc;
        }
        th.query-col { min-width: 200px; }
        td.description {
            font-family: monospace;
            font-size: 11px;
            word-wrap: break-word;
            max-width: 400px;
        }
        td.result {
            text-align: center;
            font-size: 16px;
            min-width: 40px;
        }
        td.test-result {
            background: #f0f6fc;
        }
        .pass { color: #788c5d; }
        .fail { color: #c44; }
        .rate {
            font-size: 9px;
            color: #b0aea5;
            display: block;
        }
        tr:hover { background: #faf9f5; }
        .score {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 4px;
            font-weight: bold;
            font-size: 11px;
        }
        .score-good { background: #eef2e8; color: #788c5d; }
        .score-ok { background: #fef3c7; color: #d97706; }
        .score-bad { background: #fceaea; color: #c44; }
        .train-label { color: #b0aea5; font-size: 10px; }
        .test-label { color: #6a9bcc; font-size: 10px; font-weight: bold; }
        .best-row { background: #f5f8f2; }
        th.positive-col { border-bottom: 3px solid #788c5d; }
        th.negative-col { border-bottom: 3px solid #c44; }
        th.test-col.positive-col { border-bottom: 3px solid #788c5d; }
        th.test-col.negative-col { border-bottom: 3px solid #c44; }
        .legend { font-family: 'Poppins', sans-serif; display: flex; gap: 20px; margin-bottom: 10px; font-size: 13px; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 6px; }
        .legend-swatch { width: 16px; height: 16px; border-radius: 3px; display: inline-block; }
        .swatch-positive { background: #141413; border-bottom: 3px solid #788c5d; }
        .swatch-negative { background: #141413; border-bottom: 3px solid #c44; }
        .swatch-test { background: #6a9bcc; }
        .swatch-train { background: #141413; }
    </style>
</head>
<body>
    <h1>${titlePrefix}Skill Description Optimization</h1>
    <div class="explainer">
        <strong>Optimizing your skill's description.</strong> This page updates automatically as OpenCode tests different versions of your skill's description. Each row is an iteration \u2014 a new description attempt. The columns show test queries: green checkmarks mean the skill triggered correctly (or correctly didn't trigger), red crosses mean it got it wrong. The "Train" score shows performance on queries used to improve the description; the "Test" score shows performance on held-out queries the optimizer hasn't seen. When it's done, OpenCode will apply the best-performing description to your skill.
    </div>
`);

  // 概要段：原始描述、最佳描述、最佳分数与迭代/训练/测试规模
  parts.push(`
    <div class="summary">
        <p><strong>Original:</strong> ${escapeHtml(d.original_description ?? "N/A")}</p>
        <p class="best"><strong>Best:</strong> ${escapeHtml(d.best_description ?? "N/A")}</p>
        <p><strong>Best Score:</strong> ${d.best_score ?? "N/A"} ${d.best_test_score ? "(test)" : "(train)"}</p>
        <p><strong>Iterations:</strong> ${d.iterations_run ?? 0} | <strong>Train:</strong> ${d.train_size ?? "?"} | <strong>Test:</strong> ${d.test_size ?? "?"}</p>
    </div>
`);

  // 图例：列的颜色约定
  parts.push(`
    <div class="legend">
        <span style="font-weight:600">Query columns:</span>
        <span class="legend-item"><span class="legend-swatch swatch-positive"></span> Should trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-negative"></span> Should NOT trigger</span>
        <span class="legend-item"><span class="legend-swatch swatch-train"></span> Train</span>
        <span class="legend-item"><span class="legend-swatch swatch-test"></span> Test</span>
    </div>
`);

  // 表头：固定四列 + 训练集 query 列 + 测试集 query 列
  parts.push(`
    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th>Iter</th>
                <th>Train</th>
                <th>Test</th>
                <th class="query-col">Description</th>
`);

  for (const qinfo of trainQueries) {
    const polarity = qinfo.should_trigger ? "positive-col" : "negative-col";
    parts.push(
      `                <th class="${polarity}">${escapeHtml(qinfo.query)}</th>\n`,
    );
  }
  for (const qinfo of testQueries) {
    const polarity = qinfo.should_trigger ? "positive-col" : "negative-col";
    parts.push(
      `                <th class="test-col ${polarity}">${escapeHtml(qinfo.query)}</th>\n`,
    );
  }

  parts.push(`            </tr>
        </thead>
        <tbody>
`);

  // 找出最值得高亮的那一行：有留出集时按 test 通过数，否则按 train 通过数；
  // reduce 的比较用 `>=`，因此并列时取靠后的那一条。
  let bestIter: number | undefined;
  if (testQueries.length > 0) {
    bestIter = history.reduce((best, h) =>
      (h.test_passed ?? 0) >= (best.test_passed ?? 0) ? h : best,
    ).iteration;
  } else {
    bestIter = history.reduce((best, h) =>
      (h.train_passed ?? h.passed ?? 0) >= (best.train_passed ?? best.passed ?? 0)
        ? h
        : best,
    ).iteration;
  }

  /**
   * 把一次迭代的结果折算成「正确次数 / 总运行次数」。
   *
   * 应触发的 query 记触发次数，不应触发的记未触发次数。
   *
   * @param results 该迭代的 query 结果
   * @returns `[correct, total]` 二元组
   */
  function aggregateRuns(results: ResultItem[]): [number, number] {
    let correct = 0;
    let total = 0;
    for (const r of results) {
      total += r.runs;
      if (r.should_trigger ?? true) {
        correct += r.triggers;
      } else {
        correct += r.runs - r.triggers;
      }
    }
    return [correct, total];
  }

  /**
   * 按正确率给出分数徽标的样式类。
   *
   * @param correct 正确次数
   * @param total 总次数
   * @returns `score-good`（≥80%）/ `score-ok`（≥50%）/ `score-bad`
   */
  function scoreClass(correct: number, total: number): string {
    if (total > 0) {
      const ratio = correct / total;
      if (ratio >= 0.8) return "score-good";
      if (ratio >= 0.5) return "score-ok";
    }
    return "score-bad";
  }

  // 每个迭代一行
  for (const h of history) {
    const iteration = h.iteration ?? "?";
    const description = h.description ?? "";
    const trainResults = h.train_results ?? h.results ?? [];
    const testResults = h.test_results ?? [];

    const trainByQuery = new Map(trainResults.map((r) => [r.query, r]));
    const testByQuery = new Map((testResults ?? []).map((r) => [r.query, r]));

    const [trainCorrect, trainRuns] = aggregateRuns(trainResults);
    const [testCorrect, testRuns] = aggregateRuns(testResults ?? []);

    const trainClass = scoreClass(trainCorrect, trainRuns);
    const testClass = scoreClass(testCorrect, testRuns);
    const rowClass = iteration === bestIter ? "best-row" : "";

    parts.push(`            <tr class="${rowClass}">
                <td>${iteration}</td>
                <td><span class="score ${trainClass}">${trainCorrect}/${trainRuns}</span></td>
                <td><span class="score ${testClass}">${testCorrect}/${testRuns}</span></td>
                <td class="description">${escapeHtml(description)}</td>
`);

    // 训练集 query 单元格
    for (const qinfo of trainQueries) {
      const r = trainByQuery.get(qinfo.query);
      const didPass = r?.pass ?? false;
      const triggers = r?.triggers ?? 0;
      const runs = r?.runs ?? 0;
      const icon = didPass ? "\u2713" : "\u2717";
      const cssClass = didPass ? "pass" : "fail";
      parts.push(
        `                <td class="result ${cssClass}">${icon}<span class="rate">${triggers}/${runs}</span></td>\n`,
      );
    }

    // 留出集 query 单元格
    for (const qinfo of testQueries) {
      const r = testByQuery.get(qinfo.query);
      const didPass = r?.pass ?? false;
      const triggers = r?.triggers ?? 0;
      const runs = r?.runs ?? 0;
      const icon = didPass ? "\u2713" : "\u2717";
      const cssClass = didPass ? "pass" : "fail";
      parts.push(
        `                <td class="result test-result ${cssClass}">${icon}<span class="rate">${triggers}/${runs}</span></td>\n`,
      );
    }

    parts.push("            </tr>\n");
  }

  parts.push(`        </tbody>
    </table>
    </div>

</body>
</html>
`);

  return parts.join("");
}
