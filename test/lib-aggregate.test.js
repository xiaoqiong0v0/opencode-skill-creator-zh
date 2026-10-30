/**
 * `lib/aggregate` 的基准汇总行为（新写，非迁移——上游无独立测试）。
 *
 * 用例按模块契约手写 fixture 目录：覆盖多 run 汇总、通过率统计、空输入与告警降级。
 * 写盘一律落在 `os.tmpdir()` 的临时目录，`finally` 里清理。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { formatEvalSummary, generateBenchmark, generateMarkdown, summarizeEvalResults } from "../dist/lib/aggregate.js";

/**
 * 在临时目录里跑一次断言，并保证结束时删掉整个目录。
 *
 * @param {(dir: string) => unknown} fn 在临时目录上执行的断言回调
 * @returns {unknown} 回调的返回值
 */
const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "skill-creator-agg-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * 写一份 JSON 文件，父目录按需创建。
 *
 * @param {string} path 目标文件路径
 * @param {unknown} value 要写入的值（字符串按原样写入，用来造坏 JSON）
 */
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};

/**
 * 在接管 `console.error` 的情况下执行回调，收集告警文本。
 *
 * @param {() => unknown} fn 待执行的回调
 * @returns {{ value: unknown, messages: string[] }} 回调返回值与捕获到的告警
 */
const captureStderr = (fn) => {
  const messages = [];
  const original = console.error;
  console.error = (...args) => {
    messages.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    return { value: fn(), messages };
  } finally {
    console.error = original;
  }
};

/**
 * 建一个目录项链接，按给定类型依次尝试（Windows 上 junction 通常免符号链接权限）。
 *
 * @param {string} target 链接目标（断链场景传不存在的路径）
 * @param {string} link 链接路径
 * @param {string[]} types 依次尝试的链接类型
 * @returns {{ ok: boolean, code?: string }} 是否建成；失败时带最后一个错误码
 */
