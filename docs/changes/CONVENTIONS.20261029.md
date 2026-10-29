# CONVENTIONS 变更说明（2026-10-29）

## `engines.node` 与测试 flag 写进 TypeScript 口径与测试规范

**原来**：`§2 TypeScript → JavaScript` 的表里只有编译器 / `module` / `strict` / `declaration` / `outDir` / `prebuild`，没有 `engines.node`；`§7 测试` 只写「用 Node 内置 `node --test`，不引第三方框架」。

**现在**：`§2` 表新增一行 `engines.node` = `>= 22.3`，理由写「`test` 用 `node --test --experimental-test-module-mocks`（22.3 才引入）；改测试脚本里的 Node flag 必须同批核对这个下限（见 SPEC R7-Node）」；`§7` 改为 `node --test --experimental-test-module-mocks` 并注明最低 Node 22.3。

**为什么**：规范里不写这条，下次换测试 flag 时就只改 `package.json` 的脚本、忘了 `engines`——正是本次回归的成因。
