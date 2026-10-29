/**
 * 日志静默门禁（见 `src/lib/logger.ts` 的 `isLoggingDisabled`）。
 *
 * 本文件必须在 import 目标模块**之前**设置环境变量：静态 import 会被提升到模块体之前执行，
 * 所以这里用「先赋值、再 await import」的顺序，确保 dist 里的 logger 单例创建时就已静默。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.SKILL_ZH_LOG_DISABLE = "1";

const { createSkillZhLogger, isLoggingDisabled, log } = await import("../dist/lib/logger.js");

test("设置 SKILL_ZH_LOG_DISABLE=1 时判定为静默", () => {
  assert.equal(isLoggingDisabled(), true);
  assert.equal(process.env.SKILL_ZH_LOG_DISABLE, "1");
});

test("静默时即使显式给目录也不写日志文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-zh-log-"));
  try {
    const logger = createSkillZhLogger({ enabled: true, dir });
    logger.loaded();
    logger.info("不该落盘");
    logger.tool("skill_zh", { args: "help" });

    assert.deepEqual(readdirSync(dir), [], `静默状态下仍写了日志文件：${readdirSync(dir).join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("单例 log 的方法在静默下都是空实现（不抛异常）", () => {
  assert.doesNotThrow(() => {
    log.loaded();
    log.log("DEBUG", "dispatch help");
    log.info("info");
    log.warn("warn", "err");
    log.error("error", new Error("boom"));
    log.tool("skill_zh", { args: "" });
  });
});