const createLink = (target, link, types) => {
  let lastError;
  for (const type of types) {
    try {
      symlinkSync(target, link, type);
      return { ok: true };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, code: lastError?.code ?? "unknown" };
};

/** 两个配置各两次运行：通过率、耗时与 token 都取可手算的值。 */
const TWO_CONFIG_RUNS = {
  with_skill: [
    { pass_rate: 0.5, time: 10, chars: 100 },
    { pass_rate: 1, time: 20, chars: 300 },
  ],
  without_skill: [
    { pass_rate: 0.25, time: 5, chars: 0 },
    { pass_rate: 0.5, time: 15, chars: 0 },
  ],
};

/**
 * 按工作区布局铺一份基准目录：<dir>/eval-1/<config>/run-N/grading.json。
 *
 * @param {string} dir 基准目录
 */
const writeTwoConfigWorkspace = (dir) => {
  for (const [config, runs] of Object.entries(TWO_CONFIG_RUNS)) {
    runs.forEach((run, index) => {
      writeJson(join(dir, "eval-1", config, `run-${index + 1}`, "grading.json"), {
        summary: {
          pass_rate: run.pass_rate,
          passed: 1,
          failed: 1,
          total: 2,
        },
        timing: { total_duration_seconds: run.time },
        execution_metrics: {
          total_tool_calls: index,
          output_chars: run.chars,
          errors_encountered: 0,
        },
        expectations: [{ text: "artifact exists", passed: true }],
      });
    });
  }
};

test("多 run 汇总：通过率 / 耗时 / token 的均值、样本标准差、极值与 delta", () => {
  withTempDir((dir) => {
    const workspace = join(dir, "bench");
    writeTwoConfigWorkspace(workspace);

    const benchmark = generateBenchmark(workspace);

    // 期望值手算：均值取平均，标准差用 n-1，全部四舍五入到 4 位小数。
    assert.deepEqual(benchmark.run_summary, {
      with_skill: {
        pass_rate: { mean: 0.75, stddev: 0.3536, min: 0.5, max: 1 },
        time_seconds: { mean: 15, stddev: 7.0711, min: 10, max: 20 },
        tokens: { mean: 200, stddev: 141.4214, min: 100, max: 300 },
      },
      without_skill: {
        pass_rate: { mean: 0.375, stddev: 0.1768, min: 0.25, max: 0.5 },
        time_seconds: { mean: 10, stddev: 7.0711, min: 5, max: 15 },
        tokens: { mean: 0, stddev: 0, min: 0, max: 0 },
      },
      delta: { pass_rate: "+0.38", time_seconds: "+5.0", tokens: "+200" },
    });
  });
});

test("runs 数组按配置摊平，逐条带上 eval / 配置 / 运行序号与执行指标", () => {
  withTempDir((dir) => {
    const workspace = join(dir, "bench");
    writeTwoConfigWorkspace(workspace);

    const benchmark = generateBenchmark(workspace, "my-skill", "/tmp/my-skill");

    assert.equal(benchmark.runs.length, 4);
    assert.deepEqual(benchmark.runs[0], {
      eval_id: 1,
      configuration: "with_skill",
      run_number: 1,
      result: {
        pass_rate: 0.5,
        passed: 1,
        failed: 1,
        total: 2,
        time_seconds: 10,
        tokens: 100,
        tool_calls: 0,
        errors: 0,
      },
      expectations: [{ text: "artifact exists", passed: true }],
      notes: [],
    });
    // token 缺省时退回 execution_metrics.output_chars，这里第 2 次运行是 300。
    assert.equal(benchmark.runs[1].result.tokens, 300);
    assert.equal(benchmark.metadata.skill_name, "my-skill");
    assert.equal(benchmark.metadata.skill_path, "/tmp/my-skill");
    assert.deepEqual(benchmark.metadata.evals_run, [1]);
    assert.equal(benchmark.metadata.runs_per_configuration, 2);
    assert.deepEqual(benchmark.notes, []);
  });
});

test("eval_id 取 eval_metadata.json 并按数值排序，运行次数取所有配置的最小值", () => {
  withTempDir((dir) => {
    const workspace = join(dir, "bench");
    writeJson(join(workspace, "eval-1", "eval_metadata.json"), { eval_id: 10 });
    writeJson(join(workspace, "eval-2", "eval_metadata.json"), { eval_id: 2 });
    for (const evalDir of ["eval-1", "eval-2"]) {
      for (const config of ["with_skill", "without_skill"]) {
        for (const run of ["run-1", "run-2"]) {
          // eval-2 的 without_skill 少一次运行，用来验证「取最小值」的口径。
          if (evalDir === "eval-2" && config === "without_skill" && run === "run-2") {
            continue;
          }
          writeJson(join(workspace, evalDir, config, run, "grading.json"), {
            summary: { pass_rate: 1, passed: 1, failed: 0, total: 1 },
          });
        }
      }
    }

    const benchmark = generateBenchmark(workspace);

    assert.deepEqual(benchmark.metadata.evals_run, [2, 10]);
    assert.equal(benchmark.metadata.runs_per_configuration, 1);
    assert.equal(benchmark.runs.length, 7);
  });
});

test("旧布局 runs/ 也能读，耗时与 token 可退回同目录的 timing.json", () => {
  withTempDir((dir) => {
    const legacy = join(dir, "legacy");
    writeJson(join(legacy, "runs", "eval-1", "with_skill", "run-1", "grading.json"), {
      summary: { pass_rate: 1, passed: 3, failed: 0, total: 3 },
    });
    writeJson(join(legacy, "runs", "eval-1", "with_skill", "run-1", "timing.json"), {
      total_duration_seconds: 7,
      total_tokens: 42,
    });

    const benchmark = generateBenchmark(legacy);

    assert.equal(benchmark.runs.length, 1);
    assert.equal(benchmark.runs[0].eval_id, 1);
    assert.equal(benchmark.runs[0].result.time_seconds, 7);
    assert.equal(benchmark.runs[0].result.tokens, 42);
    assert.equal(benchmark.runs[0].result.pass_rate, 1);
  });
});

test("runs 是同名文件或基准路径本身不是目录时不抛错，各按「找不到 eval 目录」告警一条", () => {
  // 台账第 6 条（已修）：`runs` 必须是目录才算旧布局，否则 readdirSync 会抛 ENOTDIR；
  // 父目录不是目录时 sortedDirs 直接返回空（守卫），不抛错。
  withTempDir((dir) => {
    const asFile = join(dir, "runs-is-file");
    mkdirSync(asFile, { recursive: true });
    writeFileSync(join(asFile, "runs"), "占位文件");

    const fromFile = captureStderr(() => generateBenchmark(asFile));

    // 同名文件按「不存在」处理：退回工作区布局探测，仍没有 eval-* 目录 ⇒ 一条告警、空汇总。
    assert.equal(fromFile.messages.length, 1);
    assert.match(fromFile.messages[0], /^未在 .+ 或 .+ 找到任何 eval 目录$/);
    assert.deepEqual(fromFile.value.runs, []);
    assert.deepEqual(fromFile.value.metadata.evals_run, []);
    assert.equal(fromFile.value.metadata.runs_per_configuration, 0);

    // 基准路径本身是普通文件：父目录「是目录」守卫生效，同样只有一条告警。
    const asBench = join(dir, "bench.bak");
    writeFileSync(asBench, "不是目录");

    const fromFileParent = captureStderr(() => generateBenchmark(asBench));

    assert.equal(fromFileParent.messages.length, 1);
    assert.match(fromFileParent.messages[0], /^未在 .+ 或 .+ 找到任何 eval 目录$/);
    assert.deepEqual(fromFileParent.value.runs, []);
  });
});

test("断链符号链接（benchmark 根与 runs/ 内）被跳过并各告警一条，不影响其余汇总", (t) => {
  // 台账第 6 条（已修）：目录项改为 lstat + 链接探目标，断链链接不再让 statSync 抛 ENOENT。
  withTempDir((dir) => {
    const missingTarget = join(dir, "does-not-exist");

    // 场景一：工作区布局，benchmark 根上一条断链链接（名字符合 eval-*）
    const rootBench = join(dir, "root-bench");
    writeTwoConfigWorkspace(rootBench);
    const rootLink = createLink(missingTarget, join(rootBench, "eval-broken"), [
      "junction",
      "file",
    ]);

    // 场景二：旧布局，断链链接在 runs/ 里
    const runsBench = join(dir, "runs-bench");
    writeJson(join(runsBench, "runs", "eval-1", "with_skill", "run-1", "grading.json"), {
      summary: { pass_rate: 1, passed: 1, failed: 0, total: 1 },
    });
    const runsLink = createLink(missingTarget, join(runsBench, "runs", "eval-ghost"), [
      "junction",
      "file",
    ]);

    if (!rootLink.ok || !runsLink.ok) {
      // 构造不出场景就明确 skip，绝不因为写不出 fixture 而假通过。
      const code = !rootLink.ok ? rootLink.code : runsLink.code;
      t.skip(`当前环境无法创建符号链接（${code}）`);
      return;
    }

    const fromRoot = captureStderr(() => generateBenchmark(rootBench));

    // 只多出跳过断链链接这一条告警（不是「找不到 eval 目录」），合法 eval 目录照常汇总。
    assert.equal(fromRoot.messages.length, 1);
    assert.match(fromRoot.messages[0], /^警告：目录项不可解析，已跳过：.+eval-broken（.+/);
    assert.equal(fromRoot.value.runs.length, 4);
    assert.deepEqual(fromRoot.value.metadata.evals_run, [1]);

    const fromRuns = captureStderr(() => generateBenchmark(runsBench));

    assert.equal(fromRuns.messages.length, 1);
    assert.match(fromRuns.messages[0], /^警告：目录项不可解析，已跳过：.+eval-ghost（.+/);
    assert.equal(fromRuns.value.runs.length, 1);
    assert.deepEqual(fromRuns.value.metadata.evals_run, [1]);
  });
});

test("eval-0 是指向目录的合法符号链接时仍被当作 eval 目录参与汇总", (t) => {
  // 修复不能顺手把「指向目录的合法链接」判成非目录（那是新的回归）。
  withTempDir((dir) => {
    const realEval = join(dir, "real-eval-0");
    writeJson(join(realEval, "with_skill", "run-1", "grading.json"), {
      summary: { pass_rate: 1, passed: 1, failed: 0, total: 1 },
    });

    const bench = join(dir, "bench");
    mkdirSync(bench, { recursive: true });
    const link = createLink(realEval, join(bench, "eval-0"), ["junction", "dir"]);

    if (!link.ok) {
      t.skip(`当前环境无法创建目录符号链接（${link.code}）`);
      return;
    }

    const { value: benchmark, messages } = captureStderr(() => generateBenchmark(bench));

    assert.deepEqual(messages, []);
    assert.equal(benchmark.runs.length, 1);
    assert.equal(benchmark.runs[0].eval_id, 0);
    assert.equal(benchmark.runs[0].configuration, "with_skill");
    assert.deepEqual(benchmark.metadata.evals_run, [0]);
    assert.equal(benchmark.metadata.runs_per_configuration, 1);
  });
});

test("空输入：没有 eval 目录时返回空汇总、零值 delta 并告警", () => {
  withTempDir((dir) => {
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });

    const { value: benchmark, messages } = captureStderr(() =>
      generateBenchmark(empty),
    );

    assert.equal(messages.length, 1);
    assert.match(messages[0], /^未在 .+ 或 .+ 找到任何 eval 目录$/);
    assert.deepEqual(benchmark.runs, []);
    assert.deepEqual(benchmark.notes, []);
    assert.deepEqual(benchmark.metadata.evals_run, []);
    assert.equal(benchmark.metadata.runs_per_configuration, 0);
    assert.equal(benchmark.metadata.skill_name, "<skill-name>");
    assert.equal(benchmark.metadata.skill_path, "<path/to/skill>");
    assert.match(
      benchmark.metadata.timestamp,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    assert.deepEqual(benchmark.run_summary, {
      delta: { pass_rate: "+0.00", time_seconds: "+0.0", tokens: "+0" },
    });
  });
});

