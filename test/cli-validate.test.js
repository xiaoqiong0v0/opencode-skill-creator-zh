/**
 * `skill_zh validate` 的结论、逐条改法与 `--strict` 升级行为（docs/SPEC.md R2 / docs/tools.md `validate` 一节）。
 *
 * 全部在系统临时目录里跑；每条问题都要能指到 `文件:行`（能定位时）并给出可照做的改法。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { dispatch, runCommand } from "../dist/cli/dispatch.js";
import { parseArgs } from "../dist/cli/parse-args.js";

import { MOCK_EXPORTS_KEY } from "./helpers/mock-module.js";

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

test("description 仍是占位（开头 TODO: / 待填: / 整体等于模板原文）：缺省只提示，--strict 判失败", () => {
  withTempRoot((root) => {
    const placeholders = [
      "TODO: 用一句话写清做什么 + 何时触发 + 不适用",
      "待填：这个技能做什么、什么时候用",
      "todo: 小写 + 半角冒号也算",
      // 整体等于模板占位原文（与 `templates/skill-md.md` 渲染值逐字一致）。
      "TODO: 用一句话写清做什么 + 何时触发 + 不适用，≤ 60 字符",
    ];
    for (const description of placeholders) {
      const skillDir = writeSkill(root, "demo-skill", `name: demo-skill\ndescription: "${description}"`);
      const args = `validate "${toDisplay(skillDir)}"`;

      const lenient = runCommand(parseArgs(args), ctxOf(root));
      assert.equal(lenient.ok, true, lenient.output);
      assert.ok(lenient.output.includes("：通过"), lenient.output);
      assert.ok(lenient.output.includes("提示（1 处"), lenient.output);
      assert.ok(lenient.output.includes("description 仍是占位文案"), lenient.output);

      const strict = runCommand(parseArgs(`${args} --strict`), ctxOf(root));
      assert.equal(strict.ok, false, strict.output);
      assert.ok(strict.output.includes("：未通过（1 处错误）"), strict.output);
      assert.ok(strict.output.includes("description 仍是占位文案"), strict.output);
    }
  });
});

test("占位判据只锚定开头：description 中间出现 TODO / 待填 的合法技能在 --strict 下通过", () => {
  withTempRoot((root) => {
    const legit = [
      "管理 TODO 清单，支持增删改查",
      "处理等待填写的审批表单",
      "教用户给代码写 TODO 注释",
    ];
    for (const description of legit) {
      const skillDir = writeSkill(root, "demo-skill", `name: demo-skill\ndescription: "${description}"`);
      const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}" --strict`), ctxOf(root));

      assert.equal(result.ok, true, `${description} → ${result.output}`);
      assert.ok(result.output.includes("：通过"), result.output);
      assert.ok(!result.output.includes("description 仍是占位文案"), result.output);
    }
  });
});

test("只查 description：正文里的 TODO / 待填 与单词内部的 todo 都不报占位", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", `name: demo-skill\ndescription: 把待办事项拆成可执行步骤`);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: demo-skill",
        "description: 把待办事项拆成可执行步骤",
        "---",
        "",
        "# 测试技能",
        "",
        "TODO: 把本节补完（正文占位不参与校验）",
        "待填：示例待补充",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}" --strict`), ctxOf(root));
    assert.equal(result.ok, true, result.output);
    assert.ok(result.output.includes("：通过"), result.output);
    assert.ok(!result.output.includes("description 仍是占位文案"), result.output);

    // 中间出现：mastodon 里含 "todo" 子串，但不是开头占位形态。
    const wordDir = writeSkill(root, "word-skill", `name: word-skill\ndescription: 对标 mastodon 的联邦时间线整理`);
    const wordResult = runCommand(parseArgs(`validate "${toDisplay(wordDir)}" --strict`), ctxOf(root));
    assert.equal(wordResult.ok, true, wordResult.output);
    assert.ok(!wordResult.output.includes("description 仍是占位文案"), wordResult.output);
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

test("缺参返回三段式并给示例", async () => {
  await withTempRoot(async (root) => {
    const lines = (await dispatch("validate", ctxOf(root))).split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：缺少参数 <技能目录>");
    assert.ok(lines[1].startsWith("改法：运行 skill_zh validate "), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
  });
});

test("技能目录不存在返回三段式并给改法", async () => {
  await withTempRoot(async (root) => {
    const lines = (await dispatch("validate ./skills/missing-skill", ctxOf(root))).split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：技能目录不存在：./skills/missing-skill");
    assert.ok(lines[1].includes("skill_zh new"), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
  });
});

test("目录名不是 kebab-case 时，路径不存在的改法不再建议用这个非法名新建", async () => {
  await withTempRoot(async (root) => {
    const lines = (await dispatch("validate ./skills/My_Skill", ctxOf(root))).split("\n");

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

test("SKILL.md 文件名不区分大小写：skill.md 等价", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "lower-case-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.md"),
      "---\nname: lower-case-skill\ndescription: 大小写测试\n---\n\n# T\n",
      "utf-8",
    );

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, true, result.output);
    assert.ok(result.output.includes("：通过"));
  });
});

/**
 * 统计一段文本里某个片段的出现次数。
 *
 * @param text 待搜索文本
 * @param fragment 要统计的片段
 * @returns 出现次数
 */
