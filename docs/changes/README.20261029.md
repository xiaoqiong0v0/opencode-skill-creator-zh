# README 变更说明（2026-10-29）

## 状态行从「仅文档层」改为「B0–B6 全部完成」（终审修复）

**原来**：开头状态行写「当前状态：**仅文档层**。`src/` 尚未创建，除 `skill/` 外没有可执行代码；本文所有行为描述均为**目标行为**」；「开发」一节写「上述命令在 **B1（工程骨架）** 落地后才可运行；当前仓库没有 `package.json`、`tsconfig.json`、`src/`」。

**现在**：状态行写「**B0–B6 全部完成**，7 个子命令均已可用，`npm test` 可跑（269 例，其中 1 例时延断言在满载时不稳定，待修）；**发布链路尚未做**：`npm publish` 由用户手动执行，包尚未发布」；「开发」一节改为「上述命令在本仓当前可直接运行（Node ≥ 22.3）」并同样注明那 1 例不稳定用例。

**为什么**：代码已全部落地（`src/`、`test/`、`package.json`、`tsconfig.json` 均在库内，B0–B6 见 ROADMAP），首页仍写「没有可执行代码、都是目标行为」，会让第一个打开仓库的人直接放弃；同时必须显式说明「发布链路未做」，否则读者会以为包已上线。

## 子命令表补第 7 行 `install`

**原来**：「skill_zh 子命令速查」表只有 6 行（`help` / `new` / `validate` / `eval` / `optimize` / `package`）。

**现在**：补第 7 行 `install`——把包内 `skill/` 装到用户级技能目录，`--dry-run` 只探测不写盘、`--force` 才覆盖本地改过的 `SKILL.md`、`--dir` 改目标根，示例 `skill_zh install [--dry-run] [--force] [--dir <目标根>]`。

**为什么**：SPEC R2/R3、`HELP_TEXT`、测试断言都是 7 个子命令，README 的速查表是用户看到的第二处清单（第一处是 `help`），少一项就等于把一个已实现的子命令藏起来。

## 发布产物口径补 `templates/`

**原来**：写「发布产物只有 `dist/`、`skill/`、`README.md` 三部分」。

**现在**：写「`dist/`、`skill/`、`templates/`、`README.md` 四部分（`templates/` 是 `new` 生成骨架的运行必需）」。

**为什么**：`package.json` 的 `files` 在 B3 已加入 `templates`（`new` 读模板，不入包则命令在安装后直接失败），README/SPEC/打包决策/ROADMAP 必须与真源一致。