test("空数据的 Markdown 用占位配置名与破折号，且不输出备注段", () => {
  withTempDir((dir) => {
    const empty = join(dir, "empty");
    mkdirSync(empty, { recursive: true });
    const { value: benchmark } = captureStderr(() => generateBenchmark(empty));

    const markdown = generateMarkdown(benchmark);
    const lines = markdown.split("\n");

    assert.ok(lines.includes("| Metric | Config A | Config B | Delta |"));
    assert.ok(lines.includes("| Pass Rate | — | — | +0.00 |"));
    assert.ok(lines.includes("| Time | — | — | +0.0s |"));
    assert.ok(lines.includes("| Tokens | — | — | +0 |"));
    assert.ok(lines.includes("**Evals**:  (0 runs each per configuration)"));
    assert.ok(!markdown.includes("## Notes"));
  });
});

test("单个配置时 delta 以 0 为基线", () => {
  withTempDir((dir) => {
    const bench = join(dir, "bench");
    for (const [index, passRate] of [0.5, 1].entries()) {
      writeJson(join(bench, "eval-1", "with_skill", `run-${index + 1}`, "grading.json"), {
        summary: { pass_rate: passRate, passed: 1, failed: 1, total: 2 },
        timing: { total_duration_seconds: 4 },
      });
    }

    const benchmark = generateBenchmark(bench);

    assert.deepEqual(benchmark.run_summary.delta, {
      pass_rate: "+0.75",
      time_seconds: "+4.0",
      tokens: "+0",
    });
  });
});