function countOf(text, fragment) {
  return text.split(fragment).length - 1;
}

/**
 * 与 `withTempRoot` 相同的临时目录与清理语义，但会等异步用例体跑完再删目录。
 *
 * @param {(root: string) => Promise<unknown>} fn 用例体
 * @returns {Promise<unknown>} 用例体的返回值
 */
async function withTempRootAsync(fn) {
  const root = mkdtempSync(join(tmpdir(), "skill-creator-validate-cli-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 每次替身导入换一个 query，避免命中上一次留下的模块实例。 */
let mockedImportSeq = 0;

/**
 * 在 `validateSkill` 被替换成固定结论的模块实例下跑用例。
 *
 * 这个文件顶部已经随 `dispatch` 用真实 lib 加载过 `cli/validate.js`，直接 `mock.module` 不会
 * 影响那份实例；这里先用带 query 的动态 import 取新实例，让它的 `../lib/validate.js` 依赖
 * 命中替身。用例结束（含抛错）后 `mock.restoreAll()`，不污染同文件其它用例。
 *
 * @param {string} message 替身返回的结论（CLI 扫描覆盖不到的类别）
 * @param {(validateHandler: Function) => void} fn 拿到新实例 handler 的用例体
 * @returns {Promise<void>}
 */
async function withMockedVerdict(message, fn) {
  mock.module("../dist/lib/validate.js", {
    [MOCK_EXPORTS_KEY]: { validateSkill: () => ({ valid: false, message }) },
  });
  try {
    const { validateHandler } = await import(`../dist/cli/validate.js?mocked-verdict-${mockedImportSeq++}`);
    await fn(validateHandler);
  } finally {
    mock.restoreAll();
  }
}

/** 造一条 CLI 扫描不认识的 lib 结论（用于验证「合并而不是二选一」）。 */
const UNCOVERED_LIB_MESSAGE = "frontmatter 含 2026-10-30 新增规则：示例字段必须存在";

test("lib 新增的未覆盖规则：本身合规的技能也判未通过并并入该条", async () => {
  await withTempRootAsync(async (root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: demo-skill\ndescription: 正常描述");

    // 对照：同一目录走真实 validateSkill 是合规的，说明下面的失败只来自替身，替身可控。
    const real = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));
    assert.equal(real.ok, true, real.output);
    assert.ok(!real.output.includes(UNCOVERED_LIB_MESSAGE), real.output);

    await withMockedVerdict(UNCOVERED_LIB_MESSAGE, (validateHandler) => {
      const result = validateHandler({ positionals: [skillDir], flags: {}, projectDir: root, ctx: ctxOf(root) });

      assert.equal(result.ok, false, result.output);
      assert.ok(result.output.includes("：未通过（1 处错误）"), result.output);
      assert.ok(result.output.includes(`问题：校验未通过：${UNCOVERED_LIB_MESSAGE}`), result.output);
      assert.equal(countOf(result.output, `校验未通过：${UNCOVERED_LIB_MESSAGE}`), 1, result.output);
    });
  });
});

test("已有 CLI 问题时 lib 的未覆盖规则仍并入（回退成「issues 为空才兜底」即变红）", async () => {
  await withTempRootAsync(async (root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: other-skill\ndescription: 正常描述");

    // 对照：真实 lib 对这份技能只报 name 不一致，没有替身那条结论。
    const real = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));
    assert.equal(real.ok, false, real.output);
    assert.ok(real.output.includes("目录名与 frontmatter name 不一致"), real.output);
    assert.ok(!real.output.includes(UNCOVERED_LIB_MESSAGE), real.output);

    await withMockedVerdict(UNCOVERED_LIB_MESSAGE, (validateHandler) => {
      const result = validateHandler({ positionals: [skillDir], flags: {}, projectDir: root, ctx: ctxOf(root) });

      assert.equal(result.ok, false, result.output);
      // CLI 那条与 lib 那条同时存在；旧口径（issues 非空就丢 lib）只有 1 处错误。
      assert.ok(result.output.includes("：未通过（2 处错误）"), result.output);
      assert.equal(countOf(result.output, "目录名与 frontmatter name 不一致"), 1, result.output);
      assert.equal(countOf(result.output, `校验未通过：${UNCOVERED_LIB_MESSAGE}`), 1, result.output);
    });
  });
});

