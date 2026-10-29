/**
 * 项目目录接入分发层（docs/SPEC.md R6.2-J2 / docs/tools.md 的「路径解析基准」）。
 *
 * 断言三件事：`ctx` 一路带到 handler、优先级为 `directory` → `worktree` → 三段式报错、
 * 相对路径基准不来自 `process.cwd()`（测试里给的都是与真实 cwd 无关的假目录）。
 *
 * 用 `install --dry-run --dir ./skills` 观察「ctx 是否原样送到 handler」：目标根按项目目录解析，
 * 且 dry-run 不写盘。`eval` / `optimize` 的取根口径由各自测试用临时项目目录验证。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dispatch, resolveProjectDir } from "../dist/cli/dispatch.js";
import { HELP_TEXT } from "../dist/cli/help.js";
import { SKILL_ZH_TOOL } from "../dist/tool.js";

/** 固定上下文：目录名与真实 cwd 无关，一旦实现读了 `process.cwd()` 断言就会失败。 */
const CTX = { directory: "D:/proj/demo", worktree: "D:/proj" };

/**
 * 在临时 HOME 里执行用例：避免 dry-run 读到真实配置与外部技能目录。
 *
 * @param {(root: string) => Promise<unknown>} fn 用例体
 * @returns 用例体返回值
 */
async function withTempHome(fn) {
  const root = mkdtempSync(join(tmpdir(), "osc-dispatch-ctx-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  try {
    return await fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
}

test("help 不读项目目录，ctx 为空也照常返回完整帮助", async () => {
  assert.equal(await dispatch("help", CTX), HELP_TEXT);
  assert.equal(await dispatch("", CTX), HELP_TEXT);
  assert.equal(await dispatch("help", { directory: "", worktree: "" }), HELP_TEXT);
});

test("子命令把 ctx 带到 handler：目标路径按项目目录解析", async () => {
  await withTempHome(async () => {
    const output = await dispatch("install --dry-run --dir ./skills", CTX);
    assert.ok(output.includes(`${CTX.directory}/skills`), `目标路径未按项目目录解析：${output}`);
  });
});

test("目录优先级为 directory → worktree", async () => {
  await withTempHome(async () => {
    assert.equal(resolveProjectDir(CTX), CTX.directory);
    assert.equal(resolveProjectDir({ directory: "", worktree: "D:/worktree" }), "D:/worktree");

    const output = await dispatch("install --dry-run --dir ./skills", { directory: "", worktree: "D:/worktree" });
    assert.ok(output.includes("D:/worktree/skills"), `未回退到 worktree：${output}`);
  });
});

test("directory 与 worktree 都为空 → 三段式错误，恰好三行", async () => {
  await withTempHome(async () => {
    const lines = (await dispatch("install --dry-run --dir ./skills", { directory: "", worktree: "" })).split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：拿不到当前项目目录");
    assert.equal(lines[1], "改法：在 opencode 会话内重试，或显式传绝对路径");
    assert.equal(lines[2], "可用：skill_zh help");
  });
});

test("工具定义把 ToolContext.directory 透传到分发层", async () => {
  await withTempHome(async () => {
    const output = await SKILL_ZH_TOOL.execute(
      { args: "install --dry-run --dir ./skills" },
      { directory: "D:/proj/another", worktree: "D:/proj" },
    );

    assert.ok(String(output).includes("D:/proj/another/skills"), `未透传 context.directory：${output}`);
  });
});
