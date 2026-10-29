/**
 * `help` 覆盖度与工具 description 长度（docs/SPEC.md R3 / R4）。
 *
 * 断言对象是编译产物 `dist/cli/help.js`：测真实实现，不在测试里另写一份文案。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HELP_TEXT, SUBCOMMANDS, TOOL_DESCRIPTION } from "../dist/cli/help.js";

/** 定稿的子命令与顺序（改动顺序即改 help 展示顺序，须同批确认）。 */
const EXPECTED_SUBCOMMANDS = ["help", "new", "validate", "eval", "optimize", "package", "install"];

/** 定稿的工具 description（33 字符）。 */
const EXPECTED_DESCRIPTION = "中文技能工坊：新建、校验、评测、优化并打包 OpenCode 技能";

/** 取 `help` 里「示例：」到「说明：」之间的内容，避免把「用法」占位写法当成示例。 */
const EXAMPLE_SECTION = HELP_TEXT.split("示例：")[1]?.split("说明：")[0] ?? "";

test("子命令表固定为 7 个且顺序稳定", () => {
  assert.deepEqual([...SUBCOMMANDS], EXPECTED_SUBCOMMANDS);
});

test("HELP_TEXT 覆盖全部 7 个子命令名", () => {
  for (const command of EXPECTED_SUBCOMMANDS) {
    assert.ok(HELP_TEXT.includes(command), `HELP_TEXT 缺少子命令名：${command}`);
  }
});

test("每个子命令至少有 1 条 skill_zh <cmd> 示例行", () => {
  const exampleCommands = new Set(
    EXAMPLE_SECTION.split("\n")
      .map((line) => /^\s*skill_zh\s+(\S+)/.exec(line)?.[1])
      .filter((command) => typeof command === "string"),
  );

  for (const command of EXPECTED_SUBCOMMANDS) {
    assert.ok(exampleCommands.has(command), `HELP_TEXT 示例缺少：skill_zh ${command}`);
  }
});

test("工具 description ≤ 60 字符且等于定稿值", () => {
  assert.equal(TOOL_DESCRIPTION, EXPECTED_DESCRIPTION);
  const length = [...TOOL_DESCRIPTION].length;
  assert.ok(length <= 60, `description 超长：${length} 字符`);
});
