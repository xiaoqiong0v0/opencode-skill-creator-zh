#!/usr/bin/env node
/**
 * 清空构建产物目录 `dist/`（由 `npm run build` 的 `prebuild` 自动执行）。
 *
 * 为什么需要：`tsc` 只覆盖写产物、不删除 `outDir` 里已不存在的文件——源文件改名或移位后
 * 旧产物会残留（如 `src/cli/help.ts` 改名后 `dist/cli/help.js` 仍在），既污染 `files` 打包结果，
 * 也让 `node --test` 可能跑到过期实现。
 *
 * 用法：`node scripts/clean-dist.mjs`（通常无需手动执行）。
 */

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录（本脚本位于 `scripts/` 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 构建产物目录的绝对路径。 */
const DIST_DIR = resolve(ROOT, "dist");

rmSync(DIST_DIR, { recursive: true, force: true });
console.log("[clean-dist] 已清空 dist/");
