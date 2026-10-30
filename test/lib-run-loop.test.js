/**
 * `lib/run-loop` 的告警推导、`projectRoot` 钉定与取消信号传递契约。
 *
 * 迁自上游 `.tmp/old/plugin/test/run-loop.test.ts`（基线 `d4383924`）。上游用 bun 的
 * `mock.module`，这里换成 Node 内置 `mock.module`（需 `--experimental-test-module-mocks`，
 * 已写进 `npm test`）。mock 只替换被测模块的外部依赖，被守护的行为与断言保持原样。
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { MOCK_EXPORTS_KEY } from "./helpers/mock-module.js";

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
  runs: 3,
  successful_runs: 3,
  errors: 0,
  pass: false,
  ...overrides,
});

test("runLoop 用训练集结果推导告警，并对两侧重复的告警只打印一次", async () => {
  /** 每次改善调用收到的评测结果。 */
  const improveCalls = [];
  /** 每次评测使用的项目根。 */
  const evalRoots = [];
  /** 每次评测收到的取消信号。 */
  const evalSignals = [];
  /** 每次改善调用收到的项目根与取消信号。 */
  const improveTargets = [];

  mock.module("../dist/lib/utils.js", {
    [MOCK_EXPORTS_KEY]: {
      parseSkillMd: () => ({
        name: "warning-skill",
        description: "original description",
        fullContent: "skill content",
      }),
    },
  });

  mock.module("../dist/lib/run-eval.js", {
    [MOCK_EXPORTS_KEY]: {
      abortError: (message = "aborted") => {
        const error = new Error(message);
        error.name = "AbortError";
        return error;
      },
      buildEvalWarnings: (results) => {
        const shouldTriggerResults = results.filter((r) => r.should_trigger);
        if (shouldTriggerResults.length === 0) return [];
        return shouldTriggerResults.every(
          (r) => r.triggers === 0 && r.errors === 0,
        )
          ? ["all-zero warning"]
          : [];
      },
      // 契约对齐：每条评测集条目一条结果、按评测集顺序返回（`runLoop` 按位置切分）。
      // 硬编码一个乱序数组就不再是受支持的调用方了。
      runEval: (opts) => {
        evalRoots.push(opts.projectRoot);
        evalSignals.push(opts.signal);
        return {
          skill_name: "warning-skill",
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
        };
      },
    },
  });

  mock.module("../dist/lib/improve-description.js", {
    [MOCK_EXPORTS_KEY]: {
      improveDescription: (opts) => {
        improveCalls.push({ evalResults: opts.evalResults });
        improveTargets.push({
          projectRoot: opts.projectRoot,
          signal: opts.signal,
        });
        return "improved description";
      },
    },
  });

  mock.module("../dist/lib/report.js", {
    [MOCK_EXPORTS_KEY]: { generateHtml: () => "<html></html>" },
  });

  const evalSet = [
    { query: "train trigger", should_trigger: true },
    { query: "train negative", should_trigger: false },
    { query: "test trigger", should_trigger: true },
  ];
  /** verbose 模式下 runLoop 写到 stderr 的行。 */
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };

  try {
    const { runLoop } = await import("../dist/lib/run-loop.js");
    const controller = new AbortController();
    await runLoop({
      evalSet,
      skillPath: "/tmp/skill/SKILL.md",
      numWorkers: 1,
      timeout: 1,
      maxIterations: 2,
      runsPerQuery: 3,
      triggerThreshold: 0.5,
      triggerOnly: true,
      holdout: 1 / 3,
      model: undefined,
      agent: undefined,
      verbose: true,
      // LD1-3：循环必须评测调用方指定的实例根，绝不能用 process-cwd 派生的根
      // （上游在循环开头调用 `findProjectRoot()` 正是这条用例守护的回归）。
      projectRoot: "/tmp/instance-root",
      signal: controller.signal,
    });

    assert.deepEqual(evalRoots, ["/tmp/instance-root", "/tmp/instance-root"]);
    assert.deepEqual(improveCalls[0]?.evalResults.warnings, ["all-zero warning"]);
    assert.equal(
      errors.filter((line) => line === "Warning: all-zero warning").length,
      2,
    );
    // 调用方的 signal 同时到达评测阶段与改善子进程。
    assert.ok(evalSignals.every((signal) => signal === controller.signal));
    // 循环的改善子进程钉到同一个项目根。
    assert.equal(improveTargets[0]?.projectRoot, "/tmp/instance-root");
    assert.equal(improveTargets[0]?.signal, controller.signal);
  } finally {
    console.error = originalError;
    mock.restoreAll();
  }
});
