/**
 * `lib/review-server` 的 HTTP 行为（按上游 `review-server` 的对外契约补写；上游无同名
 * 测试文件，基线 `d4383924`）。
 *
 * **测试卫生红线：**
 *   - 每个用例都用 `port: 0` 起服务：只监听 `127.0.0.1` 的随机空闲端口，绝不占用固定
 *     端口，也绝不留残留监听；
 *   - 所有 `serveReview` 调用统一走 `withServer`，它在 `finally` 里 `stop()`；进程级还把
 *     `OPENCODE_SKILL_CREATOR_OPEN_BROWSER` 设为 `0`，并显式传 `openBrowser: false`，
 *     因此**任何路径（含失败路径）都不会打开浏览器**；
 *   - 临时工作区、模板与导出产物都在 `os.tmpdir()` 下自建，`finally` 里递归清理。
 *
 * 「端口被占用」用例只验证「报错而不是杀掉占用进程」，被占用的端口由本用例自己的第一个
 * 服务持有，不涉及任何外部进程。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { exportStaticReview, serveReview } from "../dist/lib/review-server.js";

/** 进程级关闭自动打开浏览器：任何用例都不得弹窗。 */
process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER = "0";

/** 内容最小、但含数据占位符的审阅页模板。 */
const TEMPLATE_HTML = [
  "<!DOCTYPE html>",
  "<html><body><div id=\"app\"></div><script>",
  "/*__EMBEDDED_DATA__*/",
  "</script></body></html>",
  "",
].join("\n");

/**
 * 造一个含两次 run 的工作区，并写出模板。
 *
 * 目录名 `demo-workspace` 用于验证技能名从工作区目录名推导（去掉 `-workspace` 后缀）。
 *
 * @returns {{ root: string, workspace: string, templatePath: string }} 临时根、工作区与模板路径
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "osc-review-server-"));
  const workspace = join(root, "demo-workspace");
  for (const [evalId, prompt, text] of [
    [0, "First prompt", "first output\n"],
    [1, "Second prompt", "second output\n"],
  ]) {
    const runDir = join(workspace, `eval-${evalId}`, "with_skill");
    mkdirSync(join(runDir, "outputs"), { recursive: true });
    writeFileSync(
      join(workspace, `eval-${evalId}`, "eval_metadata.json"),
      `${JSON.stringify({ eval_id: evalId, prompt })}\n`,
    );
    writeFileSync(join(runDir, "outputs", "result.txt"), text);
  }
  const templatePath = join(root, "viewer.html");
  writeFileSync(templatePath, TEMPLATE_HTML);
  return { root, workspace, templatePath };
}

/**
 * 起一个审阅服务并在回调结束后关闭。
 *
 * 强制 `port: 0` 与 `openBrowser: false`，保证随机端口、不弹浏览器、无残留监听。
 *
 * @param {Record<string, unknown>} options `serveReview` 的额外参数
 * @param {function(Object): Promise<*>} callback 接收服务描述的异步回调
 * @returns {Promise<*>} 回调的返回值
 */
async function withServer(options, callback) {
  const served = await serveReview({
    port: 0,
    openBrowser: false,
    ...options,
  });
  try {
    return await callback(served);
  } finally {
    await served.stop();
  }
}

/**
 * 把服务 URL 换成 127.0.0.1 形式再请求。
 *
 * 服务只监听 127.0.0.1，而 `localhost` 可能先解析到 ::1（Windows 常见），直接用会让
 * fetch 连接被拒。
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

/**
 * 用原始 `http.request` 发一段超长请求体（fetch 不方便精确控制字节数）。
 *
 * @param {string} url 目标 URL
 * @param {string} body 请求体
 * @returns {Promise<{ status: number, body: string }>} 状态码与响应体
 */
