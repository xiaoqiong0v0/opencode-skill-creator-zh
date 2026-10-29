/**
 * `lib/run-eval` 的端到端用例：用 PATH 上的假 `opencode` 跑真实子进程管线。
 *
 * 迁自上游 `.tmp/old/plugin/test/run-eval.test.ts`（基线 `d4383924`）里未迁入的 14 条
 * 端到端用例。假 `opencode` 由 `test/helpers/fake-opencode.mjs` 提供：只输出脚本化的
 * JSON 事件，不调用真实模型、不产生费用。
 *
 * 覆盖：触发判定（真实 v2 事件 / 跨块 / 无尾换行）、agent/model 传参、PWD 隔离、
 * 噪声忽略、非 0 退出与超时、触发即停、多跑次聚合、重复 query 独立、镜像内容、
 * 取消（预取消 / 运行中取消 / 忽略 SIGTERM 时升级 SIGKILL）与隔离根清理。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isAbortError, runEval } from "../dist/lib/run-eval.js";
import { createFakeOpencodeHarness, triggerLine, withFakeOpencode } from "./helpers/fake-opencode.mjs";

/** 捕获自 opencode v2.0.19 的真实 `tool_use` 事件（离线夹具）。 */
const CAPTURED_TOOL_USE_EVENT = {
  type: "tool_use",
  timestamp: 1790804495430,
  sessionID: "ses_fixture",
  part: {
    partID: "prt_fixture",
    sessionID: "ses_fixture",
    messageID: "msg_fixture",
    type: "tool",
    id: "call_fixture",
    tool: "read",
    state: {
      status: "completed",
      input: { path: "{skill}/SKILL.md" },
      output: "Read file data.txt, lines 1-1",
      title: "read",
    },
  },
};

/**
 * 在测试台上跑一次评测。
 *
 * @param {ReturnType<typeof createFakeOpencodeHarness>} harness 假 opencode 测试台
 * @param {Record<string, unknown>} scenario 输出脚本
 * @param {Record<string, unknown>} opts runEval 覆盖项
 * @returns {Promise<Record<string, any>>} 评测输出
 */
function runEvalWithScenario(harness, scenario, opts) {
  return withFakeOpencode(harness, async (writeScenario) => {
    writeScenario(scenario);
    return runEval({
      evalSet: opts.evalSet,
      skillName: "demo-skill",
      description: "A demo skill for testing.",
      numWorkers: opts.numWorkers ?? 2,
      timeout: opts.timeout ?? 10,
      projectRoot: harness.projectRoot,
      runsPerQuery: opts.runsPerQuery ?? 1,
      model: opts.model,
      agent: opts.agent,
      signal: opts.signal,
      shadowGuard: opts.shadowGuard,
      skillEnumerator: opts.skillEnumerator,
    });
  });
}

/**
 * 等待某个文件出现（子进程启动后写出的观测文件）。
 *
 * @param {string} path 等待的文件
 * @param {number} timeoutMs 最长等待毫秒数
 * @returns {Promise<void>}
 */
async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 判断进程是否仍存活。
 *
 * @param {number} pid 进程 id
 * @returns {boolean} 存活为 true
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("runEval 从真实 v2 tool_use 事件判定触发", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      {
        lines: [
          JSON.stringify({ type: "step_start" }),
          JSON.stringify(CAPTURED_TOOL_USE_EVENT),
        ],
        exitCode: 0,
      },
      { evalSet: [{ query: "trigger me", should_trigger: true }] },
    );

    assert.equal(output.summary.total, 1);
    assert.equal(output.results[0].triggers, 1);
    assert.equal(output.results[0].trigger_rate, 1);
    assert.equal(output.results[0].pass, true);
  } finally {
    harness.cleanup();
  }
});

test("runEval 在流被切成小块时仍判定触发", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      { lines: [JSON.stringify(CAPTURED_TOOL_USE_EVENT)], chunkSize: 7, exitCode: 0 },
      { evalSet: [{ query: "chunked", should_trigger: true }] },
    );

    assert.equal(output.results[0].triggers, 1);
    assert.equal(output.results[0].errors, 0);
  } finally {
    harness.cleanup();
  }
});

test("runEval 在最后一行没有尾换行时仍判定触发", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      { lines: [JSON.stringify(CAPTURED_TOOL_USE_EVENT)], noFinalNewline: true, exitCode: 0 },
      { evalSet: [{ query: "final buffer", should_trigger: true }] },
    );

    assert.equal(output.results[0].triggers, 1);
  } finally {
    harness.cleanup();
  }
});

