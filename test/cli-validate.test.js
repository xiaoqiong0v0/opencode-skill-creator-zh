/**
 * `skill_zh validate` 的结论、逐条改法与 `--strict` 升级行为（docs/SPEC.md R2 / docs/tools.md `validate` 一节）。
 *
 * 全部在系统临时目录里跑；每条问题都要能指到 `文件:行`（能定位时）并给出可照做的改法。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dispatch, runCommand } from "../dist/cli/dispatch.js";
import { parseArgs } from "../dist/cli/parse-args.js";

/**
 * 在临时根下执行用例，结束时删掉整个根。
 *
 * @param {(root: string) => unknown} fn 用例体，拿到临时根路径
 * @returns 用例体的返回值
 */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "skill-creator-validate-cli-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 构造分发上下文：项目目录即临时根。
 *
 * @param root 临时根路径
 * @returns 分发表需要的上下文
 */
function ctxOf(root) {
  return { directory: root, worktree: root };
}

/**
 * 在临时根下写一个技能目录（含 `references/` 与 SKILL.md）。
 *
 * @param root 临时根路径
 * @param dirName 技能目录名
 * @param frontmatter frontmatter 正文（不含 `---` 分隔符）
 * @returns 技能目录绝对路径
 */
function writeSkill(root, dirName, frontmatter) {
  const skillDir = join(root, dirName);
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# 测试技能\n`, "utf-8");
  return skillDir;
}

/** 把路径统一成 `/` 分隔，便于拼进 `args` 字符串与断言。 */
const toDisplay = (path) => path.replaceAll("\\", "/");

test("合规技能：结论为通过，并输出 description 实际字符数", () => {
  withTempRoot((root) => {
    const description = "把接口文档的更新流程固化成可复用步骤";
    const skillDir = writeSkill(root, "demo-skill", `name: demo-skill\ndescription: ${description}`);

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, true, result.output);
    assert.ok(result.output.startsWith("校验 "), result.output);
    assert.ok(result.output.includes("：通过"), result.output);
    assert.ok(result.output.includes(`description  ${[...description].length} 字符（上限 1024）`), result.output);
  });
});

test("缺 name：判未通过，改法给出要补的那一行", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", "description: 只有描述没有名字");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("：未通过（1 处错误）"), result.output);
    assert.ok(result.output.includes("问题：frontmatter 缺少必填字段 name"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("name: demo-skill"), result.output);
    assert.ok(result.output.includes("文件：") && result.output.includes("SKILL.md"), result.output);
  });
});

test("description 超长：缺省只提示（仍通过），--strict 判失败并定位到行", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", `name: demo-skill\ndescription: ${"a".repeat(1030)}`);
    const args = `validate "${toDisplay(skillDir)}"`;

    const lenient = runCommand(parseArgs(args), ctxOf(root));
    assert.equal(lenient.ok, true, lenient.output);
    assert.ok(lenient.output.includes("：通过"), lenient.output);
    assert.ok(lenient.output.includes("提示（1 处"), lenient.output);
    assert.ok(lenient.output.includes("加 --strict"), lenient.output);

    const strict = runCommand(parseArgs(`${args} --strict`), ctxOf(root));
    assert.equal(strict.ok, false);
    assert.ok(strict.output.includes("：未通过（1 处错误）"), strict.output);
    assert.ok(strict.output.includes("问题：description 超长：1030 字符，上限 1024 字符"), strict.output);
    // description 在文件第 3 行（第 1 行 ---、第 2 行 name）。
    assert.ok(strict.output.includes("SKILL.md:3"), strict.output);
  });
});

test("目录名与 name 不一致：判未通过，改法给出两种改法", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: other-skill\ndescription: 名字与目录不一致");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("目录名与 frontmatter name 不一致"), result.output);
    assert.ok(result.output.includes("重命名为 other-skill"), result.output);
    assert.ok(result.output.includes("name 改为 demo-skill"), result.output);
  });
});

