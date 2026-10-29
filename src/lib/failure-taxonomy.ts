/**
 * 失败归类：把不通过的评测条目分成假阴性 / 假阳性 / 运行错误三类，供优化提示使用。
 *
 * 迁自上游 `plugin/lib/failure-taxonomy.ts`（基线 `d4383924`），行为保持不变。
 */

import type { EvalResultItem } from "./run-eval.js";

/** 失败类别。 */
export type FailureCategory = "false_negative" | "false_positive" | "run_error";

/** 单条失败的归类结果。 */
export interface FailureDiagnostic {
  category: FailureCategory;
  query: string;
  explanation: string;
  remediation: string;
}

/**
 * 把不通过的评测条目归类成诊断信息。
 *
 * 判定顺序与上游一致：先看运行错误（此时触发率不可信），再看「应触发却没触发」，
 * 其余一律按假阳性处理。诊断文案属于返回值的一部分（沿用上游英文原文），不随本仓
 * 中文化改动。
 *
 * @param results 一次评测的全部条目
 * @returns 只含不通过条目的诊断数组；全部通过时返回空数组
 */
export function classifyEvalFailures(
  results: EvalResultItem[],
): FailureDiagnostic[] {
  return results
    .filter((result) => !result.pass)
    .map((result): FailureDiagnostic => {
      if (result.errors > 0) {
        return {
          category: "run_error",
          query: result.query,
          explanation:
            "The eval run had execution errors, so trigger accuracy is not trustworthy.",
          remediation:
            "Fix the eval execution error before optimizing this description.",
        };
      }

      if (result.should_trigger) {
        return {
          category: "false_negative",
          query: result.query,
          explanation: "The skill should have triggered but did not.",
          remediation:
            "Broaden the description around this intent without listing only this exact query.",
        };
      }

      return {
        category: "false_positive",
        query: result.query,
        explanation: "The skill triggered for a query that should not use it.",
        remediation: "Add clearer boundaries for when not to use the skill.",
      };
    });
}

/**
 * 把诊断数组渲染成逐行文本，供提示词或命令行输出使用。
 *
 * @param diagnostics 诊断数组
 * @returns 每行一条的文本；没有诊断时返回空串
 */
export function formatFailureDiagnostics(
  diagnostics: FailureDiagnostic[],
): string {
  if (diagnostics.length === 0) return "";

  return diagnostics
    .map(
      (diagnostic) =>
        `- [${diagnostic.category}] ${diagnostic.query}: ${diagnostic.explanation} ${diagnostic.remediation}`,
    )
    .join("\n");
}
