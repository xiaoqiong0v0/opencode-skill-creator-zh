/**
 * `lib/review-server` 的浏览器启动行为（迁自上游 `test/browser-open.test.ts` 与
 * `test/browser-open-spawn.test.ts` 的非 mock 部分，基线 `d4383924`）。
 *
 * **测试卫生红线：本文件绝不真的打开浏览器。**
 *   - 进程级先把 `OPENCODE_SKILL_CREATOR_OPEN_BROWSER=0`，任何 `serveReview` 还显式传
 *     `openBrowser: false`；
 *   - 需要验证「默认会打开」的用例只注入 `openBrowserImpl` 假实现，观察它是否被调用，
 *     不触碰真实启动器；
 *   - 「平台启动命令」只断言 `browserOpenCommand` 构造出来的命令字符串与参数，不执行；
 *   - 真实 `spawn` 边界的用例放在 `lib-browser-open-spawn.test.js`（mock `node:child_process`）。
 *
 * 上游那条「清空 PATH 逼出 ENOENT」的用例没有移植：它的前提是启动器在 PATH 上找不到，
 * 但在 Windows 上 `cmd` 仍可能被解析到，从而真的弹出浏览器，违反上面这条红线；等价的
 * 「异步失败被接住」断言由 mock spawn 的用例覆盖。
 *
 * HTTP 服务一律 `port: 0`（随机空闲端口、只监听 127.0.0.1），并在 `finally` 里 `stop()`
 * 与清理临时目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  browserOpenCommand,
  browserOpenDisabledByEnv,
  serveReview,
} from "../dist/lib/review-server.js";

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
 * 造一个最小工作区（一次 run + 一个输出文件）与配套模板。
 *
 * @returns {{ root: string, workspace: string, templatePath: string }} 临时根、工作区与模板路径
 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "osc-browser-open-"));
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
 * 还原一个环境变量（`undefined` 表示原本没有设置）。
 *
 * @param {string} name 变量名
 * @param {string | undefined} previous 原值
 * @returns {void}
 */
function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test("browserOpenDisabledByEnv 只认 `0` 与 `false`", () => {
  assert.equal(browserOpenDisabledByEnv({ OPENCODE_SKILL_CREATOR_OPEN_BROWSER: "0" }), true);
  assert.equal(
    browserOpenDisabledByEnv({ OPENCODE_SKILL_CREATOR_OPEN_BROWSER: "false" }),
    true,
  );
  assert.equal(browserOpenDisabledByEnv({ OPENCODE_SKILL_CREATOR_OPEN_BROWSER: "1" }), false);
  assert.equal(browserOpenDisabledByEnv({}), false);
});

test("browserOpenCommand 按平台选择启动器与参数（只构造命令，不执行）", () => {
  const url = "http://localhost:3117";

  // macOS：`open <url>`。
  assert.deepEqual(browserOpenCommand(url, "darwin"), { command: "open", args: [url] });

  // Windows：`cmd /c start "" <url>`——空标题避免 URL 被当成窗口标题吃掉。
  assert.deepEqual(browserOpenCommand(url, "win32"), {
    command: "cmd",
    args: ["/c", "start", "", url],
  });

  // Linux 及其它 Unix 平台：`xdg-open <url>`。
  assert.deepEqual(browserOpenCommand(url, "linux"), { command: "xdg-open", args: [url] });
  assert.deepEqual(browserOpenCommand(url, "freebsd"), { command: "xdg-open", args: [url] });

  // URL 原样透传，绝不经过 shell 拼接。
  const tricky = "http://localhost:3117/review?a=1&b=2";
  assert.deepEqual(browserOpenCommand(tricky, "win32").args, ["/c", "start", "", tricky]);
  assert.deepEqual(browserOpenCommand(tricky, "darwin").args, [tricky]);
});

test("serveReview 在 openBrowser: false 时不调用启动器", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  let launched = 0;
  let stop;
  try {
    ({ stop } = await serveReview({
      workspace,
      port: 0,
      templatePath,
      openBrowser: false,
      openBrowserImpl: () => {
        launched += 1;
      },
    }));
    assert.equal(launched, 0);
  } finally {
    try {
      await stop?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("serveReview 在环境变量禁用时不调用启动器", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const previous = process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
  process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER = "0";
  let launched = 0;
  let stop;
  try {
    ({ stop } = await serveReview({
      workspace,
      port: 0,
      templatePath,
      openBrowserImpl: () => {
        launched += 1;
      },
    }));
    assert.equal(launched, 0);
  } finally {
    try {
      await stop?.();
    } finally {
      restoreEnv("OPENCODE_SKILL_CREATOR_OPEN_BROWSER", previous);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("serveReview 默认（openBrowser 为 true）把服务 URL 交给启动器", async () => {
  const { root, workspace, templatePath } = makeWorkspace();
  const previous = process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
  // 显式去掉禁用项，走「默认 true」这条路径；但启动器仍是注入的假实现，不会真的弹窗。
  delete process.env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
  const urls = [];
  let stop;
  try {
    const served = await serveReview({
      workspace,
      port: 0,
      templatePath,
      openBrowserImpl: (u) => {
        urls.push(u);
      },
    });
    stop = served.stop;
    assert.deepEqual(urls, [served.url]);
  } finally {
    try {
      await stop?.();
    } finally {
      restoreEnv("OPENCODE_SKILL_CREATOR_OPEN_BROWSER", previous);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
