/**
 * `lib/report` 的 HTML 报告生成行为（新写，非迁移——上游无独立测试）。
 *
 * 用例全部对纯函数跑：只检查产出的 HTML 字符串，不起服务、不写盘、不开浏览器。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { generateHtml } from "../dist/lib/report.js";

/**
 * 按行切开渲染结果，返回每行那一段的 HTML。
 *
 * @param {string} html `generateHtml` 的输出
 * @returns {string[]} 每行一段（已去掉 `<tr class="` 前缀）
 */
const rowsOf = (html) => html.split('<tr class="').slice(1);

/**
 * 构造一条 query 结果。
 *
 * @param {object} overrides 需要覆盖的字段
 * @returns {object} 完整的 query 结果
 */
const resultItem = (overrides) => ({
  query: "q",
  should_trigger: true,
  pass: true,
  triggers: 3,
  runs: 3,
  ...overrides,
});

/** 两次迭代的完整样例：训练集 2 条、留出集 1 条，第二次明显更好。 */
const FULL_SAMPLE = {
  history: [
    {
      iteration: 0,
      description: "first try",
      train_passed: 1,
      train_total: 3,
      train_results: [
        resultItem({ query: "alpha", pass: false, triggers: 0, runs: 3 }),
        resultItem({ query: "beta", should_trigger: false, pass: true, triggers: 0, runs: 3 }),
      ],
      test_passed: 0,
      test_total: 3,
      test_results: [
        resultItem({ query: "gamma", should_trigger: false, pass: false, triggers: 1, runs: 3 }),
      ],
    },
    {
      iteration: 1,
      description: "second try",
      train_passed: 3,
      train_total: 3,
      train_results: [
        resultItem({ query: "alpha", pass: true, triggers: 3, runs: 3 }),
        resultItem({ query: "beta", should_trigger: false, pass: true, triggers: 0, runs: 3 }),
      ],
      test_passed: 3,
      test_total: 3,
      test_results: [
        resultItem({ query: "gamma", should_trigger: false, pass: true, triggers: 0, runs: 3 }),
      ],
    },
  ],
  original_description: "old <desc>",
  best_description: "new & best",
  best_score: "3/3",
  best_test_score: "3/3",
  iterations_run: 2,
  train_size: 2,
  test_size: 1,
};

test("渲染标题、概要字段、表头极性列与每行分数", () => {
  const html = generateHtml(FULL_SAMPLE);

  assert.ok(html.includes("<title>Skill Description Optimization</title>"));
  assert.ok(html.includes("<h1>Skill Description Optimization</h1>"));
  assert.ok(html.includes("<p><strong>Original:</strong> old &lt;desc&gt;</p>"));
  assert.ok(html.includes('<p class="best"><strong>Best:</strong> new &amp; best</p>'));
  // best_test_score 为真时标注 (test)，否则标 (train)
  assert.ok(html.includes("<p><strong>Best Score:</strong> 3/3 (test)</p>"));
  assert.ok(
    html.includes(
      "<p><strong>Iterations:</strong> 2 | <strong>Train:</strong> 2 | <strong>Test:</strong> 1</p>",
    ),
  );

  // 表头：训练集列按极性着色，留出集列额外带 test-col
  assert.ok(html.includes('<th class="positive-col">alpha</th>'));
  assert.ok(html.includes('<th class="negative-col">beta</th>'));
  assert.ok(html.includes('<th class="test-col negative-col">gamma</th>'));

  const rows = rowsOf(html);
  assert.equal(rows.length, 2);
  // 有留出集时按 test 通过数选最佳行：第二次 test_passed 3 > 0
  assert.ok(rows[0].startsWith('">'));
  assert.ok(rows[1].startsWith('best-row">'));

  // 训练集折算：alpha 计触发次数，beta 计未触发次数
  assert.ok(rows[0].includes('<span class="score score-ok">3/6</span>'));
  assert.ok(rows[1].includes('<span class="score score-good">6/6</span>'));
  // 留出集折算：不应触发时计 runs - triggers
  assert.ok(rows[0].includes('<span class="score score-ok">2/3</span>'));
  assert.ok(rows[1].includes('<span class="score score-good">3/3</span>'));

  // 逐格图标与 triggers/runs 小字
  assert.ok(rows[0].includes('<td class="result fail">✗<span class="rate">0/3</span></td>'));
  assert.ok(rows[0].includes('<td class="result pass">✓<span class="rate">0/3</span></td>'));
  assert.ok(
    rows[0].includes('<td class="result test-result fail">✗<span class="rate">1/3</span></td>'),
  );
});

