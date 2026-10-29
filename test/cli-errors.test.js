/**
 * 三段式错误与实际分发行为（docs/SPEC.md R2 / R5）。
 *
 * 覆盖：错误格式恰好三行、空参数与 `help` 等价、未知子命令、缺参（package / install）、参数解析。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dispatch } from "../dist/cli/dispatch.js";
import { formatError } from "../dist/cli/errors.js";
import { HELP_TEXT } from "../dist/cli/help.js";
import { parseArgs } from "../dist/cli/parse-args.js";

/** 缺参用例 → 期望的首行（7 个子命令均已接真实现）。 */
const MISSING_ARG_CASES = [
  { args: "package ./skills/demo", firstLine: "错误：缺少参数 --out <产物路径>" },
  { args: "package", firstLine: "错误：缺少参数 <技能目录>" },
  { args: "install --dir", firstLine: "错误：缺少参数 --dir <目标根>" },
];

/** 分发层要求的项目上下文；固定假目录，避免断言依赖真实 cwd。 */
const CTX = { directory: "D:/proj/demo", worktree: "D:/proj" };

test("formatError 输出恰好三行且以「可用：skill_zh help」结尾", () => {
  const lines = formatError("缺少参数 <技能目录>", "运行 skill_zh validate ./skills/my-skill").split("\n");

  assert.equal(lines.length, 3);
  assert.equal(lines[0], "错误：缺少参数 <技能目录>");
  assert.equal(lines[1], "改法：运行 skill_zh validate ./skills/my-skill");
  assert.equal(lines[2], "可用：skill_zh help");
});

test("空参数与 help 都返回完整帮助", async () => {
  assert.equal(await dispatch("", CTX), HELP_TEXT);
  assert.equal(await dispatch("help", CTX), HELP_TEXT);
  assert.equal(await dispatch("   ", CTX), HELP_TEXT);
});

test("未知子命令返回三段式并列出可用子命令", async () => {
  const lines = (await dispatch("validat ./skills/demo", CTX)).split("\n");

  assert.equal(lines.length, 3);
  assert.equal(lines[0], '错误：未知子命令 "validat"');
  assert.equal(lines[1], "改法：可用子命令：help / new / validate / eval / optimize / package / install");
  assert.equal(lines[2], "可用：skill_zh help");
});

test("缺参返回三段式且不外泄堆栈与模块路径", async () => {
  for (const { args, firstLine } of MISSING_ARG_CASES) {
    const output = await dispatch(args, CTX);
    const lines = output.split("\n");

    assert.equal(lines.length, 3, `${args}：输出不是三段式`);
    assert.equal(lines[0], firstLine, `${args}：首行不是错误说明`);
    assert.match(lines[1], /^改法：/, `${args}：次行不是改法`);
    assert.equal(lines[2], "可用：skill_zh help", `${args}：末行不是兜底入口`);
    assert.ok(!output.includes(".js"), `${args}：输出了模块路径`);
    assert.ok(!/\n\s+at\s/.test(output), `${args}：输出了堆栈`);
  }
});

test("parseArgs 支持 --flag value、--flag=value 与引号包住含空格参数", () => {
  const parsed = parseArgs(`eval "./skills/my skill" --runs 3 --workers=4 --strict`);

  assert.equal(parsed.command, "eval");
  assert.deepEqual(parsed.positionals, ["./skills/my skill"]);
  assert.deepEqual(parsed.flags, { runs: "3", workers: "4", strict: true });
});

test("parseArgs 对空串返回空子命令", () => {
  assert.deepEqual(parseArgs(""), { command: "", positionals: [], flags: {} });
});