test("单个运行目录有问题时只告警跳过，不影响其余汇总", () => {
  withTempDir((dir) => {
    const bench = join(dir, "bench");
    // 合法的一次运行，顺带覆盖「期望项缺字段」告警与人工备注归集
    writeJson(join(bench, "eval-1", "with_skill", "run-1", "grading.json"), {
      summary: { pass_rate: 1, passed: 1, failed: 0, total: 1 },
      expectations: [{ text: "only text" }],
      user_notes_summary: {
        uncertainties: ["u1"],
        needs_review: ["r1"],
        workarounds: ["w1"],
      },
    });
    // 缺 grading.json
    mkdirSync(join(bench, "eval-1", "with_skill", "run-2"), { recursive: true });
    // 坏 JSON
    writeJson(join(bench, "eval-1", "with_skill", "run-3", "grading.json"), "{ not json");
    // 目录名不合规
    writeJson(join(bench, "eval-1", "with_skill", "run-x", "grading.json"), {
      summary: { pass_rate: 1 },
    });

    const { value: benchmark, messages } = captureStderr(() =>
      generateBenchmark(bench),
    );

    // 告警顺序按 run-1 / run-2 / run-3 / run-x 的字典序遍历产生
    assert.equal(messages.length, 4);
    assert.match(messages[0], /^警告：.+expectation 缺必填字段（text、passed、evidence）$/);
    assert.match(messages[1], /^警告：缺少 grading\.json，已跳过：/);
    assert.match(messages[2], /^警告：grading\.json 不是合法 JSON，已跳过：/);
    assert.match(messages[3], /^警告：run 目录名不合规，已跳过：/);

    assert.equal(benchmark.runs.length, 1);
    assert.deepEqual(benchmark.runs[0].notes, ["u1", "r1", "w1"]);
    assert.equal(benchmark.run_summary.with_skill.pass_rate.mean, 1);
  });
});

