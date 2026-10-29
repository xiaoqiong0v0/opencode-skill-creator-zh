/**
 * `lib/run-loop` 的训练/测试切分必须按评测集位置进行。
 *
 * 迁自上游 `.tmp/old/plugin/test/run-loop-split.test.ts`（基线 `d4383924`）：上游用
 * bun 的 `mock.module`，这里换成 Node 内置版本（需 `--experimental-test-module-mocks`）。
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

/**
 * 构造一条聚合后的评测结果条目（默认：应触发、0 触发、未通过）。
 *
 * @param {string} query 评测 query
 * @param {Record<string, unknown>} overrides 需要覆盖的字段
 * @returns {Record<string, unknown>} 评测结果条目
 */
const evalResult = (query, overrides = {}) => ({
  query,
  should_trigger: true,
  trigger_rate: 0,
  triggers: 0,
  runs: 1,
  successful_runs: 1,
  errors: 0,
  pass: false,
  ...overrides,
});

/**
 * P42-03：`runLoop` 必须按 `[...trainSet, ...testSet]` 的位置切分评测结果，遵守
 * `runEval` 的既定契约（每条评测集条目一条结果、按评测集顺序返回）。改成按 query
 * 文本匹配，会把跨 holdout 边界重复的 query 全都算到一侧，污染 holdout 分数。
 */
test("runLoop 按评测集位置切分训练/测试，即使同一 query 跨边界重复", async () => {
  mock.module("../dist/lib/utils.js", {
    exports: {
      parseSkillMd: () => ({
        name: "split-skill",
        description: "original description",
        fullContent: "skill content",
      }),
    },
  });

  // 契约对齐：每条评测集条目一条结果、按评测集顺序返回。
  mock.module("../dist/lib/run-eval.js", {
    exports: {
      abortError: (message = "aborted") => {
        const error = new Error(message);
        error.name = "AbortError";
        return error;
      },
      buildEvalWarnings: () => [],
      runEval: (opts) => ({
        skill_name: "split-skill",
        description: "original description",
        results: opts.evalSet.map((item) =>
          evalResult(item.query, { should_trigger: item.should_trigger }),
        ),
        warnings: [],
        summary: {
          passed: 0,
          failed: opts.evalSet.length,
          total: opts.evalSet.length,
          run_errors: 0,
          queries_with_errors: 0,
        },
      }),
    },
  });

  mock.module("../dist/lib/improve-description.js", {
    exports: { improveDescription: () => "improved description" },
  });

  mock.module("../dist/lib/report.js", {
    exports: { generateHtml: () => "<html></html>" },
  });

  const evalSet = [
    { query: "dup query", should_trigger: true },
    { query: "other query", should_trigger: true },
    { query: "negative query", should_trigger: false },
    { query: "dup query", should_trigger: true },
  ];
  const originalError = console.error;
  console.error = () => {};

  try {
    const { runLoop } = await import("../dist/lib/run-loop.js");
    const output = await runLoop({
      evalSet,
      skillPath: "/tmp/skill/SKILL.md",
      numWorkers: 1,
      timeout: 1,
      maxIterations: 1,
      runsPerQuery: 1,
      triggerThreshold: 0.5,
      triggerOnly: true,
      holdout: 0.5,
      model: undefined,
      agent: undefined,
      verbose: false,
      projectRoot: "/tmp/project",
    });

    const entry = output.history[0];
    // 3 条正向 + 1 条负向 -> 测试集各 1 条，训练集 2 条。
    assert.equal(output.train_size, 2);
    assert.equal(output.test_size, 2);
    assert.equal(entry?.train_results?.length, output.train_size);
    assert.equal(entry?.test_results?.length, output.test_size);
    // 重复的 query 在两侧各落一条（按文本匹配会把两份都归到训练集，测试集就短一条）。
    assert.deepEqual(
      entry?.train_results?.map((r) => r.query).sort(),
      ["dup query", "other query"],
    );
    assert.deepEqual(
      entry?.test_results?.map((r) => r.query).sort(),
      ["dup query", "negative query"],
    );
  } finally {
    console.error = originalError;
    mock.restoreAll();
  }
});
