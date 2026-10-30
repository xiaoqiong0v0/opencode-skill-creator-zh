/**
 * 兼容 Node 22 / 24 的 `node:test` 模块替身选项键。
 *
 * 背景（实测）：`mock.module(specifier, options)` 的导出键在两个版本上不一致——
 * - Node 24 认 `options.exports`，并把 `options.namedExports` 标为 deprecated；
 * - Node 22（含 22.23）只认 `options.namedExports`，传 `exports` 会被**静默忽略**，
 *   mock 变成空模块，表现为「The requested module '…' does not provide an export named '…'」。
 *
 * 用法：`mock.module("../dist/lib/x.js", { [MOCK_EXPORTS_KEY]: { … } })`。
 * 说明：这里只导出键、不封装调用，因为 `mock.module` 的说明符是**相对调用方模块**解析的，
 * 封进 helper 会把它解析成 `test/helpers/../dist/…` 而找不到模块。
 */

/** 当前 Node 主版本。 */
const MAJOR = Number.parseInt(process.versions.node.split(".")[0], 10);

/** 该版本认可的模块替身导出键。 */
export const MOCK_EXPORTS_KEY = MAJOR >= 24 ? "exports" : "namedExports";
