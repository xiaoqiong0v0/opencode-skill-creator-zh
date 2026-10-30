/**
 * `lib/workflow-guard` 的对比评测工作区校验行为。
 *
 * 上游 `.tmp/old/plugin/test/` 没有该模块的测试，本文件按模块对外行为补覆盖：
 * 路径不存在/不是目录、无 `eval-*` 目录、`runs/` 嵌套布局、成对运行缺失的两类
 * 问题、`outputs/` 作为运行产物的兜底（空目录不算）、断链链接跳过与合法目录链接，
 * 以及 `foundConfigs` 的去重排序。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateComparisonWorkspace } from "../dist/lib/workflow-guard.js";

/**
 * 在临时目录里跑一次工作区校验，结束后递归清理。
 *
 * @param {(root: string) => unknown} fn 在临时根目录上执行的断言回调
 * @returns {unknown} 回调的返回值
 */
const withWorkspace = (fn) => {
  const root = mkdtempSync(join(tmpdir(), "skill-creator-guard-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

/**
 * 在 `root` 下批量建目录。
 *
 * @param {string} root 工作区根目录
 * @param {string[]} relativePaths 相对路径列表，按顺序创建
 */
const makeDirs = (root, relativePaths) => {
  for (const relativePath of relativePaths) {
    mkdirSync(join(root, relativePath), { recursive: true });
  }
};

test("工作区路径不存在时返回唯一一条 issue", () => {
  withWorkspace((root) => {
    const missing = join(root, "nope");

    const result = validateComparisonWorkspace(missing);

    assert.equal(result.valid, false);
    assert.equal(result.evalCount, 0);
    assert.deepEqual(result.issues, [
      { evalDir: "nope", issue: "工作区路径不存在" },
    ]);
    assert.deepEqual(result.foundConfigs, []);
    assert.equal(result.searchRoot, missing);
  });
});

test("工作区路径是文件时返回「不是目录」issue", () => {
  withWorkspace((root) => {
    const filePath = join(root, "plain.txt");
    writeFileSync(filePath, "");

    const result = validateComparisonWorkspace(filePath);

    assert.equal(result.valid, false);
    assert.equal(result.evalCount, 0);
    assert.deepEqual(result.issues, [
      { evalDir: "plain.txt", issue: "工作区路径不是目录" },
    ]);
    assert.deepEqual(result.foundConfigs, []);
    assert.equal(result.searchRoot, filePath);
  });
});

test("目录里没有 eval-* 时给出「缺评测目录」issue", () => {
  withWorkspace((root) => {
    makeDirs(root, ["unrelated"]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, false);
    assert.equal(result.evalCount, 0);
    assert.equal(result.issues.length, 1);
    assert.equal(
      result.issues[0].issue,
      "未找到 eval-* 评测目录（应为含 with_skill 与基线运行的评测目录）",
    );
    assert.equal(result.issues[0].evalDir, root.split(/[\\/]/).at(-1));
    assert.equal(result.searchRoot, root);
  });
});

test("顶层没有 eval-* 但 runs/ 下有嵌套 eval-* 时改用 runs 作为扫描根", () => {
  withWorkspace((root) => {
    makeDirs(root, [
      "runs/eval-a/with_skill/run-1",
      "runs/eval-a/without_skill/run-1",
    ]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, true);
    assert.equal(result.evalCount, 1);
    assert.deepEqual(result.issues, []);
    assert.equal(result.searchRoot, join(root, "runs"));
  });
});

test("带技能与基线都齐备时校验通过，foundConfigs 去重后排序", () => {
  withWorkspace((root) => {
    makeDirs(root, [
      "eval-a/with_skill/run-1",
      "eval-a/without_skill/run-1",
      "eval-b/with_skill/run-1",
      "eval-b/without_skill/run-1",
      "eval-b/old_skill/run-1",
    ]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, true);
    assert.equal(result.evalCount, 2);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.foundConfigs, [
      "old_skill",
      "with_skill",
      "without_skill",
    ]);
    assert.equal(result.searchRoot, root);
  });
});

test("old_skill 可以替代 without_skill 作为基线", () => {
  withWorkspace((root) => {
    makeDirs(root, ["eval-a/with_skill/run-1", "eval-a/old_skill/run-1"]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, true);
    assert.equal(result.evalCount, 1);
    assert.deepEqual(result.foundConfigs, ["old_skill", "with_skill"]);
  });
});

test("with_skill 目录存在但没有运行产物时仍算缺失", () => {
  withWorkspace((root) => {
    // 只建空目录：既没有 run-*，也没有 outputs。
    makeDirs(root, ["eval-a/with_skill", "eval-a/without_skill/run-1"]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [
      { evalDir: "eval-a", issue: "缺少 with_skill 的运行产物" },
    ]);
    // 目录本身存在过，因此仍然计入 foundConfigs。
    assert.deepEqual(result.foundConfigs, ["with_skill", "without_skill"]);
  });
});

test("基线两种目录都缺时报告 baseline issue，并与 with_skill 缺口同时累积", () => {
  withWorkspace((root) => {
    makeDirs(root, ["eval-a"]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, false);
    assert.equal(result.evalCount, 1);
    assert.deepEqual(result.issues, [
      { evalDir: "eval-a", issue: "缺少 with_skill 的运行产物" },
      {
        evalDir: "eval-a",
        issue: "缺少基线运行产物（without_skill 或 old_skill）",
      },
    ]);
    assert.deepEqual(result.foundConfigs, []);
  });
});

test("空 outputs 目录不算有运行产物，缺运行的问题照常报出", () => {
  // 台账第 2 条（已修）：outputs/ 只是产物兜底布局，空目录说明没跑出任何东西。
  withWorkspace((root) => {
    makeDirs(root, ["eval-a/with_skill/outputs", "eval-a/without_skill/outputs"]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [
      { evalDir: "eval-a", issue: "缺少 with_skill 的运行产物" },
      {
        evalDir: "eval-a",
        issue: "缺少基线运行产物（without_skill 或 old_skill）",
      },
    ]);
    // 目录本身存在过，因此仍然计入 foundConfigs。
    assert.deepEqual(result.foundConfigs, ["with_skill", "without_skill"]);
  });
});

test("outputs 目录里有产物时算有运行产物", () => {
  // 同一条缺陷的另一半：只要 outputs/ 至少有一个条目就继续放行。
  withWorkspace((root) => {
    makeDirs(root, ["eval-a/with_skill/outputs", "eval-a/without_skill/outputs"]);
    writeFileSync(join(root, "eval-a/with_skill/outputs/result.md"), "ok");
    writeFileSync(join(root, "eval-a/without_skill/outputs/result.md"), "ok");

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  });
});

test("多个评测目录的问题按目录逐个累积并带各自目录名", () => {
  withWorkspace((root) => {
    makeDirs(root, [
      "eval-a/with_skill/run-1",
      "eval-b/without_skill/run-1",
    ]);

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, false);
    assert.equal(result.evalCount, 2);
    assert.deepEqual(result.issues, [
      {
        evalDir: "eval-a",
        issue: "缺少基线运行产物（without_skill 或 old_skill）",
      },
      { evalDir: "eval-b", issue: "缺少 with_skill 的运行产物" },
    ]);
  });
});

test("断链符号链接被跳过并作为一条 issue 返回，不再让整个守卫抛错", (t) => {
  // 台账第 1 条（已修）：sortedDirs 改用 lstat 判定目录项，断链链接跳过并记一条问题，
  // 守卫仍按契约返回 { valid:false, issues:[...] }，不再抛 ENOENT。
  withWorkspace((root) => {
    const linkPath = join(root, "eval-broken");
    const missingTarget = join(root, "does-not-exist");

    // 断链链接在部分 Windows 上需要符号链接权限：先试 junction（通常免权限），
    // 再试文件链接；两种都建不出来就跳过，绝不因为构造不出场景而假通过。
    let lastError;
    let created = false;
    for (const type of ["junction", "file"]) {
      try {
        symlinkSync(missingTarget, linkPath, type);
        created = true;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!created) {
      t.skip(`当前环境无法创建符号链接（${lastError?.code ?? "unknown"}）`);
      return;
    }

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, false);
    assert.equal(result.evalCount, 0);
    // 跳过项单独成一条 issue：带目录项名与中文原因（不可解析 / 已跳过）。
    const skipped = result.issues.filter((issue) => issue.evalDir === "eval-broken");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].issue, /不可解析/);
    assert.match(skipped[0].issue, /已跳过/);
    // 跳过之后没有可用评测目录，原有「缺评测目录」的问题仍按规则报出。
    assert.deepEqual(
      result.issues.map((issue) => issue.issue),
      [
        skipped[0].issue,
        "未找到 eval-* 评测目录（应为含 with_skill 与基线运行的评测目录）",
      ],
    );
  });
});

