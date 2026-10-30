/**
 * `lib/gold-standards` 的金标准存取行为（迁自上游 `test/gold-standards.test.ts`）。
 *
 * 全部写入都落在 `os.tmpdir()` 下的临时目录，`finally` 里清理，不触碰真实用户目录。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  addGoldStandard,
  getGoldAdvice,
  listGoldStandards,
  removeGoldStandard,
} from "../dist/lib/gold-standards.js";

/**
 * 在临时目录里跑一次金标准写入，并把存储路径设到二级子目录（顺带覆盖
 * `mkdirSync(..., { recursive: true })` 的建目录路径）。
 *
 * @param {(storePath: string) => unknown} fn 在临时目录上执行的断言回调
 * @returns {unknown} 回调的返回值
 */
const withStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "skill-creator-gold-"));
  try {
    return fn(join(dir, "nested", "gold-standards.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("addGoldStandard 落盘后 listGoldStandards 按通过率降序返回", () => {
  withStore((storePath) => {
    const weaker = addGoldStandard(storePath, {
      skillName: "cleanup-skill",
      description: "Use when cleaning project artifacts.",
      passRate: 0.8,
      notes: "Good but too broad.",
    });
    const stronger = addGoldStandard(storePath, {
      skillName: "skill-creator",
      description: "Use when creating or improving OpenCode skills.",
      passRate: 1,
    });

    assert.equal(typeof weaker.id, "string");
    assert.equal(typeof weaker.createdAt, "string");
    assert.deepEqual(listGoldStandards(storePath), [stronger, weaker]);
  });
});

test("addGoldStandard 只保留通过率最高的 50 条", () => {
  withStore((storePath) => {
    for (let i = 0; i < 55; i += 1) {
      addGoldStandard(storePath, {
        skillName: `skill-${i}`,
        description: `Description ${i}`,
        passRate: i / 100,
      });
    }

    const standards = listGoldStandards(storePath);
    assert.equal(standards.length, 50);
    assert.equal(standards[0].skillName, "skill-54");
    assert.equal(standards.at(-1)?.skillName, "skill-5");
  });
});

test("addGoldStandard 拒绝非有限值与越界的通过率", () => {
  withStore((storePath) => {
    for (const passRate of [Number.NaN, Infinity, -0.01, 1.01]) {
      assert.throws(
        () =>
          addGoldStandard(storePath, {
            skillName: "skill-creator",
            description: "Use when creating OpenCode skills.",
            passRate,
          }),
        /passRate must be a finite number between 0 and 1/,
      );
    }
  });
});

test("listGoldStandards 报出损坏 JSON 时带上存储路径", () => {
  withStore((storePath) => {
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, "not json");

    // 错误信息必须逐字带上完整存储路径，才能定位是哪份存储坏了。
    assert.throws(
      () => listGoldStandards(storePath),
      (error) =>
        error instanceof Error &&
        error.message ===
          `Failed to read gold standards store at ${storePath}: malformed JSON`,
    );
  });
});

test("getGoldAdvice 返回标题与最多五条含技能名和描述的示例", () => {
  withStore((storePath) => {
    for (let i = 0; i < 6; i += 1) {
      addGoldStandard(storePath, {
        skillName: `skill-${i}`,
        description: `Use when handling case ${i}.`,
        passRate: 1 - i / 10,
        notes: i === 0 ? "Strong positive example." : undefined,
      });
    }

    const advice = getGoldAdvice(storePath);

    assert.ok(advice.includes("GOLD STANDARD EXAMPLES:"));
    assert.ok(
      advice.includes(
        "- skill-0 (100%): Use when handling case 0. Notes: Strong positive example.",
      ),
    );
    assert.ok(advice.includes("- skill-4 (60%): Use when handling case 4."));
    assert.ok(!advice.includes("skill-5"));
  });
});

test("没有任何金标准时 getGoldAdvice 返回空串", () => {
  withStore((storePath) => {
    assert.equal(getGoldAdvice(storePath), "");
  });
});

test("removeGoldStandard 按 id 删除", () => {
  withStore((storePath) => {
    const standard = addGoldStandard(storePath, {
      skillName: "skill-creator",
      description: "Use when creating OpenCode skills.",
      passRate: 1,
    });

    assert.equal(removeGoldStandard(storePath, standard.id), true);
    assert.equal(removeGoldStandard(storePath, standard.id), false);
    assert.deepEqual(listGoldStandards(storePath), []);
  });
});

test("存储不是数组或记录缺必需字段时抛带存储路径的结构错误", () => {
  // 台账第 3 条（已修）：readStore 在解析处就校验结构，错误带存储路径与下标，
  // 不再漂到 sortStandards 的展开处变成一个与文件无关的 TypeError。
  withStore((storePath) => {
    mkdirSync(dirname(storePath), { recursive: true });

    const cases = [
      { label: "空对象", content: "{}", expected: /expected a JSON array, got object/ },
      { label: "null", content: "null", expected: /expected a JSON array, got null/ },
      {
        label: "数组里的记录缺必需字段",
        content: JSON.stringify([{ id: "only-id" }]),
        expected: /invalid record at index 0/,
      },
    ];
    const prefix = `Failed to read gold standards store at ${storePath}:`;

    for (const { label, content, expected } of cases) {
      writeFileSync(storePath, content);

      for (const call of [
        () => listGoldStandards(storePath),
        () => getGoldAdvice(storePath),
      ]) {
        assert.throws(
          call,
          (error) =>
            error instanceof Error &&
            !(error instanceof TypeError) &&
            error.message.startsWith(prefix) &&
            expected.test(error.message),
          label,
        );
      }
    }
  });
});
