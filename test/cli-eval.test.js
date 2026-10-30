/**
 * `skill_zh eval` 的参数解析与端到端输出（假 opencode 在 PATH 上，不花真钱）。
 *
 * 覆盖：缺参三段式、评测集缺失、非法参数值、逐条结果 / 失败清单 / 报告路径、默认只输出
 * 镜像汇总、`--no-shadow-guard` 与自动 deny 的差异，以及输出不是对话式文案。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dispatch } from "../dist/cli/dispatch.js";
import { createFakeOpencodeHarness, triggerLine, withFakeOpencode } from "./helpers/fake-opencode.mjs";

/** 评测集：一正一负。 */
const EVAL_SET = [
  { query: "把发布流程做成技能", should_trigger: true },
  { query: "写一段生日邀请函", should_trigger: false },
];

/**
 * 建一个带技能与评测集的项目目录。
 *
 * @param {string} root 项目根
 * @param {Array<Record<string, unknown>>} evalSet 评测集
 */
function makeProject(root, evalSet = EVAL_SET) {
  const skillDir = join(root, "skills", "demo-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    ["---", "name: demo-skill", "description: 演示技能，用于测试。", "---", "", "# demo", ""].join("\n"),
  );
  writeFileSync(join(skillDir, "eval_set.json"), JSON.stringify(evalSet));
  mkdirSync(join(root, ".opencode"), { recursive: true });
  writeFileSync(join(root, ".opencode", "opencode.json"), "{}\n");
  return skillDir;
}

/**
 * 用给定项目目录执行 `eval`。
 *
 * @param {string} projectRoot 项目根
 * @param {string} args 子命令参数
 * @returns {Promise<string>} 输出文本
 */
function runEvalCommand(projectRoot, args) {
  return dispatch(args, { directory: projectRoot, worktree: projectRoot });
}

