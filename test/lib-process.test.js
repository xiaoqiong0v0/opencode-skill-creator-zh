/**
 * `lib/process` 的子进程执行行为（迁自上游 `test/process.test.ts`）。
 *
 * 全部用例只用本地 `node -e` 子进程：不起网络服务、不开浏览器。每个用例自建的临时目录与
 * 子进程都在 `finally` 里清理。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  isFailedExitCode,
  isFailedProcess,
  runProcess,
} from "../dist/lib/process.js";

/**
 * 轮询等待子进程写出的就绪文件。
 *
 * @param {string} path 就绪文件路径
 * @param {number} [timeoutMs] 最长等待毫秒数
 * @returns {Promise<void>} 文件出现时兑现；超时则抛错
 */
async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(path)) throw new Error(`ready marker not written: ${path}`);
}

/**
 * 观察某个 PID 是否仍然存活（只观察，不改动进程状态）。
 *
 * @param {number} pid 进程号
 * @returns {boolean} 存活返回 `true`
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("isFailedExitCode 只把已知的非 0 退出码当失败", () => {
  assert.equal(isFailedExitCode(1), true);
  assert.equal(isFailedExitCode(0), false);
  assert.equal(isFailedExitCode(null), false);
});

test("isFailedProcess 把超时当失败，且不改 `null` 退出码的语义", () => {
  assert.equal(
    isFailedProcess({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
    true,
  );
  assert.equal(
    isFailedProcess({ exitCode: null, stdout: "", stderr: "", timedOut: false }),
    false,
  );
  assert.equal(
    isFailedProcess({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
    true,
  );
});

test("runProcess 报告超时，且不把 `null` 退出码当失败", async () => {
  const result = await runProcess(
    ["node", "-e", "setTimeout(() => undefined, 1000)"],
    { timeoutMs: 10 },
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(isFailedExitCode(result.exitCode), false);
});

test("runProcess 对忽略超时终止的子进程执行强制 kill", async () => {
  const startedAt = Date.now();
  const result = await runProcess(
    [
      "node",
      "-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => undefined, 2000)",
    ],
    { timeoutMs: 200, killGraceMs: 20 },
  );

  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runProcess 只保留 stderr 的尾部", async () => {
  const result = await runProcess(
    ["node", "-e", "process.stderr.write('abcde12345')"],
    { timeoutMs: 1_000, maxStderrChars: 5 },
  );

  assert.equal(result.stderr, "12345");
});

test("runProcess 在无法启动时 reject", async () => {
  await assert.rejects(
    runProcess(["definitely-not-a-real-command-opencode-skill-creator"], {
      timeoutMs: 1_000,
    }),
  );
});

test("runProcess 在子进程阻塞读 stdin 时不会挂住", async () => {
  // 回归用例：上游曾把 stdio 配置误写成 `stdout: "pipe", stderr: "pipe"`，
  // 使 stdin 变成没人写的管道。真实消费者 `opencode` 二进制在那种情况下会阻塞读
  // stdin 且不产出任何输出。这里用「显式读到 EOF」的子进程模拟：stdin 关闭时它立刻
  // 退出 0；stdin 是管道且没有写入方时它会一直挂到用例超时。
  const result = await runProcess(
    [
      "node",
      "-e",
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => { console.log('done'); process.exit(0) })",
    ],
    { timeoutMs: 3_000 },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.trim(), "done");
});

test("runProcess 可以按 stdout 解析结果提前结束而不超时", async () => {
  const startedAt = Date.now();
  const result = await runProcess(
    [
      "node",
      "-e",
      "process.stdout.write('triggered\\n'); setTimeout(() => process.stdout.write('late\\n'), 1000)",
    ],
    {
      timeoutMs: 3_000,
      onStdoutChunk(chunk) {
        return chunk.includes("triggered");
      },
    },
  );

  assert.equal(result.timedOut, false);
  assert.ok(result.stdout.includes("triggered"));
  assert.ok(Date.now() - startedAt < 1_000);
});

test("runProcess 在 signal abort 时杀掉子进程并报告 aborted", async () => {
  const controller = new AbortController();
  const readyDir = mkdtempSync(join(tmpdir(), "osc-abort-ready-"));
  const ready = join(readyDir, "ready");
  const pidFile = join(readyDir, "pid");
  let pending;
  let childPid = null;
  try {
    const startedAt = Date.now();
    pending = runProcess(
      [
        "node",
        "-e",
        `require("fs").writeFileSync(process.env.SKC_PID, String(process.pid)); require("fs").writeFileSync(process.env.SKC_READY, "1"); setTimeout(() => undefined, 30_000)`,
      ],
      {
        timeoutMs: 60_000,
        signal: controller.signal,
        env: { ...process.env, SKC_READY: ready, SKC_PID: pidFile },
      },
    );

    // 用「子进程已写出就绪标记」代替固定等待，abort 只发生在子进程确实起来之后。
    await waitForFile(ready);
    childPid = Number(readFileSync(pidFile, "utf-8"));

    controller.abort();
    const result = await pending;

    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    // 不能等满子进程 30 秒的生命周期。
    assert.ok(Date.now() - startedAt < 5_000);
    // 必须在清理之前观察：子进程是被 runProcess 的 abort 杀掉的，否则「不杀」的缺陷
    // 也会被下面的 finally 掩盖。
    assert.equal(pidAlive(childPid), false);
  } finally {
    // 即使就绪等待或断言失败也要收尾：先 drain 掉 pending，再只杀本用例记录的 PID，
    // 最后删掉就绪目录。
    controller.abort();
    if (pending) {
      try {
        await pending;
      } catch {
        /* 预期内的 abort 结果 */
      }
    }
    if (childPid !== null && pidAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* 已经退出 */
      }
    }
    rmSync(readyDir, { recursive: true, force: true });
  }
});