test("指向目录的合法符号链接仍算作 eval / run 目录", (t) => {
  // 缺陷 1 的修复不能顺手把「指向目录的合法链接」判成非目录（那是新的回归）：
  // eval 目录本身、以及 eval 下的 with_skill 配置目录都允许是指向真实目录的链接。
  withWorkspace((root) => {
    makeDirs(root, [
      "real-eval/with_skill/run-1",
      "real-eval/without_skill/run-1",
      "eval-b/without_skill/run-1",
    ]);

    // 目录链接在部分 Windows 上需要权限：junction 通常免权限，退回 dir 类型。
    let lastError;
    const created = [
      [join(root, "real-eval"), join(root, "eval-link")],
      [join(root, "real-eval", "with_skill"), join(root, "eval-b", "with_skill")],
    ].map(([target, link]) => {
      for (const type of ["junction", "dir"]) {
        try {
          symlinkSync(target, link, type);
          return true;
        } catch (error) {
          lastError = error;
        }
      }
      return false;
    });
    if (!created.every(Boolean)) {
      t.skip(`当前环境无法创建目录符号链接（${lastError?.code ?? "unknown"}）`);
      return;
    }

    const result = validateComparisonWorkspace(root);

    assert.equal(result.valid, true);
    // 链接目录 eval-link 与真实目录 eval-b 都应被当作评测目录。
    assert.equal(result.evalCount, 2);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.foundConfigs, ["with_skill", "without_skill"]);
    assert.equal(result.searchRoot, root);
  });
});