test("eval 缺参返回三段式并给示例", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-missing-"));
  try {
    const lines = (await runEvalCommand(root, "eval")).split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：缺少参数 <技能目录>");
    assert.match(lines[1], /^改法：运行 skill_zh eval /);
    assert.equal(lines[2], "可用：skill_zh help");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval 评测集缺失时三段式点名路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-noevalset-"));
  try {
    const skillDir = makeProject(root);
    rmSync(join(skillDir, "eval_set.json"));
    const lines = (await runEvalCommand(root, "eval ./skills/demo-skill")).split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：评测集不存在：./skills/demo-skill/eval_set.json");
    assert.match(lines[1], /^改法：/);
    assert.equal(lines[2], "可用：skill_zh help");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval 非法参数值给出允许取值与可照抄命令", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-badflag-"));
  try {
    makeProject(root);
    for (const [args, pattern] of [
      ["eval ./skills/demo-skill --runs abc", /参数 --runs 非法：abc/],
      ["eval ./skills/demo-skill --workers 0", /参数 --workers 非法：0/],
      ["eval ./skills/demo-skill --timeout 0", /参数 --timeout 非法：0/],
    ]) {
      const lines = (await runEvalCommand(root, args)).split("\n");
      assert.equal(lines.length, 3);
      assert.match(lines[0], pattern);
      assert.ok(lines[1].includes("skill_zh eval ./skills/demo-skill"), lines[1]);
      assert.equal(lines[2], "可用：skill_zh help");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("eval 输出通过率、逐条结果、报告路径与镜像汇总（非对话式）", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-ok-"));
  try {
    const skillDir = makeProject(root);
    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({ lines: [triggerLine("read")], exitCode: 0 });
      return runEvalCommand(root, "eval ./skills/demo-skill --runs 2 --workers 1");
    });

    assert.ok(output.startsWith("评测 ./skills/demo-skill：通过率"), output);
    assert.match(output, /通过率 0\.50（1\/2，每条 2 次，阈值 0\.5）/);
    assert.ok(output.includes("逐条结果："));
    assert.ok(output.includes("✓ 应触发"));
    assert.ok(output.includes("✗ 不应触发"));
    assert.ok(output.includes("失败用例："));
    assert.ok(output.includes("不应触发却触发（1）"));
    assert.ok(output.includes("镜像："));
    // 汇总段（R2）：总通过率、按 should_trigger 分组与重复 query 分组。
    assert.ok(output.includes("汇总："), output);
    assert.match(output, /总通过率 0\.50（1\/2），失败 1 条/);
    assert.match(output, /应触发：1 条，通过 1（1\.00），失败 0/);
    assert.match(output, /不应触发：1 条，通过 0（0\.00），失败 1/);
    // 触发率是诊断量，不是得分：每一处都要带「诊断用，非通过率」，避免被读成「只过了一半」。
    assert.ok(
      output.includes("总通过率 0.50（1/2），失败 1 条；原始触发率 1.00 ± 0.00（诊断用，非通过率）"),
      output,
    );
    assert.ok(output.includes("应触发：1 条，通过 1（1.00），失败 0；原始触发率 1.00 ± 0.00（诊断用，非通过率）"), output);
    assert.ok(output.includes("不应触发：1 条，通过 0（0.00），失败 1；原始触发率 1.00 ± 0.00（诊断用，非通过率）"), output);
    assert.ok(!output.includes("触发率均值"), output);
    assert.ok(output.includes("重复 query：无"));
    const reportLine = output.split("\n").find((line) => line.startsWith("报告："));
    assert.ok(reportLine, "缺少报告路径");
    const reportPath = reportLine.slice("报告：".length);
    assert.ok(existsSync(reportPath), `报告未落盘：${reportPath}`);
    // 报告里的路径在本项目 `.evals/` 下。
    assert.ok(reportPath.includes("skills/demo-skill/.evals/eval-"));

    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    assert.equal(report.summary.total, 2);
    assert.equal(report.skill_name, "demo-skill");
    assert.equal(report.shadow_guard, true);

    // 对话式文案会破坏 CLI 可解析性：拒绝「好的 / 当然 / 我来」这类开头。
    assert.doesNotMatch(output, /^(好的|当然|没问题|我来)/);
    assert.ok(existsSync(join(skillDir, ".evals")), "报告目录未创建");
  } finally {
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("eval 默认自动 deny 同名技能；--no-shadow-guard 改为命中即中止", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-shadow-"));
  const startLog = join(harness.root, "starts.log");
  try {
    makeProject(root);
    const shadowSkill = { name: "demo-skill", location: "D:/global-skills/demo-skill" };

    const guarded = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({
        lines: [triggerLine("read")],
        debugSkills: [shadowSkill],
        exitCode: 0,
      });
      return runEvalCommand(root, "eval ./skills/demo-skill");
    });
    assert.ok(guarded.startsWith("评测 ./skills/demo-skill：通过率"), guarded);

    const blocked = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({
        lines: [triggerLine("read")],
        debugSkills: [shadowSkill],
        startLog,
        exitCode: 0,
      });
      return runEvalCommand(root, "eval ./skills/demo-skill --no-shadow-guard");
    });
    const lines = blocked.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^错误：检测到同名技能 "demo-skill" 已安装：D:\/global-skills\/demo-skill/);
    assert.ok(lines[1].includes("--no-shadow-guard"), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
    // 枚举同名技能本身会跑一次 `opencode debug skill`（cwd = 项目根）；关闭屏蔽时必须
    // 在启动评测子进程（cwd = 隔离根）之前中止。
    const evalStarts = existsSync(startLog)
      ? readFileSync(startLog, "utf-8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.cwd !== realpathSync(root))
      : [];
    assert.deepEqual(evalStarts, [], "关闭屏蔽后仍启动了评测子进程");
  } finally {
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("eval 枚举不可用时三段式指向 opencode debug skill，而不是让用户删技能", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-enumfail-"));
  try {
    makeProject(root);
    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({ debugSkillExitCode: 1 });
      return runEvalCommand(root, "eval ./skills/demo-skill");
    });
    const lines = output.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^错误：无法枚举/);
    assert.ok(lines[1].includes("opencode debug skill"), lines[1]);
    assert.ok(!lines[1].includes("移走或改名"), "枚举失败不应提示用户移走技能");
    assert.equal(lines[2], "可用：skill_zh help");
  } finally {
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("eval 隔离根 deny 写入失败 → 整轮失败且不落报告", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-fatal-"));
  const originalWrite = fs.writeFileSync;
  try {
    const skillDir = makeProject(root);
    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({
        lines: [triggerLine("read")],
        debugSkills: [{ name: "demo-skill", location: "D:/global-skills/demo-skill" }],
      });
      fs.writeFileSync = (file, ...rest) => {
        const target = String(file).replaceAll("\\", "/");
        if (
          target.includes("opencode-skill-eval-") &&
          !target.includes("probe") &&
          target.endsWith(".opencode/opencode.json")
        ) {
          throw new Error("EACCES: per-query deny blocked");
        }
        return originalWrite(file, ...rest);
      };
      syncBuiltinESMExports();
      return runEvalCommand(root, "eval ./skills/demo-skill");
    });

    const lines = output.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^错误：隔离根准备失败/);
    assert.ok(lines[1].includes("临时目录"), lines[1]);
    const reportDir = join(skillDir, ".evals");
    assert.equal(
      existsSync(reportDir) ? readdirSync(reportDir).length : 0,
      0,
      "评测失败后不应写报告",
    );
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});

test("new 生成的 eval_set.json 骨架可直接跑（假 opencode，不花钱）", async () => {
  const harness = createFakeOpencodeHarness();
  const root = mkdtempSync(join(tmpdir(), "skill-cli-eval-from-new-"));
  try {
    // 只给技能名，其余交给 new：骨架自带的评测集必须能被 eval 直接读起来。
    const scaffold = await dispatch("new demo-skill --dir .", { directory: root, worktree: root });
    assert.ok(scaffold.startsWith("已生成技能骨架："), scaffold);
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(join(root, ".opencode", "opencode.json"), "{}\n");

    const output = await withFakeOpencode(harness, async (writeScenario) => {
      writeScenario({ lines: [triggerLine("read")], exitCode: 0 });
      return runEvalCommand(root, "eval ./demo-skill --runs 1 --workers 1");
    });

    // 2 正 1 负：骨架 query 全是占位，但评测本身必须跑通（不再报「找不到评测集」）。
    assert.ok(output.startsWith("评测 ./demo-skill：通过率"), output);
    assert.match(output, /通过率 \d\.\d\d（\d\/3，每条 1 次/);
    assert.ok(output.includes("汇总："), output);
    assert.ok(output.includes("报告："), output);
    assert.ok(!output.includes("评测集不存在"), output);
  } finally {
    rmSync(root, { recursive: true, force: true });
    harness.cleanup();
  }
});
