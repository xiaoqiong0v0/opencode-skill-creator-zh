# 变更说明：状态行口径（发布链路未做 → CI 已补、npm 发布未做）

日期：2026-10-30

**原来**：`README.md`、`docs/ROADMAP.md`、`docs/SPEC.md`、`docs/installation.md`、`docs/README.md` 的状态行统一写「**发布链路尚未做**：`npm publish` 由用户手动执行」。

**现在**：改为「**CI 已补**（`.github/workflows/ci.yml`：push / PR 跑 `npm run typecheck` + `npm test` + `npm pack --dry-run`）；**npm 发布尚未做**：`npm publish` 由用户手动执行」。

**为什么**：同日新建 `.github/workflows/ci.yml` 并随首次推送生效，「发布链路未做」已不再成立；但发布流水线（tag 触发 + `NPM_TOKEN`）与 `npm publish` 仍未做，所以只把口径拆成两段，不整体改成「已完成」。落点：同批改动 5 处状态行，改动原因与涉及文件见本节。

---

## 2026-10-30 追加：新增独立 shell 入口 `skill-zh`

**原来**：README 的入口只有 OpenCode 工具 `skill_zh`，状态行为「287 例全绿」，安装与子命令速查都不提 shell。

**现在**：状态行改为「287 例全绿」并点名 bin；「单工具理念」补「终端等价」一行；安装一节新增「独立终端：`skill-zh`（bin）」用法（`cd` 到项目后 `skill-zh eval … --runs 3 --workers 4`）；开发一节补 `node dist/cli/main.js help`。

**为什么**：bin 是本次交付的新官方入口，README 是用户第一落点，必须能直接看到「长评测放独立终端跑」与测试数量变化。

**2026-10-30 复核收口**：用例数最终为 **287**——新增 bin 6 条，同批删除已无生产调用方的 `findProjectRoot` 6 条专属用例；状态行与开发节均按 287 修正。另在 README 的 bin 用法上保留 `skill-zh` 命令名（输出已归一，照抄可用）。