function postRaw(url, body) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("GET / 把 run、prompt 与输出内联进页面，技能名从工作区目录名推导", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await fetch(localUrl(served.url));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      const html = await response.text();
      assert.match(html, /const EMBEDDED_DATA = /);
      assert.match(html, /"skill_name":"demo"/);
      assert.match(html, /First prompt/);
      assert.match(html, /second output/);
      // 两次 run 都进来了。
      assert.equal(html.includes('"id":"eval-0-with_skill"'), true);
      assert.equal(html.includes('"id":"eval-1-with_skill"'), true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /index.html 与 GET / 返回同一页面", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const indexHtml = await (await fetch(localUrl(served.url, "/index.html"))).text();
      const rootHtml = await (await fetch(localUrl(served.url, "/"))).text();
      assert.equal(indexHtml, rootHtml);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET / 会内联上轮反馈、上轮输出与 benchmark", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const previousWorkspace = join(root, "previous-workspace");
  mkdirSync(join(previousWorkspace, "eval-0", "with_skill", "outputs"), { recursive: true });
  writeFileSync(
    join(previousWorkspace, "eval-0", "eval_metadata.json"),
    `${JSON.stringify({ eval_id: 0, prompt: "Old prompt" })}\n`,
  );
  writeFileSync(
    join(previousWorkspace, "eval-0", "with_skill", "outputs", "result.txt"),
    "old output\n",
  );
  writeFileSync(
    join(previousWorkspace, "feedback.json"),
    `${JSON.stringify({ reviews: [{ run_id: "eval-0-with_skill", feedback: "old feedback" }] })}\n`,
  );
  const benchmarkPath = join(root, "benchmark.json");
  writeFileSync(benchmarkPath, `${JSON.stringify({ pass_rate: 0.5 })}\n`);
  try {
    await withServer(
      { workspace, templatePath, previousWorkspace, benchmarkPath },
      async (served) => {
        const html = await (await fetch(localUrl(served.url))).text();
        assert.match(html, /old feedback/);
        assert.match(html, /old output/);
        assert.match(html, /"benchmark":\{"pass_rate":0.5\}/);
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/feedback 在没有反馈文件时返回 `{}`", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await fetch(localUrl(served.url, "/api/feedback"));
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(await response.text(), "{}");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/feedback 原样返回已有反馈文件", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const stored = `${JSON.stringify({ reviews: [{ run_id: "a", feedback: "keep" }] }, null, 2)}\n`;
  writeFileSync(join(workspace, "feedback.json"), stored);
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await fetch(localUrl(served.url, "/api/feedback"));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), stored);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/feedback 校验通过后落盘（两空格缩进 + 结尾换行）并返回 ok", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const payload = {
    reviews: [{ run_id: "eval-0-with_skill", feedback: "looks good", timestamp: "2026-01-01" }],
    status: "done",
  };
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await fetch(localUrl(served.url, "/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });

      const written = readFileSync(join(workspace, "feedback.json"), "utf-8");
      assert.equal(written, `${JSON.stringify(payload, null, 2)}\n`);

      // 同一个服务的 GET 能读回刚写入的内容。
      const readBack = await fetch(localUrl(served.url, "/api/feedback"));
      assert.deepEqual(JSON.parse(await readBack.text()), payload);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/feedback 对非法 JSON 返回 400 且不写文件", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await fetch(localUrl(served.url, "/api/feedback"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(typeof body.error, "string");
      assert.equal(existsSync(join(workspace, "feedback.json")), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/feedback 对结构不合法的请求体返回 400 与固定提示", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const invalidPayloads = [
    {},
    { reviews: "nope" },
    { reviews: [{}] },
    { reviews: [{ run_id: 1, feedback: "x" }] },
    { reviews: [{ run_id: "x" }] },
    { reviews: [{ run_id: "x", feedback: "y", timestamp: 1 }] },
    { reviews: [], status: 1 },
  ];
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      for (const payload of invalidPayloads) {
        const response = await fetch(localUrl(served.url, "/api/feedback"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        assert.equal(response.status, 400, JSON.stringify(payload));
        assert.deepEqual(await response.json(), {
          error: "Expected JSON object with a valid 'reviews' array",
        });
      }
      assert.equal(existsSync(join(workspace, "feedback.json")), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/feedback 对超过 1 MB 的请求体返回 413", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  // 略超上限（1_000_000 字节）即可触发；过量数据留在缓冲里，不会让响应丢失。
  const oversized = JSON.stringify({ reviews: [{ run_id: "x", feedback: "y".repeat(1_000_100) }] });
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await postRaw(localUrl(served.url, "/api/feedback"), oversized);
      assert.equal(response.status, 413);
      assert.match(response.body, /Payload too large/);
      assert.equal(existsSync(join(workspace, "feedback.json")), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知路径返回 404", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  try {
    await withServer({ workspace, templatePath }, async (served) => {
      const response = await fetch(localUrl(served.url, "/nope"));
      assert.equal(response.status, 404);
      assert.equal(await response.text(), "Not Found");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工作区不是目录时 serveReview 直接报错", async () => {
  const { root, templatePath } = makeWorkspace();
  const notADir = join(root, "not-a-dir");
  writeFileSync(notADir, "x");
  try {
    await assert.rejects(
      serveReview({ workspace: notADir, port: 0, templatePath, openBrowser: false }),
      /Workspace is not a directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("端口已被占用时报可操作的错误，且不杀占用进程", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  try {
    // 第一个服务自己持有端口；第二个服务用同一端口必然 EADDRINUSE。
    await withServer({ workspace, templatePath }, async (served) => {
      const busyPort = Number(new URL(served.url).port);
      await assert.rejects(
        serveReview({ workspace, port: busyPort, templatePath, openBrowser: false }),
        /is already in use by another process/,
      );
      // 占用者（第一个服务）仍在正常响应，说明没有被「腾端口」逻辑杀掉。
      const response = await fetch(localUrl(served.url));
      assert.equal(response.status, 200);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop() 之后端口被释放，可以立刻重新绑定", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const first = await serveReview({ workspace, port: 0, templatePath, openBrowser: false });
  const port = Number(new URL(first.url).port);
  try {
    await first.stop();
    // 端口已释放：同一端口再绑定应成功（不残留监听）。
    await withServer({ workspace, templatePath, port }, async (served) => {
      assert.equal(Number(new URL(served.url).port), port);
      const response = await fetch(localUrl(served.url));
      assert.equal(response.status, 200);
    });
  } finally {
    await first.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportStaticReview 写出独立 HTML；工作区没有 run 时报错", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const emptyWorkspace = join(root, "empty-workspace");
  mkdirSync(emptyWorkspace, { recursive: true });
  try {
    const outputPath = join(root, "out", "review.html");
    assert.equal(exportStaticReview({ workspace, outputPath, templatePath }), outputPath);
    const html = readFileSync(outputPath, "utf-8");
    assert.match(html, /const EMBEDDED_DATA = /);
    assert.match(html, /First prompt/);

    assert.throws(
      () =>
        exportStaticReview({
          workspace: emptyWorkspace,
          outputPath: join(root, "out2", "review.html"),
          templatePath,
        }),
      /No runs found/,
    );
    assert.equal(existsSync(join(root, "out2", "review.html")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
