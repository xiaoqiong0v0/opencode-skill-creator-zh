/**
 * `skill_zh optimize` 的参数解析与端到端输出（假 opencode 在 PATH 上，不花真钱）。
 *
 * 覆盖：缺参三段式、评测集缺失、`--iterations` 非法值、每轮通过率与最终 description、
 * 报告落盘，以及 `--no-shadow-guard` 的同名技能中止路径。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dispatch } from "../dist/cli/dispatch.js";
import { createFakeOpencodeHarness, triggerLine, withFakeOpencode } from "./helpers/fake-opencode.mjs";

/** 评测集：两正两负，保证训练/测试两侧都有样本。 */
const EVAL_SET = [
  { query: "把发布流程做成技能", should_trigger: true },
  { query: "把接口文档流程固化下来", should_trigger: true },
  { query: "写一段生日邀请函", should_trigger: false },
  { query: "解释一下什么是 OpenAPI", should_trigger: false },
];

/** 假 opencode 的改写响应（`improveDescription` 解析 `<new_description>` 标签）。 */
const IMPROVE_RESPONSE = JSON.stringify({
  type: "text",
  part: { text: "<new_description>优化后的描述：用于演示技能。</new_description>" },
});

/**
 * 建一个带技能与评测集的项目目录。
 *
 * @param {string} root 项目根
 * @returns {string} 技能目录
 */
function makeProject(root) {
  const skillDir = join(root, "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    ["---", "name: demo-skill", "description: 演示技能，用于测试。", "---", "", "# demo", ""].join("\n"),
  );
  writeFileSync(join(skillDir, "eval_set.json"), JSON.stringify(EVAL_SET));
  mkdirSync(join(root, ".opencode"), { recursive: true });
  writeFileSync(join(root, ".opencode", "opencode.json"), "{}\n");
  return skillDir;
}

/**
 * 用给定项目目录执行 `optimize`。
 *
 * @param {string} projectRoot 项目根
 * @param {string} args 子命令参数
 * @returns {Promise<string>} 输出文本
 */
function runOptimizeCommand(projectRoot, args) {
  return dispatch(args, { directory: projectRoot, worktree: projectRoot });
}

test("optimize 缺参返回三段式并给示例", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cli-opt-missing-"));
  try {
    const lines = (await runOptimizeCommand(root, "optimize")).split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：缺少参数 <技能目录>");
    assert.match(lines[1], /^改法：运行 skill_zh optimize /);
    assert.equal(lines[2], "可用：skill_zh help");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optimize 评测集缺失时三段式点名路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cli-opt-noevalset-"));
  try {
    const skillDir = makeProject(root);
    rmSync(join(skillDir, "eval_set.json"));
    const lines = (await runOptimizeCommand(root, "optimize ./skills/demo-skill")).split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：评测集不存在：./skills/demo-skill/eval_set.json");
    assert.equal(lines[2], "可用：skill_zh help");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optimize --iterations 非法值三段式", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cli-opt-baditer-"));
  try {
    makeProject(root);
    for (const args of [
      "optimize ./skills/demo-skill --iterations 0",
      "optimize ./skills/demo-skill --iterations abc",
    ]) {
      const lines = (await runOptimizeCommand(root, args)).split("\n");
      assert.equal(lines.length, 3);
      assert.match(lines[0], /^错误：参数 --iterations 非法：/);
      assert.ok(lines[1].includes("--iterations 5"), lines[1]);
      assert.equal(lines[2], "可用：skill_zh help");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optimize 输出每轮通过率与最终 description，并落盘报告", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-opt-ok-"));
  try {
    makeProject(root);
    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({ lines: [triggerLine("read"), IMPROVE_RESPONSE], exitCode: 0 });
      return runOptimizeCommand(root, "optimize ./skills/demo-skill --iterations 2 --runs 1 --log-dir ./reports");
    });

    assert.ok(output.startsWith("优化 ./skills/demo-skill："), output);
    assert.match(output, /（训练 \d+ \/ 测试 \d+，holdout 0\.4）/);
    assert.match(output, /  第 1 轮  训练 \d+\/\d+  测试 \d+\/\d+/);
    assert.ok(output.includes("最终 description"));
    const reportLine = output.split("\n").find((line) => line.startsWith("报告："));
    assert.ok(reportLine, "缺少报告路径");
    const reportPath = reportLine.slice("报告：".length);
    assert.ok(existsSync(reportPath));
    // 至少跑了 2 轮（训练集有负例 → 触发改善），且改善改写确实进入了历史。
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.ok(report.history.length >= 2, `只跑了 ${report.history.length} 轮`);
    assert.ok(
      report.history.some((entry) => entry.description.includes("优化后的描述")),
      "改善子进程的改写没有进入历史",
    );
    const liveLine = output.split("\n").find((line) => line.startsWith("实时报告："));
    assert.ok(liveLine, "缺少实时报告路径");
    const livePath = liveLine.slice("实时报告：".length);
    assert.equal(
      join(reportPath, ".."),
      join(livePath, ".."),
      "实时报告与 JSON 不在同一运行目录",
    );
    assert.ok(reportPath.includes("/reports/optimize-"), reportPath);
    assert.ok(
      existsSync(join(reportPath, "..", "improve_iter_1.json")),
      "改善记录未落在同一运行目录",
    );
    assert.match(output, /下一步：把上面的 description 写回 \.\/skills\/demo-skill\/SKILL\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("optimize --no-shadow-guard 命中同名技能即中止", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-opt-shadow-"));
  try {
    makeProject(root);
    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({
        lines: [triggerLine("read"), IMPROVE_RESPONSE],
        debugSkills: [{ name: "demo-skill", location: "D:/global-skills/demo-skill" }],
        exitCode: 0,
      });
      return runOptimizeCommand(root, "optimize ./skills/demo-skill --iterations 2 --no-shadow-guard");
    });

    const lines = output.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^错误：检测到同名技能 "demo-skill" 已安装：/);
    assert.ok(lines[1].includes("--no-shadow-guard"), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
  } finally {
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});