test("大写键与其它问题并存：三条都出，大写键带行号、小写建议，且不重复", () => {
  withTempRoot((root) => {
    // 目录 bad-skill、name bad-skill-zh（不一致）、description 1208 字符（超长）、Allowed-tools 大写键。
    const description = "a".repeat(1208);
    const skillDir = writeSkill(
      root,
      "bad-skill",
      `name: bad-skill-zh\ndescription: ${description}\nAllowed-tools: "Read"`,
    );

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false, result.output);
    // 大写键与 name 不一致是错误，description 超长是提示：两套解析合并后仍是 2 + 1，没有重复条目。
    assert.ok(result.output.includes("：未通过（2 处错误，1 处提示）"), result.output);
    assert.ok(
      result.output.includes("[错误 1] 问题：frontmatter 第 4 行的顶层键「Allowed-tools」不合规"),
      result.output,
    );
    assert.ok(result.output.includes("SKILL.md:4"), result.output);
    assert.ok(result.output.includes("应写作 allowed-tools"), result.output);
    assert.ok(result.output.includes("目录名与 frontmatter name 不一致"), result.output);
    assert.ok(result.output.includes("description 超长：1208 字符"), result.output);

    assert.equal(countOf(result.output, "目录名与 frontmatter name 不一致"), 1, result.output);
    assert.equal(countOf(result.output, "description 超长：1208 字符"), 1, result.output);
    assert.equal(countOf(result.output, "顶层键「Allowed-tools」不合规"), 1, result.output);
  });
});

test("只放大写键：走逐条格式（行号 + 改法），不再落到笼统兜底文案", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "bad-key-only", `name: bad-key-only\ndescription: 正常描述\nAllowed-tools: "Read"`);

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false, result.output);
    assert.ok(result.output.includes("：未通过（1 处错误）"), result.output);
    assert.ok(
      result.output.includes("[错误 1] 问题：frontmatter 第 4 行的顶层键「Allowed-tools」不合规"),
      result.output,
    );
    assert.ok(result.output.includes("SKILL.md:4"), result.output);
    assert.ok(result.output.includes("改法：") && result.output.includes("应写作 allowed-tools"), result.output);
    // 兜底文案是「校验未通过：…」；逐条报出后不应再有一条重复的笼统结论。
    assert.ok(!result.output.includes("问题：校验未通过："), result.output);
  });
});

test("小写 allowed-tools 加嵌套 metadata：仍然通过，嵌套行不被误当顶层键", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(
      root,
      "demo-skill",
      `name: demo-skill\ndescription: 正常描述\nallowed-tools: "Read Write"\nmetadata:\n  owner: demo`,
    );

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, true, result.output);
    assert.ok(result.output.includes("：通过"), result.output);
    assert.ok(!result.output.includes("不合规"), result.output);
    assert.ok(!result.output.includes("不支持的键"), result.output);
  });
});

test("name 与目录名不一致：合并 lib 结论后仍只报一条", () => {
  withTempRoot((root) => {
    const skillDir = writeSkill(root, "demo-skill", "name: other-skill\ndescription: 名字与目录不一致");

    const result = runCommand(parseArgs(`validate "${toDisplay(skillDir)}"`), ctxOf(root));

    assert.equal(result.ok, false, result.output);
    assert.ok(result.output.includes("：未通过（1 处错误）"), result.output);
    assert.equal(countOf(result.output, "目录名与 frontmatter name 不一致"), 1, result.output);
    assert.ok(!result.output.includes("问题：校验未通过："), result.output);
  });
});
