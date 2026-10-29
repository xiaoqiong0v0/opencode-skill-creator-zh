/**
 * `lib/utils` 的 frontmatter 读取行为（迁自上游 `test/utils.test.ts`）。
 *
 * 覆盖受控块标量子集：字面量/折叠、显式缩进与截断指示符的四种组合、空行与
 * 缩进更深的行、CRLF 归一化范围，以及块边界与空块。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseSkillMd } from "../dist/lib/utils.js";

/**
 * 用显式行数组写一份 SKILL.md，保证磁盘上的字节正是下面期望值所假定的内容
 * （没有隐藏的尾部换行差异）。
 *
 * @param {string[]} lines frontmatter 的各个行（不含自动补的末尾换行）
 * @param {(skillPath: string) => unknown} fn 在临时目录上执行的断言回调
 * @returns {unknown} 回调的返回值
 */
function withSkillLines(lines, fn) {
  const dir = mkdtempSync(join(tmpdir(), "skill-creator-utils-"));
  try {
    writeFileSync(join(dir, "SKILL.md"), `${lines.join("\n")}\n`);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CLOSE = ["---", ""];

// 期望值锚定自已安装的 `yaml@2.9.1` 参考实现（只读），不是从旧实现反推的。

test("字面量块保留换行与空行", () => {
  withSkillLines(
    [
      "---",
      "name: pdf-reader",
      "description: |",
      "  First line.",
      "",
      "  Second line",
      "license: MIT",
      ...CLOSE,
    ],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "First line.\n\nSecond line\n",
      );
      assert.equal(parseSkillMd(skillPath).name, "pdf-reader");
    },
  );
});

test("折叠块合并相邻行，并把空行保留为换行", () => {
  withSkillLines(
    [
      "---",
      "name: pdf-reader",
      "description: >",
      "  folded one",
      "  folded two",
      "",
      "  third line",
      ...CLOSE,
    ],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "folded one folded two\nthird line\n",
      );
    },
  );
});

test("显式缩进指示符两种顺序都能解析（|2- 与 |-2）", () => {
  withSkillLines(
    [
      "---",
      "name: s",
      "description: |2-",
      "  Indented one",
      "  Indented two",
      ...CLOSE,
    ],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "Indented one\nIndented two",
      );
    },
  );
  withSkillLines(
    [
      "---",
      "name: s",
      "description: |-2",
      "  Indented one",
      "  Indented two",
      ...CLOSE,
    ],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "Indented one\nIndented two",
      );
    },
  );
});

test("显式缩进加折叠截断两种顺序都能解析（>2+ 与 >+2）", () => {
  withSkillLines(
    ["---", "name: s", "description: >2+", "  a", "  b", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "a b\n");
    },
  );
  withSkillLines(
    ["---", "name: s", "description: >+2", "  a", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "a b\n");
    },
  );
});

test("字面量 clip 恰好保留一个末尾换行；显式 |2 clip 亦然", () => {
  withSkillLines(
    ["---", "name: s", "description: |", "  a", "  b", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "a\nb\n");
    },
  );
  withSkillLines(
    ["---", "name: s", "description: |2", "  a", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "a\nb\n");
    },
  );
});

test("strip 截断去掉尾部换行，keep 全部保留", () => {
  withSkillLines(
    ["---", "name: s", "description: |-", "  a", "  b", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "a\nb");
    },
  );
  withSkillLines(
    ["---", "name: s", "description: >2-", "  a", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "a b");
    },
  );
  // 没有显式尾部空行的 keep 块只多出内容行自己的那个换行。
  withSkillLines(
    ["---", "name: s", "description: |+", "  only", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "only\n");
    },
  );
  // keep 保留内容之后的每个空行：内容行自己的换行再加每个空行一个（逐字节基准：
  // 结果应为 only\n\n）。
  withSkillLines(
    ["---", "name: s", "description: |+", "  only", "", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "only\n\n");
    },
  );
  withSkillLines(
    ["---", "name: s", "description: |+", "  only", "", "", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "only\n\n\n");
    },
  );
});