test("generateMarkdown 渲染统计表、带符号 delta 与备注段", () => {
  withTempDir((dir) => {
    const workspace = join(dir, "bench");
    writeTwoConfigWorkspace(workspace);
    const benchmark = generateBenchmark(workspace);

    const markdown = generateMarkdown({
      ...benchmark,
      notes: ["first note", "second note"],
    });
    const lines = markdown.split("\n");

    assert.ok(lines.includes("# Skill Benchmark: <skill-name>"));
    assert.ok(lines.includes("**Model**: <model-name>"));
    assert.ok(lines.includes("| Metric | With Skill | Without Skill | Delta |"));
    assert.ok(lines.includes("| Pass Rate | 75% ± 35% | 38% ± 18% | +0.38 |"));
    assert.ok(lines.includes("| Time | 15.0s ± 7.1s | 10.0s ± 7.1s | +5.0s |"));
    assert.ok(lines.includes("| Tokens | 200 ± 141 | 0 ± 0 | +200 |"));
    assert.ok(lines.includes("**Evals**: 1 (2 runs each per configuration)"));
    // `generateBenchmark` 自身不产出备注，备注段只在调用方补了 notes 时出现
    assert.ok(markdown.endsWith("## Notes\n\n- first note\n- second note"));
  });
});

test("eval 汇总：通过率、按 should_trigger 分组与重复 query 分组", () => {
  const rows = [
    { query: "重复项", should_trigger: true, trigger_rate: 1, pass: true },
    { query: "重复项", should_trigger: true, trigger_rate: 0, pass: false },
    { query: "只该触发", should_trigger: true, trigger_rate: 1, pass: true },
    { query: "不该触发", should_trigger: false, trigger_rate: 0, pass: true },
  ];

  const summary = summarizeEvalResults(rows);
  assert.equal(summary.total, 4);
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.pass_rate, 0.75);

  const should = summary.groups.find((group) => group.should_trigger);
  const shouldNot = summary.groups.find((group) => !group.should_trigger);
  assert.equal(should.total, 3);
  assert.equal(should.passed, 2);
  assert.equal(should.failed, 1);
  assert.equal(should.pass_rate, 2 / 3);
  assert.equal(shouldNot.total, 1);
  assert.equal(shouldNot.passed, 1);

  // 统计口径与 benchmark 同源：原始触发率的均值/标准差由 calculateStats 计算。
  assert.equal(should.trigger_rate.mean, 0.6667);
  assert.equal(should.trigger_rate.max, 1);
  assert.deepEqual(summary.duplicates, [{ query: "重复项", total: 2, passed: 1 }]);

  const lines = formatEvalSummary(summary).join("\n");
  assert.match(lines, /^汇总：/);
  // 通过率 = 成绩；触发率 = 诊断量。每行都要标口径，否则「0.50 ± x」会被读成得分。
  assert.ok(
    lines.includes("总通过率 0.75（3/4），失败 1 条；原始触发率 0.50 ± 0.58（诊断用，非通过率）"),
    lines,
  );
  assert.ok(
    lines.includes("应触发：3 条，通过 2（0.67），失败 1；原始触发率 0.67 ± 0.58（诊断用，非通过率）"),
    lines,
  );
  assert.ok(
    lines.includes("不应触发：1 条，通过 1（1.00），失败 0；原始触发率 0.00 ± 0.00（诊断用，非通过率）"),
    lines,
  );
  assert.match(lines, /重复 query：1 组，「重复项」×2（通过 1\/2）/);
  // 旧文案（只说「触发率均值」，不带口径）必须彻底消失。
  assert.doesNotMatch(lines, /触发率均值/);
});

test("eval 汇总：没有重复 query 时明确写「无」", () => {
  const summary = summarizeEvalResults([
    { query: "a", should_trigger: true, trigger_rate: 1, pass: true },
  ]);
  assert.deepEqual(summary.duplicates, []);
  assert.match(formatEvalSummary(summary).join("\n"), /重复 query：无/);
});
