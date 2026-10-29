/**
 * `lib/debug` 的调试输出与凭据掩码行为（新写）。
 *
 * 只断言 stderr 文案与掩码结果，不读写项目文件、不依赖真实 HOME。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { logErrorSummary, maskSecrets } from "../dist/lib/debug.js";

/**
 * 捕获回调期间写到 stderr（`console.error`）的行。
 *
 * @param {(lines: string[]) => unknown} body 用例主体
 * @returns {unknown} 主体返回值
 */
const captureStderr = (body) => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map((arg) => String(arg)).join(" "));
  try {
    body(lines);
  } finally {
    console.error = original;
  }
  return lines;
};

/**
 * 在指定调试开关下执行并恢复环境变量。
 *
 * @param {string | undefined} value `SKILL_ZH_DEBUG` 取值
 * @param {() => unknown} body 用例主体
 * @returns {unknown} 主体返回值
 */
const withDebugEnv = (value, body) => {
  const previous = process.env.SKILL_ZH_DEBUG;
  if (value === undefined) delete process.env.SKILL_ZH_DEBUG;
  else process.env.SKILL_ZH_DEBUG = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.SKILL_ZH_DEBUG;
    else process.env.SKILL_ZH_DEBUG = previous;
  }
};

test("maskSecrets 掩码 sk-、Bearer、长 token、key=value 与私钥块", () => {
  const masked = maskSecrets(
    [
      "key sk-abcdefghijklmnop",
      "Authorization: Bearer abcdefgh.ijklmnop",
      "token=abcdefghijklmn",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
    ].join("\n"),
  );

  assert.ok(!masked.includes("sk-abcdefghijklmnop"), masked);
  assert.ok(masked.includes("sk-[已掩码]"), masked);
  assert.ok(!masked.includes("Bearer abcdefgh"), masked);
  // 整段 token（含分隔符后的部分）都必须消失，不能只掩掉前半截。
  assert.ok(!masked.includes("abcdefgh.ijklmnop"), masked);
  // 头部方案名可能先被 key=value 规则吞掉；只要求原 token 不再出现且有掩码占位。
  assert.ok(masked.includes("[已掩码]"), masked);
  assert.ok(!masked.includes("abcdefghijklmn"), masked);
  assert.ok(masked.includes("token=[已掩码]"), masked);
  assert.ok(!masked.includes("a1b2c3d4e5f6"), masked);
  assert.ok(masked.includes("[已掩码长串]"), masked);
  assert.ok(masked.includes("[私钥已掩码]"), masked);
});

test("logErrorSummary 默认只输出中文摘要，不输出原始异常", () => {
  withDebugEnv(undefined, () => {
    const lines = captureStderr(() =>
      logErrorSummary("警告：有 query 运行失败", new Error("stderr: sk-secret123456")),
    );
    assert.deepEqual(lines, ["警告：有 query 运行失败"]);
  });
});

test("logErrorSummary 在 SKILL_ZH_DEBUG=1 时输出掩码后的细节", () => {
  withDebugEnv("1", () => {
    const lines = captureStderr(() =>
      logErrorSummary("警告：有 query 运行失败", new Error("stderr: sk-secret123456")),
    );
    assert.equal(lines.length >= 2, true, lines.join("\n"));
    assert.equal(lines[0], "警告：有 query 运行失败");
    const detail = lines.slice(1).join("\n");
    assert.ok(detail.includes("[skill_zh:debug]"), detail);
    assert.ok(!detail.includes("sk-secret123456"), detail);
    assert.ok(detail.includes("sk-[已掩码]"), detail);
  });
});
