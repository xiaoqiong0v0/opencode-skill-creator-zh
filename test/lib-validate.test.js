/**
 * `lib/validate` 的 SKILL.md 校验行为（迁自上游 `test/validate.test.ts`）。
 *
 * 覆盖：引号/普通标量/块标量描述、未引号取值含 `: ` 或结尾冒号的失败路径与其
 * 提示语、行号定位、CRLF 整篇文档，以及随包技能 fixture。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { validateSkill } from "../dist/lib/validate.js";

/** 随包分发的技能目录（校验它必须通过）。 */
const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../skill", import.meta.url));

/**
 * 在临时目录里写一份 LF 的 SKILL.md 并执行回调。
 *
 * @param {string} frontmatter frontmatter 正文（不含 `---` 分隔符）
 * @param {(skillPath: string) => unknown} fn 在临时目录上执行的断言回调
 * @returns {unknown} 回调的返回值
 */
const withSkill = (frontmatter, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "skill-creator-validate-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\n${frontmatter}\n---\n\n# Test Skill\n`,
    );
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * 同上，但整篇文档（含 frontmatter 分隔符）都写成 CRLF。
 *
 * Windows 检出（core.autocrlf=true）会把每一处换行都写成 CRLF；这里整篇按 CRLF
 * 生成，让 fixture 里不存在任何裸 LF，避免测试因偶然的 LF 而「假通过」。
 *
 * @param {string} frontmatter frontmatter 正文（不含 `---` 分隔符）
 * @param {(skillPath: string) => unknown} fn 在临时目录上执行的断言回调
 * @returns {unknown} 回调的返回值
 */
const withCrlfSkill = (frontmatter, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "skill-creator-validate-"));
  try {
    mkdirSync(dir, { recursive: true });
    const contents = `---\n${frontmatter}\n---\n\n# Test Skill\n`
      .split("\n")
      .join("\r\n");
    // fixture 自检：既没有裸 LF，也没有孤立 CR（整篇都是 CRLF）。
    const stripped = contents.replace(/\r\n/g, "");
    assert.equal(stripped.includes("\n"), false);
    assert.equal(stripped.includes("\r"), false);
    writeFileSync(join(dir, "SKILL.md"), contents);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("引号包住的描述含「冒号+空格」可以通过", () => {
  withSkill(
    `name: pdf-reader
description: "Use for PDF files: reading, extracting."`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});

test("未加引号但含「冒号+空格」的描述可以通过", () => {
  withSkill(
    `name: pdf-reader
description: Use for PDF files, reading and extracting.`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});

test("随包技能 fixture 通过校验", () => {
  assert.deepEqual(validateSkill(BUNDLED_SKILL_DIR), {
    valid: true,
    message: "技能校验通过",
  });
});

test("未引号描述含「冒号+空格」失败并给出加引号提示", () => {
  withSkill(
    `name: pdf-reader
description: Use for PDF files: reading, extracting.`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("description"));
      assert.ok(result.message.includes("第 3 行"));
      assert.ok(result.message.includes("改法：给取值加引号"));
      assert.ok(result.message.includes('description: "你的文本"'));
      assert.ok(result.message.includes("含「: 」或以冒号结尾"));
      assert.ok(result.message.includes("会被运行时丢弃"));
    },
  );
});

test("单引号包住的描述含「冒号+空格」可以通过", () => {
  withSkill(
    `name: pdf-reader
description: 'Use for PDF files: reading, extracting.'`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});

test("块标量正文里含「冒号+空格」可以通过", () => {
  withSkill(
    `name: pdf-reader
description: |2-
  Use for PDF files: reading, extracting.`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});

test("未引号取值中段出现「冒号+空格」失败", () => {
  withSkill(
    `name: pdf-reader
description: Use when reading docs.
compatibility: Works with docs: markdown and PDF`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("compatibility"));
      assert.ok(result.message.includes("第 4 行"));
    },
  );
});

test("未引号取值以冒号结尾时失败", () => {
  withSkill(
    `name: pdf-reader
description: Note:`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("description"));
      assert.ok(result.message.includes("第 3 行"));
      assert.ok(result.message.includes("改法：给取值加引号"));
    },
  );
});

test("未引号取值去掉尾部空格后以冒号结尾仍失败（ends-with-colon 分支）", () => {
  withSkill(
    `name: pdf-reader
description: Note: `,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("description"));
      assert.ok(result.message.includes("第 3 行"));
      assert.ok(result.message.includes("改法：给取值加引号"));
    },
  );
});

test("未引号取值含「冒号+制表符」失败", () => {
  withSkill(
    `name: pdf-reader
description: Use for PDF files:\treading`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("description"));
      assert.ok(result.message.includes("第 3 行"));
    },
  );
});

test("未引号 name 含「冒号+空格」在命名校验之前就失败", () => {
  withSkill(
    `name: pdf: reader
description: Use when reading docs.`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("name"));
      assert.ok(result.message.includes("第 2 行"));
      assert.ok(result.message.includes("改法：给取值加引号"));
    },
  );
});

test("CRLF frontmatter 通过校验", () => {
  withCrlfSkill(
    `name: pdf-reader
description: "Use for PDF files: reading, extracting."`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});

test("CRLF 块标量描述通过校验", () => {
  withCrlfSkill(
    `name: pdf-reader
description: |2-
  Use for PDF files: reading, extracting.`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});

test("CRLF 下未引号的「冒号+空格」仍然失败且行号正确", () => {
  withCrlfSkill(
    `name: pdf-reader
description: Use for PDF files: reading, extracting.`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("description"));
      assert.ok(result.message.includes("第 3 行"));
      assert.ok(result.message.includes("改法：给取值加引号"));
    },
  );
});

test("大写开头的顶层键报错并给出正确写法", () => {
  // 台账第 4 条（已修）：宽松顶层键探测会把 `Allowed-tools:` 收进来，键名不合规时
  // 报错并提示小写写法，不再静默丢弃后报「通过」。
  withSkill(
    `name: pdf-reader
description: Use when reading documents.
Allowed-tools: "*"`,
    (skillPath) => {
      const result = validateSkill(skillPath);

      assert.equal(result.valid, false);
      assert.ok(result.message.includes("不合规的顶层键"));
      assert.ok(result.message.includes("Allowed-tools"));
      assert.ok(result.message.includes("应写作 allowed-tools"));
    },
  );
});

test("大小写正确的 allowed-tools 键仍然通过", () => {
  // 与上一条配对：修复不能把合法键一起判错。
  withSkill(
    `name: pdf-reader
description: Use when reading documents.
allowed-tools: "*"`,
    (skillPath) => {
      assert.deepEqual(validateSkill(skillPath), {
        valid: true,
        message: "技能校验通过",
      });
    },
  );
});
