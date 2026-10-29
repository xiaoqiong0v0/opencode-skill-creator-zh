/**
 * `review-server` 的 OS 启动边界（迁自上游 `test/browser-open-spawn.test.ts`，基线
 * `d4383924`）。
 *
 * 只 mock 操作系统边界 `node:child_process.spawn`：这样既能断言 `defaultOpenBrowser`
 * 真正交给 OS 的平台命令与参数，也能断言「异步 spawn 失败被接住」，而**不会真的打开
 * 用户浏览器**。mock 必须在 `review-server` 被导入之前装好，因此这里用动态 `import()`。
 *
 * 需要 `--experimental-test-module-mocks`（`npm test` 已带该参数）。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

/** 记录到的 spawn 调用。 */
const spawnCalls = [];

/** 假子进程队列（用于投递异步 'error' 事件）。 */
const pendingProcs = [];

mock.module("node:child_process", {
  exports: {
    spawn: (command, args) => {
      spawnCalls.push({ command, args });
      const proc = new EventEmitter();
      proc.unref = () => {};
      proc.kill = () => {};
      pendingProcs.push(proc);
      return proc;
    },
  },
});

const { browserOpenCommand, serveReview } = await import("../dist/lib/review-server.js");

/** 内容最小、但含数据占位符的审阅页模板。 */
const TEMPLATE_HTML = [
  "<!DOCTYPE html>",
  "<html><body><div id=\"app\"></div><script>",
  "/*__EMBEDDED_DATA__*/",
  "</script></body></html>",
  "",
].join("\n");

/**
 * 造一个最小工作区（一次 run + 一个输出文件）与配套模板。
 *
 * @returns {{ root: string, workspace: string, templatePath: string }} 临时根、工作区与模板路径
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "osc-browser-spawn-"));
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "eval-0", "with_skill", "outputs"), { recursive: true });
  writeFileSync(
    join(workspace, "eval-0", "eval_metadata.json"),
    `${JSON.stringify({ eval_id: 0, prompt: "Review" })}\n`,
  );
  writeFileSync(join(workspace, "eval-0", "with_skill", "outputs", "result.txt"), "ok\n");
  const templatePath = join(root, "viewer.html");
  writeFileSync(templatePath, TEMPLATE_HTML);
  return { root, workspace, templatePath };
}

/**
 * 把 `serveReview` 返回的 localhost URL 换成 127.0.0.1 形式再请求。
 *
 * 服务只监听 127.0.0.1，而 `localhost` 可能先解析到 ::1（Windows 常见），直接用会让
 * fetch 连接被拒；换成 127.0.0.1 只影响连接方式，不影响被验证的行为。
 *
 * @param {string} servedUrl `serveReview` 返回的 URL
 * @param {string} [path] 请求路径
 * @returns {string} 可直接请求的 URL
 */
function localUrl(servedUrl, path = "/") {
  const url = new URL(servedUrl);
  url.hostname = "127.0.0.1";
  url.pathname = path;
  return url.toString();
}

test("defaultOpenBrowser 用平台启动器 spawn，并接住异步 error", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const previousEnv = process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
  const warnings = [];
  const originalWarn = console.warn;
  let stop;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    delete process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
    spawnCalls.length = 0;
    pendingProcs.length = 0;

    const served = await serveReview({ workspace, port: 0, templatePath, openBrowser: true });
    stop = served.stop;

    // 真正的默认启动器跑过，并选择了本平台的命令、URL 原样透传。
    const expected = browserOpenCommand(served.url);
    assert.deepEqual(spawnCalls, [{ command: expected.command, args: expected.args }]);

    // 投递「启动器缺失」产生的异步 ENOENT。
    for (const proc of pendingProcs) {
      const error = new Error("spawn ENOENT");
      error.code = "ENOENT";
      proc.emit("error", error);
    }

    // 错误被接住：宿主仍存活，审阅服务仍能响应。
    const response = await fetch(localUrl(served.url));
    assert.equal(response.status, 200);
    assert.ok(warnings.some((message) => message.includes(served.url)));
  } finally {
    try {
      await stop?.();
    } finally {
      console.warn = originalWarn;
      if (previousEnv === undefined) delete process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
      else process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER = previousEnv;
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("禁用模式下在 OS 边界上一次启动器调用都没有", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const previousEnv = process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
  let stop;
  try {
    process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER = "0";
    spawnCalls.length = 0;

    // 即使按工具默认（省略 openBrowser ⇒ true），环境变量覆盖也必须在任何 spawn 之前短路。
    const served = await serveReview({ workspace, port: 0, templatePath });
    stop = served.stop;

    assert.deepEqual(spawnCalls, []);
  } finally {
    try {
      await stop?.();
    } finally {
      if (previousEnv === undefined) delete process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
      else process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER = previousEnv;
      rmSync(root, { recursive: true, force: true });
    }
  }
});
