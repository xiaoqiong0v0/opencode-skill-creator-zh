/**
 * 项目目录接入分发层（docs/SPEC.md R6.2-J2 / docs/tools.md 的「路径解析基准」）。
 *
 * 断言三件事：`ctx` 一路带到 handler、优先级为 `directory` → `worktree` → 三段式报错、
 * 相对路径基准不来自 `process.cwd()`（测试里给的都是与真实 cwd 无关的假目录）。
 *
 * `package` 在 B5 之前仍是占位 handler，恰好用它观察「ctx 是否原样送到 handler」；
 * `eval` / `optimize` 已接真实现，它们的取根口径由 `test/cli-eval.test.js` /
 * `test/cli-optimize.test.js` 用临时项目目录验证。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatch, resolveProjectDir } from "../dist/cli/dispatch.js";
import { HELP_TEXT } from "../dist/cli/help.js";
import { SKILL_ZH_TOOL } from "../dist/tool.js";

/** 固定上下文：目录名与真实 cwd 无关，一旦实现读了 `process.cwd()` 断言就会失败。 */
const CTX = { directory: "D:/proj/demo", worktree: "D:/proj" };

test("help 不读项目目录，ctx 为空也照常返回完整帮助", async () => {
  assert.equal(await dispatch("help", CTX), HELP_TEXT);
  assert.equal(await dispatch("", CTX), HELP_TEXT);
  assert.equal(await dispatch("help", { directory: "", worktree: "" }), HELP_TEXT);
});

test("占位子命令把 ctx 带到 handler：输出里能读到项目目录", async () => {
  const lines = (await dispatch("package ./skills/x", CTX)).split("\n");

  assert.equal(lines.length, 3);
  assert.equal(lines[0], "错误：子命令尚未实现");
  assert.ok(lines[1].includes(CTX.directory), `改法未带项目目录：${lines[1]}`);
  assert.equal(lines[2], "可用：skill_zh help");
});

test("目录优先级为 directory → worktree", async () => {
  assert.equal(resolveProjectDir(CTX), CTX.directory);
  assert.equal(resolveProjectDir({ directory: "", worktree: "D:/worktree" }), "D:/worktree");

  const output = await dispatch("package ./skills/x", { directory: "", worktree: "D:/worktree" });
  assert.ok(output.includes("D:/worktree"), `未回退到 worktree：${output}`);
});

test("directory 与 worktree 都为空 → 三段式错误，恰好三行", async () => {
  const lines = (await dispatch("package ./skills/x", { directory: "", worktree: "" })).split("\n");

  assert.equal(lines.length, 3);
  assert.equal(lines[0], "错误：拿不到当前项目目录");
  assert.equal(lines[1], "改法：在 opencode 会话内重试，或显式传绝对路径");
  assert.equal(lines[2], "可用：skill_zh help");
});

test("工具定义把 ToolContext.directory 透传到分发层", async () => {
  const output = await SKILL_ZH_TOOL.execute(
    { args: "package ./skills/x" },
    { directory: "D:/proj/another", worktree: "D:/proj" },
  );

  assert.ok(String(output).includes("D:/proj/another"), `未透传 context.directory：${output}`);
});