test("runProcess 在宽限期结束后强制 kill 忽略 abort 的子进程", async () => {
  const controller = new AbortController();
  const readyDir = mkdtempSync(join(tmpdir(), "osc-kill-ready-"));
  const ready = join(readyDir, "ready");
  const pidFile = join(readyDir, "pid");
  let pending;
  let childPid = null;
  try {
    const startedAt = Date.now();
    pending = runProcess(
      [
        "node",
        "-e",
        // SIGTERM 处理器必须在写 PID/就绪标记之前装好：就绪文件出现时，abort 发出的
        // SIGTERM 必定被忽略，真正结束子进程的只能是升级后的 SIGKILL。
        `process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.env.SKC_PID, String(process.pid)); require("fs").writeFileSync(process.env.SKC_READY, "1"); setTimeout(() => undefined, 30_000)`,
      ],
      {
        timeoutMs: 60_000,
        killGraceMs: 50,
        signal: controller.signal,
        env: { ...process.env, SKC_READY: ready, SKC_PID: pidFile },
      },
    );

    await waitForFile(ready);
    childPid = Number(readFileSync(pidFile, "utf-8"));

    controller.abort();
    const result = await pending;

    assert.equal(result.aborted, true);
    assert.ok(Date.now() - startedAt < 5_000);
    // 同上：清理之前观察，证明是 SIGKILL 升级结束的顽固子进程。
    assert.equal(pidAlive(childPid), false);
  } finally {
    controller.abort();
    if (pending) {
      try {
        await pending;
      } catch {
        /* 预期内的 abort 结果 */
      }
    }
    if (childPid !== null && pidAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* 已经退出 */
      }
    }
    rmSync(readyDir, { recursive: true, force: true });
  }
});

test("runProcess 在 signal 已 abort 时不启动子进程", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runProcess(["node", "-e", "process.exit(1)"], {
    timeoutMs: 1_000,
    signal: controller.signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
});