test("runEval 传 agent/model，并把子进程 PWD 钉到隔离根", async () => {
  const harness = createFakeOpencodeHarness();
  const argvFile = join(harness.root, "argv.json");
  const envFile = join(harness.root, "env.json");
  try {
    await runEvalWithScenario(
      harness,
      { lines: [triggerLine("read")], argvFile, envFile, exitCode: 0 },
      {
        evalSet: [{ query: "flags", should_trigger: true }],
        numWorkers: 1,
        agent: "custom-agent",
        model: "ollama-cloud/deepseek-v4.1-flash",
      },
    );

    const argv = JSON.parse(readFileSync(argvFile, "utf-8"));
    assert.deepEqual(argv, [
      "run",
      "--format",
      "json",
      "--agent",
      "custom-agent",
      "--model",
      "ollama-cloud/deepseek-v4.1-flash",
      "flags",
    ]);

    const env = JSON.parse(readFileSync(envFile, "utf-8"));
    assert.equal(env.pwd, env.cwd);
    assert.equal(env.cwd.startsWith(realpathSync(tmpdir())), true);
    assert.notEqual(env.cwd, realpathSync(harness.projectRoot));
  } finally {
    harness.cleanup();
  }
});

test("runEval 忽略非 JSON 噪声与无关工具", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      {
        lines: [
          "not json at all",
          "{broken",
          JSON.stringify({ type: "tool_use", part: { tool: "bash", input: { command: "ls" } } }),
          JSON.stringify({ type: "tool_use", part: { tool: "read", input: { path: "/elsewhere" } } }),
        ],
        exitCode: 0,
      },
      { evalSet: [{ query: "should not trigger", should_trigger: false }] },
    );

    assert.equal(output.results[0].triggers, 0);
    assert.equal(output.results[0].pass, true);
    assert.equal(output.summary.run_errors, 0);
  } finally {
    harness.cleanup();
  }
});

test("runEval 把非 0 退出记成错误并聚合汇总", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      { lines: [], exitCode: 3 },
      { evalSet: [{ query: "will error", should_trigger: true }] },
    );

    assert.equal(output.results[0].errors, 1);
    assert.equal(output.results[0].pass, false);
    assert.equal(output.summary.run_errors, 1);
    assert.equal(output.summary.queries_with_errors, 1);
    assert.equal(output.summary.failed, 1);
  } finally {
    harness.cleanup();
  }
});

test("runEval 把超时记成错误而不是「未触发」", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      { lines: [], sleepMs: 5_000, exitCode: 0 },
      { evalSet: [{ query: "slow", should_trigger: true }], timeout: 1 },
    );

    assert.equal(output.results[0].errors, 1);
    assert.equal(output.summary.run_errors, 1);
  } finally {
    harness.cleanup();
  }
});

test("runEval 一旦看到触发就提前结束该条运行", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const started = Date.now();
    const output = await runEvalWithScenario(
      harness,
      { lines: [triggerLine("skill")], sleepMs: 5_000, exitCode: 0 },
      { evalSet: [{ query: "early stop", should_trigger: true }], timeout: 30 },
    );
    const elapsed = Date.now() - started;

    assert.equal(output.results[0].triggers, 1);
    assert.equal(output.results[0].errors, 0);
    assert.ok(elapsed < 4_000, `提前结束失效：耗时 ${elapsed}ms`);
  } finally {
    harness.cleanup();
  }
});

test("runEval 聚合多跑次的触发率与阈值", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      { lines: [triggerLine("read")], exitCode: 0 },
      {
        evalSet: [
          { query: "positive", should_trigger: true },
          { query: "negative", should_trigger: false },
        ],
        runsPerQuery: 2,
      },
    );

    const positive = output.results.find((r) => r.query === "positive");
    const negative = output.results.find((r) => r.query === "negative");

    assert.equal(positive.triggers, 2);
    assert.equal(positive.runs, 2);
    assert.equal(positive.pass, true);
    assert.equal(negative.triggers, 2);
    assert.equal(negative.pass, false);
    assert.equal(output.summary.total, 2);
    assert.equal(output.summary.passed, 1);
    assert.equal(output.summary.failed, 1);
  } finally {
    harness.cleanup();
  }
});

