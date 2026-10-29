/**
 * `lib/workflow-guard` 的对比评测工作区校验行为。
 *
 * 上游 `.tmp/old/plugin/test/` 没有该模块的测试，本文件按模块对外行为补覆盖：
 * 路径不存在/不是目录、无 `eval-*` 目录、`runs/` 嵌套布局、成对运行缺失的两类
 * 问题、`outputs/` 作为运行产物的兜底，以及 `foundConfigs` 的去重排序。
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
      { evalDir: "nope", issue: "workspace path does not exist" },
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
      { evalDir: "plain.txt", issue: "workspace path is not a directory" },
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
      "no eval-* directories found (expected evals with with_skill and baseline runs)",
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
      { evalDir: "eval-a", issue: "missing with_skill run outputs" },
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
      { evalDir: "eval-a", issue: "missing with_skill run outputs" },
      {
        evalDir: "eval-a",
        issue: "missing baseline run outputs (without_skill or old_skill)",
      },
    ]);
    assert.deepEqual(result.foundConfigs, []);
  });
});

test("只有 outputs 目录也算有过运行产物", () => {
  // 钉住上游现状（台账第 2 条：空 outputs/ 也算「有运行」），修复本缺陷时须同步改此用例。
  withWorkspace((root) => {
    makeDirs(root, ["eval-a/with_skill/outputs", "eval-a/without_skill/outputs"]);

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
        issue: "missing baseline run outputs (without_skill or old_skill)",
      },
      { evalDir: "eval-b", issue: "missing with_skill run outputs" },
    ]);
  });
});

test("钉住上游缺口：断链符号链接让 statSync 抛 ENOENT（修复本缺陷时须同步改此用例）", (t) => {
  // 台账第 1 条：sortedDirs 的 statSync 会跟随链接，目标不存在时直接抛错，
  // 而不是把「无法解析的目录项」作为一条 issue 返回。
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

    // 现状：整个调用抛出 ENOENT，`valid`/`issues` 契约失效。
    assert.throws(
      () => validateComparisonWorkspace(root),
      (error) => error instanceof Error && error.code === "ENOENT",
    );
  });
});
