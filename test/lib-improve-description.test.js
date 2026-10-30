/**
 * `lib/improve-description` 的行为用例（**新写，非迁移**：上游没有这个模块的独立测试）。
 *
 * 覆盖：提示词组装与「无失败就不出失败段落」的跳过条件、临时提示词文件的落盘路径与
 * `finally` 清理、项目根钉定、超过 1024 字符的二次改写、日志落盘、子进程失败与调用方
 * 取消的错误分类。
 *
 * 只在 spawn 这一层替换 `runProcess`；`isFailedProcess` / `buildOpencodeEnv` 仍是真实
 * 实现，因此错误分类与 `PWD` 钉定走的是被测代码本身，不是测试自证。
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mock, test } from "node:test";

import { MOCK_EXPORTS_KEY } from "./helpers/mock-module.js";

/** 临时提示词文件名：`skill-creator-` + 12 位十六进制 + `.md`。 */
const TEMP_PROMPT_NAME_RE = /^skill-creator-[0-9a-f]{12}\.md$/;

/** 每次假 `runProcess` 的捕获记录。 */
const calls = [];
/** 当前用例的假子进程应答；由各用例覆盖。 */
let responder = () => ({});

/**
 * 构造一条聚合后的评测结果条目。
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

/**
 * 把结果列表包成一次评测输出（分数按实际通过情况统计）。
 *
 * @param {Record<string, unknown>[]} results 评测结果条目
 * @returns {Record<string, unknown>} 评测输出
 */
const evalOutput = (results) => {
  const passed = results.filter((r) => r.pass).length;
  return {
    skill_name: "demo-skill",
    description: "current description",
    results,
    warnings: [],
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      run_errors: results.reduce((acc, r) => acc + r.errors, 0),
      queries_with_errors: results.filter((r) => r.errors > 0).length,
    },
  };
};

/**
 * 构造一次 `improveDescription` 调用参数。
 *
 * @param {Record<string, unknown>} evalResults 评测输出
 * @param {Record<string, unknown>} overrides 需要覆盖的字段
 * @returns {Record<string, unknown>} 调用参数
 */
const improveOptions = (evalResults, overrides = {}) => ({
  skillName: "demo-skill",
  skillContent: "demo skill content",
  currentDescription: "old description",
  evalResults,
  history: [],
  model: undefined,
  projectRoot: "/tmp/instance-root",
  ...overrides,
});

// 用假 runProcess 替换进程边界，其余导出保持真实实现。
const realProcess = await import("../dist/lib/process.js");
mock.module("../dist/lib/process.js", {
  [MOCK_EXPORTS_KEY]: {
    ...realProcess,
    runProcess: async (command, opts) => {
      const fileIndex = command.indexOf("--file");
      const promptFile = fileIndex === -1 ? null : command[fileIndex + 1];
      const call = {
        command,
        cwd: opts.cwd,
        env: opts.env,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        promptFile,
        prompt: promptFile ? readFileSync(promptFile, "utf8") : null,
      };
      calls.push(call);

      const reply = responder(call) ?? {};
      if (reply.stdout) opts.onStdoutChunk(reply.stdout);
      return {
        exitCode: reply.exitCode ?? 0,
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        timedOut: reply.timedOut ?? false,
        aborted: reply.aborted ?? false,
      };
    },
  },
});

const { improveDescription } = await import("../dist/lib/improve-description.js");

test("组装提示词、临时文件落在系统临时目录并在结束后清理，返回解析后的描述", async () => {
  calls.length = 0;
  responder = () => ({
    stdout: `${JSON.stringify({
      type: "text",
      part: {
        text: '<new_description>\n  "Use this skill for demo tasks."\n</new_description>',
      },
    })}\n`,
  });

  const results = [
    evalResult("missed query", { should_trigger: true, pass: false }),
    evalResult("false query", { should_trigger: false, pass: false }),
    evalResult("ok query", { should_trigger: true, triggers: 3, pass: true }),
  ];
  const description = await improveDescription(
    improveOptions(evalOutput(results)),
  );

  assert.equal(description, "Use this skill for demo tasks.");
  assert.equal(calls.length, 1);
  const [call] = calls;

  assert.match(
    call.prompt,
    /<current_description>\n"old description"\n<\/current_description>/,
  );
  assert.match(call.prompt, /Current scores \(Train: 1\/3\):/);
  assert.match(call.prompt, /FAILED TO TRIGGER[\s\S]*missed query/);
  assert.match(call.prompt, /FALSE TRIGGERS[\s\S]*false query/);
  assert.match(
    call.prompt,
    /FAILURE DIAGNOSTICS:[\s\S]*\[false_negative\] missed query/,
  );
  assert.match(call.prompt, /demo skill content/);

  // 跳过条件：未指定 model 时不传 `--model`，尾随提示语用 `--` 隔开。
  assert.deepEqual(call.command.slice(0, 4), [
    "opencode",
    "run",
    "--format",
    "json",
  ]);
  assert.equal(call.command.includes("--model"), false);
  assert.equal(call.command.at(-2), "--");
  assert.equal(
    call.command.at(-1),
    "Process the attached file and follow its instructions.",
  );

  // 临时提示词落在系统临时目录，文件名带随机后缀。
  assert.equal(dirname(call.promptFile), tmpdir());
  assert.match(basename(call.promptFile), TEMP_PROMPT_NAME_RE);

  // 子进程的 cwd 与 PWD 都钉到调用方给的项目根。
  assert.equal(call.cwd, "/tmp/instance-root");
  assert.equal(call.env.PWD, "/tmp/instance-root");

  // finally 清理：调用结束后临时文件不在了。
  assert.equal(existsSync(call.promptFile), false);
});

