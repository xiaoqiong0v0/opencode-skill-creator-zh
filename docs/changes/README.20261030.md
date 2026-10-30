# 变更说明：状态行口径（发布链路未做 → CI 已补、npm 发布未做）

日期：2026-10-30

**原来**：`README.md`、`docs/ROADMAP.md`、`docs/SPEC.md`、`docs/installation.md`、`docs/README.md` 的状态行统一写「**发布链路尚未做**：`npm publish` 由用户手动执行」。

**现在**：改为「**CI 已补**（`.github/workflows/ci.yml`：push / PR 跑 `npm run typecheck` + `npm test` + `npm pack --dry-run`）；**npm 发布尚未做**：`npm publish` 由用户手动执行」。

**为什么**：同日新建 `.github/workflows/ci.yml` 并随首次推送生效，「发布链路未做」已不再成立；但发布流水线（tag 触发 + `NPM_TOKEN`）与 `npm publish` 仍未做，所以只把口径拆成两段，不整体改成「已完成」。落点：同批改动 5 处状态行，改动原因与涉及文件见本节。
