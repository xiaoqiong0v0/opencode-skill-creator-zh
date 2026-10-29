/**
 * 入口形状与单点注册（docs/SPEC.md R1 / R7）。
 *
 * 两件事只能靠这里守：① `src/` 下工具注册调用点恰好 1 处；② 插件入口只有默认导出——
 * 旧版加载器会把具名导出逐个当插件工厂尝试，多一个都会导致重复加载。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as entryModule from "../dist/index.js";

/** 仓库根（本测试位于 `test/` 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 源码目录。 */
const SRC_DIR = resolve(ROOT, "src");

/** 工具注册调用的特征写法；计数用它，避免把 `tool:` 钩子键或文字说明算进去。 */
const TOOL_REGISTRATION = /\btool\(\{/g;

/**
 * 递归列出某目录下的所有 `.ts` 文件。
 *
 * 手写递归而不用 `readdirSync(..., { recursive: true })`：后者要求 Node ≥ 18.17，
 * 而 `engines` 只声明 `>= 18`。
 *
 * @param dir 起始目录
 * @returns 文件绝对路径列表（顺序稳定）
 */
function listTypeScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
      return entry.name.endsWith(".ts") ? [fullPath] : [];
    })
    .sort();
}

test("src/ 下工具注册调用点恰好 1 处", () => {
  const hits = listTypeScriptFiles(SRC_DIR).map((file) => ({
    file,
    count: readFileSync(file, "utf8").match(TOOL_REGISTRATION)?.length ?? 0,
  }));
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);

  assert.equal(total, 1, `工具注册调用点应恰好 1 处，实际 ${total} 处`);
  assert.deepEqual(
    hits.filter((hit) => hit.count > 0).map((hit) => relative(ROOT, hit.file).replaceAll("\\", "/")),
    ["src/tool.ts"],
  );
});

test("入口模块没有具名导出（只有 default）", () => {
  assert.deepEqual(Object.keys(entryModule), ["default"]);
});

test("默认导出形状为 { id, server }，且只注册 1 个工具", async () => {
  const plugin = entryModule.default;

  assert.equal(plugin.id, "opencode-skill-creator-zh");
  assert.equal(typeof plugin.server, "function");

  const hooks = await plugin.server({}, {});
  assert.deepEqual(Object.keys(hooks.tool), ["skill_zh"]);
});
