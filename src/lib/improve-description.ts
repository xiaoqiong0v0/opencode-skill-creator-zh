/**
 * 描述优化器 —— 依据评测结果调用 OpenCode 生成更好的技能描述。
 *
 * 迁自上游 `plugin/lib/improve-description.ts`（基线 `d4383924`），行为保持不变：
 * 把提示词写进系统临时目录的文件，再用 `opencode run --format json --file <临时文件>`
 * 让它处理；从响应的文本事件里解析 `<new_description>` 标签。描述超过 1024 字符时
 * 再请求一次改写。临时文件在 `finally` 里删除，异常路径也不例外。
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyEvalFailures,
  formatFailureDiagnostics,
} from "./failure-taxonomy.js";
import { buildOpencodeEnv, isFailedProcess, runProcess } from "./process.js";
import { abortError } from "./run-eval.js";

import type { EvalOutput, EvalResultItem } from "./run-eval.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 临时提示词文件名前缀（落在系统临时目录）。 */
const TEMP_PROMPT_PREFIX = "skill-creator-";
/** 临时提示词文件名随机后缀的字节数。 */
const TEMP_PROMPT_RANDOM_BYTES = 6;
/** stderr 保留上限（字符），超出只留尾部。 */
const MAX_STDERR_CHARS = 64 * 1024;
/** 优化子进程的默认超时（秒）。 */
const DEFAULT_TIMEOUT_SECONDS = 300;
/** 描述硬上限（字符）；超过就再请求一次更短的改写。 */
const DESCRIPTION_CHAR_LIMIT = 1024;
/** 从响应中取出 `<new_description>` 标签内容。 */
const NEW_DESCRIPTION_RE = /<new_description>([\s\S]*?)<\/new_description>/;
/** 去掉描述两端可能残留的单/双引号。 */
const EDGE_QUOTE_RE = /^["']|["']$/g;
/** 提示词尾随消息：让模型处理附件文件本身。 */
const TRAILING_MESSAGE = "Process the attached file and follow its instructions.";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * 用写进临时文件的提示词跑一次 `opencode run`，返回它的文本响应。
 *
 * 临时文件无论成功、失败还是被取消都会在 `finally` 里删除（保持上游语义：清理不能
 * 依赖正常路径）。
 *
 * @param prompt 完整提示词文本（原样写入临时文件）
 * @param model 模型名；`undefined` 时不传 `--model`，交给 opencode 自己选默认
 * @param timeout 超时秒数（默认 300 秒）
 * @param opts 项目根与调用方取消信号
 * @returns 模型返回的文本：优先用 JSON 事件里的 text 分片拼接，否则退回原始 stdout
 * @throws 取消时抛 `AbortError`；子进程失败时抛带退出码与 stderr 的错误
 */
async function callOpenCode(
  prompt: string,
  model: string | undefined,
  timeout: number = DEFAULT_TIMEOUT_SECONDS,
  opts: { projectRoot?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const tmpPath = join(
    tmpdir(),
    `${TEMP_PROMPT_PREFIX}${randomBytes(TEMP_PROMPT_RANDOM_BYTES).toString("hex")}.md`,
  );
  writeFileSync(tmpPath, prompt);

  try {
    if (opts.signal?.aborted) throw abortError();
    const cmd: string[] = ["opencode", "run", "--format", "json"];
    if (model) cmd.push("--model", model);
    // 用 `--` 结束选项解析，让尾随的提示语被当成位置参数，而不是又一个 `--file` 的值。
    cmd.push("--file", tmpPath, "--", TRAILING_MESSAGE);

    // 逐行收集 stdout。JSON 模式下优先取结构化的 text 事件。
    let stdout = "";
    let lineBuffer = "";
    const textParts: string[] = [];
    const timeoutMs = timeout * 1000;

    /** 处理一整行 stdout：只认 `type === "text"` 的事件分片，其余（含非 JSON 行）丢弃。 */
    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (event.type !== "text") return;
        // `part` 是 JSON 里的嵌套对象，边界处断言后收窄。
        const part = event.part as Record<string, unknown> | undefined;
        if (!part || typeof part !== "object") return;
        const text = part.text;
        if (typeof text === "string") {
          textParts.push(text);
        }
      } catch {
        // 非 JSON 行直接忽略。
      }
    };

    /** 把行缓冲里已完整的行逐行喂给 `consumeLine`；`final` 为真时再冲刷残余部分。 */
    const flushLines = (final: boolean = false): void => {
      let idx = lineBuffer.indexOf("\n");
      while (idx !== -1) {
        const line = lineBuffer.slice(0, idx);
        lineBuffer = lineBuffer.slice(idx + 1);
        consumeLine(line);
        idx = lineBuffer.indexOf("\n");
      }

      if (final && lineBuffer.trim()) {
        consumeLine(lineBuffer);
        lineBuffer = "";
      }
    };

    // 改善子进程本身没有显式 cwd；把 PWD/cwd 钉到这条改善所属的项目根，让它按选中的
    // 项目解析 providers/agents，而不是沿用调用方可能已经过时的 PWD。
    const cwd = opts.projectRoot ?? process.cwd();
    const result = await runProcess(cmd, {
      cwd,
      env: buildOpencodeEnv(cwd),
      timeoutMs,
      maxStderrChars: MAX_STDERR_CHARS,
      signal: opts.signal,
      onStdoutChunk(chunk: string): void {
        stdout += chunk;
        lineBuffer += chunk;
        flushLines();
      },
    });

    flushLines(true);

    // 被取消的改善不算失败的改善。
    if (result.aborted || opts.signal?.aborted) {
      throw abortError();
    }

    if (isFailedProcess(result)) {
      throw new Error(
        `opencode run exited ${result.exitCode}\nstderr: ${result.stderr}`,
      );
    }

    if (textParts.length > 0) {
      return textParts.join("");
    }

    return stdout;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* 临时文件已被清理或从未落盘，忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 历史迭代记录：上一轮的描述及分数，会回灌进优化提示词供模型避免重复。 */
export interface HistoryEntry {
  description: string;
  passed?: number;
  failed?: number;
  total?: number;
  train_passed?: number;
  train_failed?: number;
  train_total?: number;
  test_passed?: number | null;
  test_failed?: number | null;
  test_total?: number | null;
  results?: EvalResultItem[];
  note?: string;
}

/** `improveDescription` 的入参。 */
export interface ImproveDescriptionOptions {
  skillName: string;
  skillContent: string;
  currentDescription: string;
  evalResults: EvalOutput;
  history: HistoryEntry[];
  model: string | undefined;
  testResults?: EvalOutput | null;
  logDir?: string | null;
  iteration?: number | null;
  /** 改善子进程必须据此解析 providers/agents 的项目根。 */
  projectRoot?: string;
  /** 调用方持有的取消信号；abort 时杀掉改善子进程。 */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 依据评测结果让 OpenCode 改写技能描述，返回新描述。
 *
 * 提示词按固定顺序拼装：当前描述与分数 → 未触发条目 → 误触发条目 → 历史尝试
 * （模型不得重复）→ 技能正文 → 失败诊断。响应先按 `<new_description>` 标签解析，
 * 没有标签就整段当描述并去掉两端引号；超过 1024 字符时把上一版结果附在提示词尾部
 * 再请求一次更短的改写。给了 `logDir` 时把整份对话记录写成 JSON。
 *
 * @param opts 技能名/正文、当前描述、评测结果、历史、模型、项目根与取消信号
 * @returns 最终采用的描述文本（已去两端引号）
 * @throws 取消时抛 `AbortError`；`opencode run` 失败时抛带退出码与 stderr 的错误
 */
export async function improveDescription(
  opts: ImproveDescriptionOptions,
): Promise<string> {
  const {
    skillName,
    skillContent,
    currentDescription,
    evalResults,
    history,
    model,
    testResults,
    logDir,
    iteration,
    projectRoot,
    signal,
  } = opts;

  const failedTriggers = evalResults.results.filter(
    (r) => r.should_trigger && !r.pass,
  );
  const falseTriggers = evalResults.results.filter(
    (r) => !r.should_trigger && !r.pass,
  );

  const trainScore = `${evalResults.summary.passed}/${evalResults.summary.total}`;
  let scoresSummary: string;
  if (testResults) {
    const testScore = `${testResults.summary.passed}/${testResults.summary.total}`;
    scoresSummary = `Train: ${trainScore}, Test: ${testScore}`;
  } else {
    scoresSummary = `Train: ${trainScore}`;
  }

  // 提示词正文保持上游英文原文：它是驱动模型行为的输入，翻译会改变行为。
  let prompt = `You are optimizing a skill description for an OpenCode skill called "${skillName}". A "skill" is sort of like a prompt, but with progressive disclosure -- there's a title and description that the agent sees when deciding whether to use the skill, and then if it does use the skill, it reads the .md file which has lots more details and potentially links to other resources in the skill folder like helper files and scripts and additional documentation or examples.

The description appears in the agent's "available_skills" list. When a user sends a query, the agent decides whether to invoke the skill based solely on the title and on this description. Your goal is to write a description that triggers for relevant queries, and doesn't trigger for irrelevant ones.

Here's the current description:
<current_description>
"${currentDescription}"
</current_description>

Current scores (${scoresSummary}):
<scores_summary>
`;

  if (failedTriggers.length > 0) {
    prompt += "FAILED TO TRIGGER (should have triggered but didn't):\n";
    for (const r of failedTriggers) {
      prompt += `  - "${r.query}" (triggered ${r.triggers}/${r.runs} times)\n`;
    }
    prompt += "\n";
  }

  if (falseTriggers.length > 0) {
    prompt += "FALSE TRIGGERS (triggered but shouldn't have):\n";
    for (const r of falseTriggers) {
      prompt += `  - "${r.query}" (triggered ${r.triggers}/${r.runs} times)\n`;
    }
    prompt += "\n";
  }

  if (history.length > 0) {
    prompt +=
      "PREVIOUS ATTEMPTS (do NOT repeat these — try something structurally different):\n\n";
    for (const h of history) {
      const trainS = `${h.train_passed ?? h.passed ?? 0}/${h.train_total ?? h.total ?? 0}`;
      const testS =
        h.test_passed != null ? `${h.test_passed}/${h.test_total ?? "?"}` : null;
      const scoreStr = `train=${trainS}` + (testS ? `, test=${testS}` : "");
      prompt += `<attempt ${scoreStr}>\n`;
      prompt += `Description: "${h.description}"\n`;
      if (h.results) {
        prompt += "Train results:\n";
        for (const r of h.results) {
          const status = r.pass ? "PASS" : "FAIL";
          prompt += `  [${status}] "${r.query.slice(0, 80)}" (triggered ${r.triggers}/${r.runs})\n`;
        }
      }
      if (h.note) {
        prompt += `Note: ${h.note}\n`;
      }
      prompt += "</attempt>\n\n";
    }
  }

  const diagnostics = formatFailureDiagnostics(
    classifyEvalFailures(evalResults.results ?? []),
  );
  const failureDiagnosticsSection = diagnostics
    ? `\nFAILURE DIAGNOSTICS:\n${diagnostics}\n`
    : "";

  prompt += `</scores_summary>

Skill content (for context on what the skill does):
<skill_content>
${skillContent}
</skill_content>

Based on the failures, write a new and improved description that is more likely to trigger correctly. When I say "based on the failures", it's a bit of a tricky line to walk because we don't want to overfit to the specific cases you're seeing. So what I DON'T want you to do is produce an ever-expanding list of specific queries that this skill should or shouldn't trigger for. Instead, try to generalize from the failures to broader categories of user intent and situations where this skill would be useful or not useful. The reason for this is twofold:

1. Avoid overfitting
2. The list might get loooong and it's injected into ALL queries and there might be a lot of skills, so we don't want to blow too much space on any given description.

Concretely, your description should not be more than about 100-200 words, even if that comes at the cost of accuracy. There is a hard limit of 1024 characters — descriptions over that will be truncated, so stay comfortably under it.

Here are some tips that we've found to work well in writing these descriptions:
- The skill should be phrased in the imperative -- "Use this skill for" rather than "this skill does"
- The skill description should focus on the user's intent, what they are trying to achieve, vs. the implementation details of how the skill works.
- The description competes with other skills for the agent's attention — make it distinctive and immediately recognizable.
- If you're getting lots of failures after repeated attempts, change things up. Try different sentence structures or wordings.

I'd encourage you to be creative and mix up the style in different iterations since you'll have multiple opportunities to try different approaches and we'll just grab the highest-scoring one at the end.
${failureDiagnosticsSection}

Please respond with only the new description text in <new_description> tags, nothing else.`;

  const text = await callOpenCode(prompt, model, undefined, {
    projectRoot,
    signal,
  });

  const match = text.match(NEW_DESCRIPTION_RE);
  let description = match
    ? match[1].trim().replace(EDGE_QUOTE_RE, "")
    : text.trim().replace(EDGE_QUOTE_RE, "");

  const transcript: Record<string, unknown> = {
    iteration,
    prompt,
    response: text,
    parsed_description: description,
    char_count: description.length,
    over_limit: description.length > DESCRIPTION_CHAR_LIMIT,
  };

  // 兜底：超过 1024 字符就再要一版更短的。
  if (description.length > DESCRIPTION_CHAR_LIMIT) {
    const shortenPrompt =
      `${prompt}\n\n` +
      `---\n\n` +
      `A previous attempt produced this description, which at ` +
      `${description.length} characters is over the 1024-character hard limit:\n\n` +
      `"${description}"\n\n` +
      `Rewrite it to be under 1024 characters while keeping the most ` +
      `important trigger words and intent coverage. Respond with only ` +
      `the new description in <new_description> tags.`;

    const shortenText = await callOpenCode(shortenPrompt, model, undefined, {
      projectRoot,
      signal,
    });
    const shortenMatch = shortenText.match(NEW_DESCRIPTION_RE);
    const shortened = shortenMatch
      ? shortenMatch[1].trim().replace(EDGE_QUOTE_RE, "")
      : shortenText.trim().replace(EDGE_QUOTE_RE, "");

    transcript.rewrite_prompt = shortenPrompt;
    transcript.rewrite_response = shortenText;
    transcript.rewrite_description = shortened;
    transcript.rewrite_char_count = shortened.length;
    description = shortened;
  }

  transcript.final_description = description;

  if (logDir) {
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `improve_iter_${iteration ?? "unknown"}.json`);
    writeFileSync(logFile, JSON.stringify(transcript, null, 2));
  }

  return description;
}