test("非 kebab 名：缺省只提示（仍通过），--strict 判失败", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "Bad_Skill", "name: Bad_Skill\ndescription: 命名不规范但目录一致");
    const args = `validate "${toDisplay(skillDir)}"`;

    const lenient = runCommand(parseArgs(args), ctxOf(root));
    assert.equal(lenient.ok, true, lenient.output);
    assert.ok(lenient.output.includes("不是 kebab-case"), lenient.output);
    assert.ok(lenient.output.includes("bad-skill"), lenient.output);

    const strict = runCommand(parseArgs(`${args} --strict`), ctxOf(root));
    assert.equal(strict.ok, false);
    assert.ok(strict.output.includes("：未通过（1 处错误）"), strict.output);
  });
});

test("缺 SKILL.md：判未通过并给出可照做的补文件改法", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(skillDir, { recursive: true });

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("问题：SKILL.md 不存在"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("新建 SKILL.md"), result.output);
  });
});

test("缺参返回三段式并给示例", () => {
  withTempRoot((root) => {
    const lines = dispatch("validate", ctxOf(root)).split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：缺少参数 <技能目录>");
    assert.ok(lines[1].startsWith("改法：运行 skill_zh validate "), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
  });
});

test("技能目录不存在返回三段式并给改法", () => {
  withTempRoot((root) => {
    const lines = dispatch("validate ./skills/missing-skill", ctxOf(root)).split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：技能目录不存在：./skills/missing-skill");
    assert.ok(lines[1].includes("skill_zh new"), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
  });
});

test("目录名不是 kebab-case 时，路径不存在的改法不再建议用这个非法名新建", () => {
  withTempRoot((root) => {
    const lines = dispatch("validate ./skills/My_Skill", ctxOf(root)).split("\n");

    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("错误：技能目录不存在："), lines[0]);
    assert.ok(!lines[1].includes("skill_zh new My_Skill"), `改法建议了非法名：${lines[1]}`);
    assert.ok(lines[1].includes("kebab-case"), lines[1]);
    assert.ok(lines[1].includes("skill_zh new my-skill"), lines[1]);
  });
});

test("SKILL.md 没有 frontmatter：指出第 1 行问题并给补法", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# 只有正文，没有 frontmatter\n", "utf-8");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("问题：SKILL.md 开头没有 frontmatter（第 1 行必须是 ---）"), result.output);
    assert.ok(result.output.includes("SKILL.md:1"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("第 1 行改成 ---"), result.output);
  });
});

test("frontmatter 未闭合：指出缺结束分隔符并给补法", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\n", "utf-8");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("问题：frontmatter 不完整：找不到结束的 ---"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("补一行 ---"), result.output);
  });
});

test("frontmatter 含未知键：点名该键并列出允许键", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: demo-skill\ndescription: 正常描述\nversion: 1");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("问题：frontmatter 含不支持的键：version"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("license"), result.output);
  });
});

test("frontmatter 取值含「: 」且未加引号：指出所在行并给引号改法", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: demo-skill\ndescription: 提示: 先把步骤写清");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("取值不是合法 YAML"), result.output);
    assert.ok(result.output.includes("SKILL.md:3"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("双引号"), result.output);
  });
});

test("缺 description：给出一条能照抄的补字段改法", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: demo-skill");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("问题：frontmatter 缺少必填字段 description"), result.output);
    assert.ok(result.output.includes('改法：') && result.output.includes('description: "'), result.output);
  });
});

test("错误与提示一次列全：提示不会因为存在错误被吞掉", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "Demo_Skill", "name: Demo_Skill\nversion: 1");

    const result = runCommand(parseArgs(`validate "Demo_Skill"`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.ok(result.output.includes("：未通过（2 处错误，1 处提示）"), result.output);
    assert.ok(result.output.includes("[错误 1] 问题：frontmatter 含不支持的键：version"), result.output);
    assert.ok(result.output.includes("[错误 2] 问题：frontmatter 缺少必填字段 description"), result.output);
    assert.ok(result.output.includes("[提示 1] 问题：name「Demo_Skill」不是 kebab-case"), result.output);
  });
});