test("纯空行的 keep 块恰好保留它的空行数", () => {
  // 逐字节基准：无内容但有一个空行的 keep 块就是一个换行；纯空行的 clip/strip 块为空。
  withSkillLines(["---", "name: s", "description: |+", "", ...CLOSE], (p) => {
    assert.equal(parseSkillMd(p).description, "\n");
  });
  withSkillLines(["---", "name: s", "description: >+", "", ...CLOSE], (p) => {
    assert.equal(parseSkillMd(p).description, "\n");
  });
  withSkillLines(["---", "name: s", "description: |", "", ...CLOSE], (p) => {
    assert.equal(parseSkillMd(p).description, "");
  });
  withSkillLines(["---", "name: s", "description: |-", "", ...CLOSE], (p) => {
    assert.equal(parseSkillMd(p).description, "");
  });
});

test("strip 截断保留内部空行", () => {
  withSkillLines(
    ["---", "name: s", "description: >-", "  a", "", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "a\nb");
    },
  );
  withSkillLines(
    ["---", "name: s", "description: |-", "  a", "", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "a\n\nb");
    },
  );
});

test("缩进更深的行在字面量与折叠块中都保留缩进与换行", () => {
  withSkillLines(
    [
      "---",
      "name: s",
      "description: |",
      "  a",
      "    more indented",
      "  b",
      ...CLOSE,
    ],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "a\n  more indented\nb\n",
      );
    },
  );
  withSkillLines(
    [
      "---",
      "name: s",
      "description: >",
      "  a",
      "    more indented",
      "  b",
      ...CLOSE,
    ],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "a\n  more indented\nb\n",
      );
    },
  );
  // 折叠块里「段落空行 + 缩进更深的行」：空行的换行与更深行自己的缩进都要保留。
  withSkillLines(
    ["---", "name: s", "description: >", "  a", "", "    indented", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(
        parseSkillMd(skillPath).description,
        "a\n\n  indented\nb\n",
      );
    },
  );
});

test("字面量块保留行尾空格", () => {
  withSkillLines(
    ["---", "name: s", "description: |", "  a  ", "  b", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "a  \nb\n");
    },
  );
});

test("多个字面量段落保留两处换行并带 clip 的末尾换行", () => {
  withSkillLines(
    ["---", "name: s", "description: |", "  p1", "", "  p2", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "p1\n\np2\n");
    },
  );
});

test("字面量块内的首个空行被保留", () => {
  withSkillLines(
    ["---", "name: s", "description: |", "", "  a", ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "\na\n");
    },
  );
});

test("块标量在相邻同级键处结束", () => {
  withSkillLines(
    ["---", "name: s", "description: |", "  a", "  b", "license: MIT", ...CLOSE],
    (skillPath) => {
      const meta = parseSkillMd(skillPath);
      assert.equal(meta.description, "a\nb\n");
      assert.equal(meta.name, "s");
    },
  );
});

test("空块标量得到空描述", () => {
  withSkillLines(
    ["---", "name: s", "description: |", "license: MIT", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "");
    },
  );
});

test("CRLF 字面量块只在取值上归一化，不改动 fullContent", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-creator-utils-crlf-"));
  try {
    const raw =
      "---\r\nname: s\r\ndescription: |\r\n  line a\r\n  line b\r\n---\r\n\r\n# T\r\n";
    writeFileSync(join(dir, "SKILL.md"), raw);
    const meta = parseSkillMd(dir);
    assert.equal(meta.description, "line a\nline b\n");
    // fullContent 是原始字节，CRLF 原样保留。
    assert.equal(meta.fullContent, raw);
    assert.equal(meta.fullContent.includes("\r\n"), true);
    // 重新读盘确认文件没有被改写。
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("单行引号与普通标量描述是未受影响的对照组", () => {
  withSkillLines(
    ["---", "name: s", 'description: "Use for: x, y."', ...CLOSE],
    (skillPath) => {
      assert.equal(parseSkillMd(skillPath).description, "Use for: x, y.");
    },
  );
  withSkillLines(
    ["---", "name: s", "description: plain text", ...CLOSE],
    (p) => {
      assert.equal(parseSkillMd(p).description, "plain text");
    },
  );
});

test("不是块标量头部的取值不会被当成块标量", () => {
  // 普通标量里的一个 `|` 不能被误认成头部。
  withSkillLines(["---", "name: s", "description: a | b", ...CLOSE], (p) => {
    assert.equal(parseSkillMd(p).description, "a | b");
  });
});