test("runEval 让重复 query 保持为两条独立结果（按评测集顺序）", async () => {
  const harness = createFakeOpencodeHarness();
  try {
    const output = await runEvalWithScenario(
      harness,
      { lines: [triggerLine("read")], exitCode: 0 },
      {
        evalSet: [
          { query: "duplicate query", should_trigger: true },
          { query: "duplicate query", should_trigger: false },
        ],
        runsPerQuery: 1,
        numWorkers: 2,
      },
    );

    assert.equal(output.results.length, 2);
    assert.deepEqual(output.results.map((r) => r.query), ["duplicate query", "duplicate query"]);
    assert.equal(output.results[0].should_trigger, true);
    assert.equal(output.results[0].pass, true);
    assert.equal(output.results[1].should_trigger, false);
    assert.equal(output.results[1].pass, false);
    assert.equal(output.summary.total, 2);
    assert.equal(output.summary.passed, 1);
    assert.equal(output.summary.failed, 1);
  } finally {
    harness.cleanup();
  }
});

test("runEval 子进程根带根配置、其引用文件与 .opencode 配置，被测技能被排除", async () => {
  const harness = createFakeOpencodeHarness();
  const envFile = join(harness.root, "layout.json");
  try {
    writeFileSync(
      join(harness.projectRoot, "opencode.jsonc"),
      JSON.stringify({ instructions: ["./local-rules.md"] }),
    );
    writeFileSync(join(harness.projectRoot, "local-rules.md"), "project local rules\n");
    mkdirSync(join(harness.projectRoot, ".opencode", "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(harness.projectRoot, ".opencode", "opencode.json"), "{}\n");

    await runEvalWithScenario(
      harness,
      { lines: [triggerLine("read")], envFile, exitCode: 0 },
      { evalSet: [{ query: "layout", should_trigger: true }], numWorkers: 1 },
    );

    const layout = JSON.parse(readFileSync(envFile, "utf-8"));
    assert.equal(layout.pwd, layout.cwd);
    assert.deepEqual(layout.rootConfigs, ["opencode.jsonc"]);
    assert.deepEqual(layout.instructionFiles, ["local-rules.md"]);
    assert.equal(layout.instructionContent, "project local rules\n");
    assert.equal(layout.testedSkillPresent, false);
  } finally {
    harness.cleanup();
  }
});

test("runEval 取消时抛 AbortError、停掉排队任务、杀掉子进程并清理隔离根", async () => {
  const harness = createFakeOpencodeHarness();
  const startLog = join(harness.root, "starts.log");
  const controller = new AbortController();
  let pending;
  try {
    pending = runEvalWithScenario(
      harness,
      { lines: [], sleepMs: 30_000, startLog, exitCode: 0 },
      {
        evalSet: [
          { query: "job-a", should_trigger: true },
          { query: "job-b", should_trigger: true },
          { query: "job-c", should_trigger: true },
        ],
        numWorkers: 1,
        timeout: 60,
        signal: controller.signal,
      },
    );

    // startLog 会记录同名技能枚举（cwd = 项目根）与本轮评测（cwd = 隔离根）两类进程；
    // 只看评测子进程，并等它真正启动（枚举进程可能先写日志）。
    const starts = () =>
      existsSync(startLog)
        ? readFileSync(startLog, "utf-8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((entry) => entry.cwd !== realpathSync(harness.projectRoot))
        : [];
    const deadline = Date.now() + 5_000;
    while (starts().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(starts().length > 0, "评测子进程未启动");
    const first = starts()[0];

    const startedAt = Date.now();
    controller.abort();

    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    assert.equal(isAbortError(caught), true);
    assert.ok(Date.now() - startedAt < 5_000);

    assert.equal(starts().length, 1);
    assert.equal(isAlive(first.pid), false);
    for (const entry of starts()) {
      assert.equal(existsSync(entry.cwd), false, `隔离根未清理：${entry.cwd}`);
    }
  } finally {
    controller.abort();
    try {
      await pending;
    } catch {
      /* 预期以 AbortError 结束 */
    }
    harness.cleanup();
  }
});

test("runEval 对已取消的 signal 不启动任何子进程", async () => {
  const harness = createFakeOpencodeHarness();
  const startLog = join(harness.root, "starts.log");
  const controller = new AbortController();
  controller.abort();
  let pending;
  try {
    pending = runEvalWithScenario(
      harness,
      { lines: [triggerLine("read")], startLog, exitCode: 0 },
      { evalSet: [{ query: "never", should_trigger: true }], signal: controller.signal },
    );

    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    assert.equal(isAbortError(caught), true);
    assert.equal(existsSync(startLog), false);
  } finally {
    controller.abort();
    try {
      await pending;
    } catch {
      /* 预期 */
    }
    harness.cleanup();
  }
});

test("runEval 在宽限期后升级 SIGKILL 杀掉忽略 SIGTERM 的子进程", async () => {
  const harness = createFakeOpencodeHarness();
  const startLog = join(harness.root, "starts.log");
  const controller = new AbortController();
  let pending;
  try {
    pending = runEvalWithScenario(
      harness,
      { lines: [], sleepMs: 30_000, ignoreSigterm: true, startLog, exitCode: 0 },
      {
        evalSet: [{ query: "stubborn", should_trigger: true }],
        numWorkers: 1,
        timeout: 60,
        signal: controller.signal,
      },
    );

    await waitForFile(startLog);
    const first = JSON.parse(readFileSync(startLog, "utf-8").trim().split("\n")[0]);

    const startedAt = Date.now();
    controller.abort();

    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    assert.equal(isAbortError(caught), true);
    assert.ok(Date.now() - startedAt < 5_000);
    assert.equal(isAlive(first.pid), false);
  } finally {
    controller.abort();
    try {
      await pending;
    } catch {
      /* 预期 */
    }
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// J4：evalRoot 清理（预取消 / 错误路径 / 清理失败不掩盖原始错误）
// ---------------------------------------------------------------------------

test("J4 预取消不创建隔离根（mkdtempSync 未被调用）", async () => {
  const harness = createFakeOpencodeHarness();
  const originalMkdtemp = fs.mkdtempSync;
  let created = 0;
  const controller = new AbortController();
  controller.abort();
  try {
    fs.mkdtempSync = (...args) => {
      created += 1;
      return originalMkdtemp(...args);
    };
    syncBuiltinESMExports();

    let caught;
    try {
      await runEvalWithScenario(
        harness,
        { lines: [triggerLine("read")], exitCode: 0 },
        { evalSet: [{ query: "never", should_trigger: true }], signal: controller.signal },
      );
    } catch (error) {
      caught = error;
    }
    assert.equal(isAbortError(caught), true);
    assert.equal(created, 0, "预取消仍创建了隔离根");
  } finally {
    fs.mkdtempSync = originalMkdtemp;
    syncBuiltinESMExports();
    harness.cleanup();
  }
});

test("J4 非 0 退出与超时路径结束后隔离根都不存在", async () => {
  const harness = createFakeOpencodeHarness();
  const originalMkdtemp = fs.mkdtempSync;
  const created = [];
  try {
    fs.mkdtempSync = (...args) => {
      const path = originalMkdtemp(...args);
      created.push(path);
      return path;
    };
    syncBuiltinESMExports();

    const errored = await runEvalWithScenario(
      harness,
      { lines: [], exitCode: 3 },
      { evalSet: [{ query: "error", should_trigger: true }], numWorkers: 1 },
    );
    assert.equal(errored.summary.run_errors, 1);

    const timedOut = await runEvalWithScenario(
      harness,
      { lines: [], sleepMs: 3_000, exitCode: 0 },
      { evalSet: [{ query: "slow", should_trigger: true }], timeout: 1, numWorkers: 1 },
    );
    assert.equal(timedOut.summary.run_errors, 1);

    assert.ok(created.length >= 2, "未观察到隔离根创建");
    for (const path of created) {
      assert.equal(existsSync(path), false, `隔离根未清理：${path}`);
    }
  } finally {
    fs.mkdtempSync = originalMkdtemp;
    syncBuiltinESMExports();
    harness.cleanup();
  }
});

test("J4 清理失败不掩盖原始错误（原始错误仍可见）", async () => {
  const harness = createFakeOpencodeHarness();
  const originalRm = fs.rmSync;
  const originalError = console.error;
  const logged = [];
  try {
    fs.rmSync = (target, ...rest) => {
      if (String(target).includes("opencode-skill-eval-")) {
        throw new Error("EBUSY: simulated cleanup failure");
      }
      return originalRm(target, ...rest);
    };
    syncBuiltinESMExports();
    console.error = (...args) => logged.push(args.join(" "));

    const output = await runEvalWithScenario(
      harness,
      { lines: [], exitCode: 3 },
      { evalSet: [{ query: "error", should_trigger: true }], numWorkers: 1 },
    );

    assert.equal(output.summary.run_errors, 1);
    assert.ok(
      logged.some((line) => line.includes("opencode run exited 3")),
      "清理失败掩盖了原始错误",
    );
  } finally {
    console.error = originalError;
    fs.rmSync = originalRm;
    syncBuiltinESMExports();
    harness.cleanup();
  }
});
