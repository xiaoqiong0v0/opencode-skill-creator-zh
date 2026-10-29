/**
 * `lib/failure-taxonomy` 的失败归类行为（迁自上游 `test/failure-taxonomy.test.ts`）。
 *
 * 诊断文案是返回值的一部分，用例逐字比对英文原文，作为「文案未漂移」的守门。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyEvalFailures,
  formatFailureDiagnostics,
} from "../dist/lib/failure-taxonomy.js";

/**
 * 构造一条不通过的评测结果，只覆盖本用例关心的字段。
 *
 * @param {object} overrides 需要覆盖的字段
 * @returns {object} 完整的评测条目
 */
const baseResult = (overrides) => ({
  query: "query",
  should_trigger: true,
  trigger_rate: 0,
  triggers: 0,
  runs: 3,
  successful_runs: 3,
  errors: 0,
  pass: false,
  ...overrides,
});

test("classifyEvalFailures 把「应触发却没触发」的不通过条目归为假阴性", () => {
  assert.deepEqual(
    classifyEvalFailures([
      baseResult({
        query: "Create a skill for repository cleanup",
        should_trigger: true,
        triggers: 0,
      }),
    ]),
    [
      {
        category: "false_negative",
        query: "Create a skill for repository cleanup",
        explanation: "The skill should have triggered but did not.",
        remediation:
          "Broaden the description around this intent without listing only this exact query.",
      },
    ],
  );
});

test("classifyEvalFailures 把「不该触发却触发」的不通过条目归为假阳性", () => {
  assert.deepEqual(
    classifyEvalFailures([
      baseResult({
        query: "Explain TypeScript generics",
        should_trigger: false,
        triggers: 2,
      }),
    ]),
    [
      {
        category: "false_positive",
        query: "Explain TypeScript generics",
        explanation: "The skill triggered for a query that should not use it.",
        remediation: "Add clearer boundaries for when not to use the skill.",
      },
    ],
  );
});

test("classifyEvalFailures 优先按运行错误归类，再看触发准确性", () => {
  assert.deepEqual(
    classifyEvalFailures([
      baseResult({
        query: "Broken eval query",
        errors: 1,
        triggers: 0,
      }),
    ]),
    [
      {
        category: "run_error",
        query: "Broken eval query",
        explanation:
          "The eval run had execution errors, so trigger accuracy is not trustworthy.",
        remediation:
          "Fix the eval execution error before optimizing this description.",
      },
    ],
  );
});

test("classifyEvalFailures 忽略通过的条目", () => {
  assert.deepEqual(
    classifyEvalFailures([
      baseResult({
        query: "Passing trigger",
        triggers: 3,
        pass: true,
      }),
      baseResult({
        query: "Passing non-trigger",
        should_trigger: false,
        triggers: 0,
        pass: true,
      }),
    ]),
    [],
  );
});

test("没有诊断时 formatFailureDiagnostics 返回空串", () => {
  assert.equal(formatFailureDiagnostics([]), "");
});

test("formatFailureDiagnostics 每条诊断一行", () => {
  assert.equal(
    formatFailureDiagnostics([
      {
        category: "false_negative",
        query: "Create a skill",
        explanation: "The skill should have triggered but did not.",
        remediation:
          "Broaden the description around this intent without listing only this exact query.",
      },
      {
        category: "false_positive",
        query: "Explain cooking",
        explanation: "The skill triggered for a query that should not use it.",
        remediation: "Add clearer boundaries for when not to use the skill.",
      },
    ]),
    [
      "- [false_negative] Create a skill: The skill should have triggered but did not. Broaden the description around this intent without listing only this exact query.",
      "- [false_positive] Explain cooking: The skill triggered for a query that should not use it. Add clearer boundaries for when not to use the skill.",
    ].join("\n"),
  );
});
