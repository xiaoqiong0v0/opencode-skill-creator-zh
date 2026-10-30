# 变更说明：测试脚本收窄为 `test/*.test.js`、mock 兼容 Node 22/24、用例数口径 275 → 274

日期：2026-10-30

**原来**：`package.json` 的 `test` 是 `node --test --experimental-test-module-mocks`（不传 glob，靠 Node 默认发现）；测试里的模块替身统一写 `mock.module(spec, { exports: { … } })`；README / ROADMAP 报「275 例全绿」。

**现在**：

1. `test` = `node --test --experimental-test-module-mocks "test/*.test.js"` —— 显式限定只跑 `*.test.js`。
2. 新增 `test/helpers/mock-module.js` 导出 `MOCK_EXPORTS_KEY`（Node ≥ 24 用 `exports`，22 用 `namedExports`），4 个测试文件共 10 处 `mock.module` 改用它。
3. 用例数口径改为 **274**（README 状态行、开发节、CONVENTIONS 同步）。

**为什么**：

- 首次推 GitHub 后 CI（ubuntu-latest + Node 22.x）4 例失败，报「The requested module 'node:child_process' / './process.js' / './run-eval.js' does not provide an export named …」。本机 Node 24 全绿，属**只在声明的最低版本上暴露**的缺陷：Node 22 只认 `options.namedExports`，写 `options.exports` 会被**静默忽略**，mock 变成空模块。已在本地用 `npx node@22`（22.23.4）复现并修复，两种版本各跑一遍全绿。
- 274 与旧 275 的差额来自默认发现规则：Node 会把 `test/**` 下所有 `.js` 当成用例文件，`test/helpers/fake-opencode.mjs` 因此被计入 1 条「无断言用例」。改成显式 glob 后总数 = 真实用例数，避免口径虚高。
- 修复的**可失败性**已验证：把其中一处改回 `exports:`，Node 22 上立刻 1 例失败（`buildOpencodeEnv` 缺失），还原后全绿。