test("全部通过时不出现失败段落，也不触发二次改写", async () => {
  calls.length = 0;
  responder = () => ({
    stdout: `${JSON.stringify({
      type: "text",
      part: { text: "<new_description>better description</new_description>" },
    })}\n`,
  });

  const results = [
    evalResult("ok one", { triggers: 3, pass: true }),
    evalResult("ok two", { triggers: 3, pass: true }),
  ];
  const description = await improveDescription(
    improveOptions(evalOutput(results)),
  );

  assert.equal(description, "better description");
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Current scores \(Train: 2\/2\):/);
  assert.equal(calls[0].prompt.includes("FAILED TO TRIGGER"), false);
  assert.equal(calls[0].prompt.includes("FALSE TRIGGERS"), false);
  assert.equal(calls[0].prompt.includes("FAILURE DIAGNOSTICS"), false);
});

test("描述超过 1024 字符时追加一次缩短请求，并采用改写结果", async () => {
  calls.length = 0;
  const oversize = "L".repeat(1025);
  let round = 0;
  responder = () => {
    round += 1;
    const text =
      round === 1
        ? `<new_description>${oversize}</new_description>`
        : "<new_description>short description</new_description>";
    return { stdout: `${JSON.stringify({ type: "text", part: { text } })}\n` };
  };

  const description = await improveDescription(
    improveOptions(evalOutput([evalResult("missed query")])),
  );

  assert.equal(description, "short description");
  assert.equal(calls.length, 2);
  // 两次调用都钉到同一个项目根。
  assert.equal(calls[1].cwd, "/tmp/instance-root");
  assert.match(
    calls[1].prompt,
    /at 1025 characters is over the 1024-character hard limit/,
  );
  assert.match(calls[1].prompt, new RegExp(`"${oversize}"`));
  // 两次调用的临时文件都被清理。
  assert.equal(existsSync(calls[0].promptFile), false);
  assert.equal(existsSync(calls[1].promptFile), false);
});

test("给了 logDir 就按迭代号写一份对话记录", async () => {
  calls.length = 0;
  responder = () => ({
    stdout: `${JSON.stringify({
      type: "text",
      part: { text: "<new_description>logged description</new_description>" },
    })}\n`,
  });

  const logRoot = mkdtempSync(join(tmpdir(), "improve-desc-log-"));
  try {
    const logDir = join(logRoot, "logs");
    const description = await improveDescription(
      improveOptions(evalOutput([evalResult("missed query")]), {
        logDir,
        iteration: 7,
      }),
    );

    assert.equal(description, "logged description");
    assert.deepEqual(readdirSync(logDir), ["improve_iter_7.json"]);

    const transcript = JSON.parse(
      readFileSync(join(logDir, "improve_iter_7.json"), "utf8"),
    );
    assert.equal(transcript.iteration, 7);
    assert.equal(transcript.parsed_description, "logged description");
    assert.equal(transcript.final_description, "logged description");
    assert.equal(transcript.char_count, "logged description".length);
    assert.equal(transcript.over_limit, false);
    assert.match(transcript.prompt, /missed query/);
  } finally {
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test("子进程非 0 退出时报错，临时文件仍被清理", async () => {
  calls.length = 0;
  responder = () => ({ exitCode: 1, stderr: "boom" });

  await assert.rejects(
    improveDescription(improveOptions(evalOutput([evalResult("missed query")]))),
    (error) => {
      assert.equal(error instanceof Error, true);
      // 用户侧只看到中文摘要；原始 stderr 不再进入 message（只在 SKILL_ZH_DEBUG=1 时输出）。
      assert.match(error.message, /opencode run 退出码 1/);
      assert.equal(error.message.includes("boom"), false);
      return true;
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(existsSync(calls[0].promptFile), false);
});

test("调用前已取消的 signal 直接抛 AbortError，不启动子进程", async () => {
  calls.length = 0;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    improveDescription(
      improveOptions(evalOutput([evalResult("missed query")]), {
        signal: controller.signal,
      }),
    ),
    (error) => {
      assert.equal(error.name, "AbortError");
      return true;
    },
  );

  assert.equal(calls.length, 0);
});