test("query、描述与技能名都经过 HTML 转义", () => {
  const nasty = "<script>alert('x') & \"y\"</script>";
  const html = generateHtml(
    {
      history: [
        {
          iteration: 0,
          description: nasty,
          train_results: [resultItem({ query: nasty, pass: false, triggers: 0, runs: 2 })],
          test_results: [resultItem({ query: "ok", pass: true, triggers: 1, runs: 2 })],
        },
      ],
      original_description: nasty,
    },
    { skillName: 'sk <x> "q"' },
  );

  const escaped = "&lt;script&gt;alert('x') &amp; &quot;y&quot;&lt;/script&gt;";
  assert.ok(html.includes(escaped));
  // 原始未经转义的串一次都不该出现
  assert.ok(!html.includes(nasty));
  assert.ok(html.includes("sk &lt;x&gt; &quot;q&quot; \u2014 Skill Description Optimization"));
});

test("autoRefresh 开关决定是否插入 5 秒刷新标签", () => {
  assert.ok(!generateHtml(FULL_SAMPLE).includes('http-equiv="refresh"'));
  assert.ok(
    generateHtml(FULL_SAMPLE, { autoRefresh: true }).includes(
      '<meta http-equiv="refresh" content="5">',
    ),
  );
});

test("钉住上游缺口：history 为空数组时在求最佳迭代处抛 TypeError", () => {
  // 台账待补条目：`bestIter` 的 reduce 没有初值，空数据会让整个报告生成崩溃，
  // 而不是渲染一份空报告。修复本缺陷时须同步改此用例。
  for (const data of [{}, { history: [] }, { history: null }]) {
    assert.throws(
      () => generateHtml(data),
      (error) =>
        error instanceof TypeError &&
        /Reduce of empty array with no initial value/.test(error.message),
    );
  }
});

test("没有留出集时按训练集通过数选高亮行，并列时取靠后的一条", () => {
  const trainOnly = generateHtml({
    history: [
      { iteration: 0, train_passed: 1, train_results: [resultItem({ query: "q1", pass: false, triggers: 1, runs: 3 })] },
      { iteration: 1, train_passed: 2, train_results: [resultItem({ query: "q1", pass: true, triggers: 3, runs: 3 })] },
    ],
  });
  const trainRows = rowsOf(trainOnly);
  assert.ok(trainRows[0].startsWith('">'));
  assert.ok(trainRows[1].startsWith('best-row">'));

  const tied = generateHtml({
    history: [
      { iteration: 0, test_passed: 1, train_results: [resultItem({})], test_results: [resultItem({ query: "t" })] },
      { iteration: 1, test_passed: 1, train_results: [resultItem({})], test_results: [resultItem({ query: "t" })] },
    ],
  });
  const tiedRows = rowsOf(tied);
  assert.ok(tiedRows[0].startsWith('">'));
  assert.ok(tiedRows[1].startsWith('best-row">'));
});

test("旧版字段（passed / total / results）仍能渲染成训练集", () => {
  const html = generateHtml({
    history: [
      {
        iteration: 0,
        passed: 2,
        total: 4,
        results: [resultItem({ query: "legacy", pass: false, triggers: 1, runs: 2 })],
      },
    ],
  });

  assert.ok(html.includes('<th class="positive-col">legacy</th>'));
  // should_trigger 缺省按 true，故计触发次数：1/2 → score-ok
  assert.ok(html.includes('<span class="score score-ok">1/2</span>'));
  assert.ok(html.includes('<td class="result fail">✗<span class="rate">1/2</span></td>'));
});

test("后续迭代缺某条 query 的结果时按未通过渲染且计数为 0/0", () => {
  const html = generateHtml({
    history: [
      {
        iteration: 0,
        train_results: [
          resultItem({ query: "q1", triggers: 2, runs: 2 }),
          resultItem({ query: "q2", triggers: 2, runs: 2 }),
        ],
      },
      { iteration: 1, train_results: [resultItem({ query: "q1", triggers: 2, runs: 2 })] },
    ],
  });

  const rows = rowsOf(html);
  assert.equal(rows.length, 2);
  // 列集合固定在第一次迭代，第二次缺 q2 就按 0/0 的失败格渲染
  assert.ok(rows[1].includes('<td class="result fail">✗<span class="rate">0/0</span></td>'));
  // 缺的那条也不进分数汇总：q1 仍是 2/2
  assert.ok(rows[1].includes('<span class="score score-good">2/2</span>'));
});
