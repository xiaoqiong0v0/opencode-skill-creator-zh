# skill/SKILL.md 与 skill/references/schemas.md 变更说明（2026-10-29）

## 正文工具名改为 `skill_zh` 单工具体系（B6）

**原来**：正文点名上游 14 个工具的旧名——`SKILL.md` 里 9 个不同工具名共 **14 处**（`skill_validate` 2、`skill_parse` 1、`skill_improve_description` 1、`skill_optimize_loop` 1、`skill_aggregate_benchmark` 2、`skill_generate_report` 1、`skill_serve_review` 2、`skill_stop_review` 2、`skill_export_static_review` 2）；配套工具一览表按「14 个工具」列，评测集固定 `evals/evals.json`，评审环节写「起 / 停查看器 + 导出静态 HTML」。

**现在**：

1. 上述 **14 处全部改写为 `skill_zh <子命令>`**，验收正则在 `skill/` 下命中 **0**；正文里不再出现任何 `skill_<工具名>` 形式的调用。
2. 配套工具一览表重写为**实际提供的 7 个子命令**（`help` / `new` / `validate` / `eval` / `optimize` / `package` / `install`），与 `src/cli/help.ts` 的 `HELP_TEXT` 一致。
3. 本版**未注册**的能力明确标注为「本版不提供」，并给出替代路径而非虚构子命令：benchmark 汇总与 HTML 报告 → 走 `skill_zh eval` 输出（需要 `benchmark.json`/`benchmark.md` 时按 schema 手工整理）；评审查看器起 / 停 / 导出 → 人工评审、按评分章节逐条记录；gold 样本管理 → 手工记录。
4. 评测集默认位置统一为 `<技能目录>/eval_set.json`，报告与产物落 `<技能目录>/.evals/`（可用 `--eval-set` / `--log-dir` 改）。
5. `references/schemas.md` 里查看器相关表述改为「本版未提供，供人工评审对照」，`templates/eval-review.html` 明确为「随包提供但未接线」。

**为什么**：正文是模型调用本工具的唯一说明书，写着上游工具名就等于让模型调用不存在的工具（R1 已把这些工具全部取消注册）。B6 的验收就是「旧名零命中 + 7 个子命令与 `HELP_TEXT` 一致」，改写完成即 B6 完成。
