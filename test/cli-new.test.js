/**
 * `skill_zh new` 的生成、命名校验与覆盖保护（docs/SPEC.md R2 / docs/tools.md `new` 一节）。
 *
 * 全部在系统临时目录里跑，不写仓库、不写用户目录；每个用例结束（含断言失败）都删临时目录。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "skill-creator-new-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    const result = fn(root);
    // 异步用例（要 await dispatch）的清理必须挂到 Promise 之后，否则会在断言前删目录。
    return result instanceof Promise ? result.finally(cleanup) : (cleanup(), result);
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * 构造分发上下文：项目目录即临时根，`new` 的相对路径都以它为基准。
 *
 * @param root 临时根路径
 * @returns 分发表需要的上下文
 */
function ctxOf(root) {
  return { directory: root, worktree: root };
}

test("合法技能名生成 SKILL.md、references/示例.md 与可跑的 eval_set.json，validate 通过但带占位提示", async () => {
  await withTempRoot(async (root) => {
    const output = await dispatch("new demo-skill --dir .", ctxOf(root));
    const skillDir = join(root, "demo-skill");
    const skillMd = join(skillDir, "SKILL.md");
    const reference = join(skillDir, "references", "示例.md");
    const evalSetPath = join(skillDir, "eval_set.json");

    assert.ok(output.startsWith("已生成技能骨架："), `输出未报生成成功：${output}`);
    assert.ok(existsSync(skillMd), "未生成 SKILL.md");
    assert.ok(existsSync(reference), "未生成 references/示例.md");
    assert.ok(existsSync(evalSetPath), "未生成 eval_set.json");

    const content = readFileSync(skillMd, "utf-8");
    assert.match(content, /^---\nname: demo-skill\n/, "frontmatter 的 name 不是技能名");
    assert.ok(content.includes("TODO: 用一句话写清做什么"), "description 未留 TODO 占位");
    assert.ok(readFileSync(reference, "utf-8").includes("何时读本文件"), "参考资料未写「何时读本文件」");

    // 评测集骨架：2 正 1 负，字段与 eval 的解析口径一致（query 非空字符串 + should_trigger 布尔）。
    const evalSet = JSON.parse(readFileSync(evalSetPath, "utf-8"));
    assert.ok(Array.isArray(evalSet), "eval_set.json 不是数组");
    assert.equal(evalSet.length, 3, "评测集骨架应为 3 条");
    assert.equal(evalSet.filter((item) => item.should_trigger === true).length, 2, "应含 2 条应触发");
    assert.equal(evalSet.filter((item) => item.should_trigger === false).length, 1, "应含 1 条不应触发");
    for (const item of evalSet) {
      assert.equal(typeof item.query, "string");
      assert.ok(item.query.trim().length > 0, "query 不能为空");
      assert.equal(typeof item.should_trigger, "boolean");
      // 占位 query 带 TODO，提醒作者换成真实说法。
      assert.ok(item.query.includes("TODO"), `骨架 query 未标占位：${item.query}`);
    }

    // 生成物是自洽的：紧接着跑 validate 必须通过（模板自己不能违反校验规则），但会因占位 description
    // 带 1 条提示；`--strict` 下同一条提示升级为错误 ⇒ 骨架原样必须失败。
    const target = skillDir.replaceAll("\\", "/");
    const validated = await dispatch(`validate "${target}"`, ctxOf(root));
    assert.ok(validated.includes("：通过"), `新生成的技能未通过校验：${validated}`);
    assert.ok(validated.includes("提示（1 处"), validated);
    assert.ok(validated.includes("description 仍是占位文案"), validated);

    const strict = await dispatch(`validate "${target}" --strict`, ctxOf(root));
    assert.ok(strict.includes("：未通过（1 处错误）"), strict);
    assert.ok(strict.includes("description 仍是占位文案"), strict);
  });
});

test("骨架的占位 description 换成真实文案后，validate 与 --strict 都通过", async () => {
  await withTempRoot(async (root) => {
    await dispatch("new demo-skill --dir .", ctxOf(root));
    const skillMd = join(root, "demo-skill", "SKILL.md");
    const real = "把发布流程固化成可复用步骤；用户说要做发布清单时触发，不适用于改代码";
    writeFileSync(
      skillMd,
      readFileSync(skillMd, "utf-8").replace(/^description: .*$/m, `description: "${real}"`),
      "utf-8",
    );

    const target = join(root, "demo-skill").replaceAll("\\", "/");
    for (const args of [`validate "${target}"`, `validate "${target}" --strict`]) {
      const result = await dispatch(args, ctxOf(root));
      assert.ok(result.includes("：通过"), `${args} 未通过：${result}`);
      assert.ok(!result.includes("description 仍是占位文案"), `${args} 仍在报占位：${result}`);
    }
  });
});

test("非法技能名拒绝生成，并给出可照抄的改法", () => {
  withTempRoot((root) => {
    const result = runCommand(parseArgs("new Demo_Skill --dir ."), ctxOf(root));
    const lines = result.output.split("\n");

    assert.equal(result.ok, false);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith("错误：技能名不是 kebab-case"), lines[0]);
    assert.ok(lines[1].includes("skill_zh new"), "改法里没有可照抄的命令");
    assert.ok(!existsSync(join(root, "Demo_Skill")), "非法名不应留下目录");
  });
});

test("目标目录已存在且非空时拒绝覆盖，并提示 --force", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "旧内容\n");

    const result = runCommand(parseArgs("new demo-skill --dir ."), ctxOf(root));
    const lines = result.output.split("\n");

    assert.equal(result.ok, false);
    assert.equal(lines[0], "错误：目标目录已存在且非空，未覆盖：demo-skill");
    assert.ok(lines[1].includes("--force"), `改法未提示 --force：${lines[1]}`);
    assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf-8"), "旧内容\n", "拒绝覆盖时不应改动旧文件");
  });
});

test("--force 覆盖 SKILL.md 并留下 .bak，未生成过的用户文件保持原样", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(join(skillDir, "references"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "旧内容\n");
    writeFileSync(join(skillDir, "references", "示例.md"), "旧参考\n");
    writeFileSync(join(skillDir, "notes.md"), "用户自己的笔记\n");

    const result = runCommand(parseArgs("new demo-skill --dir . --force"), ctxOf(root));

    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(skillDir, "SKILL.md.bak"), "utf-8"), "旧内容\n", "旧 SKILL.md 未备份");
    assert.equal(
      readFileSync(join(skillDir, "references", "示例.md.bak"), "utf-8"),
      "旧参考\n",
      "被覆盖的 references/示例.md 未备份",
    );
    assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf-8"), /^---\nname: demo-skill\n/);
    assert.ok(result.output.includes("已备份：demo-skill/SKILL.md.bak"), result.output);
    assert.ok(result.output.includes("已备份：demo-skill/references/示例.md.bak"), result.output);
    assert.equal(readFileSync(join(skillDir, "notes.md"), "utf-8"), "用户自己的笔记\n", "不该动用户自建文件");
  });
});

test("--force 不覆盖已存在的 eval_set.json（评测集是用户资产）", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "旧内容\n");
    const custom = JSON.stringify([{ query: "用户调过的 query", should_trigger: true }]);
    writeFileSync(join(skillDir, "eval_set.json"), custom, "utf-8");

    const result = runCommand(parseArgs("new demo-skill --dir . --force"), ctxOf(root));

    assert.equal(result.ok, true, result.output);
    assert.equal(readFileSync(join(skillDir, "eval_set.json"), "utf-8"), custom, "评测集被覆盖");
    assert.ok(!existsSync(join(skillDir, "eval_set.json.bak")), "保留评测集时不该留 .bak");
    assert.ok(result.output.includes("已保留：demo-skill/eval_set.json"), result.output);
    // 同一轮的 SKILL.md 仍按 --force 语义重写并备份。
    assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf-8"), /^---\nname: demo-skill\n/);
    assert.equal(readFileSync(join(skillDir, "SKILL.md.bak"), "utf-8"), "旧内容\n", "旧 SKILL.md 未备份");
  });
});

test("技能名超过 64 字符时拒绝生成", () => {
  withTempRoot((root) => {
    const name = "a".repeat(65);
    const result = runCommand(parseArgs(`new ${name} --dir .`), ctxOf(root));

    assert.equal(result.ok, false);
    assert.equal(result.output.split("\n")[0], "错误：技能名过长：65 字符，上限 64 字符");
    assert.ok(!existsSync(join(root, name)), "超长名不应留下目录");
  });
});

test("--dir 只写开关不给取值时报缺值，而不是把 true 当目录名", () => {
  withTempRoot((root) => {
    const result = runCommand(parseArgs("new demo-skill --dir --force"), ctxOf(root));
    const lines = result.output.split("\n");

    assert.equal(result.ok, false);
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：缺少参数 --dir <目录>");
    assert.ok(lines[1].includes("--dir ./skills"), lines[1]);
    assert.ok(!existsSync(join(root, "true")), "不应把 true 当目录名");
  });
});

test("目标目录已存在但为空时直接生成", () => {
  withTempRoot((root) => {
    const skillDir = join(root, "demo-skill");
    mkdirSync(skillDir, { recursive: true });

    const result = runCommand(parseArgs("new demo-skill --dir ."), ctxOf(root));

    assert.equal(result.ok, true, result.output);
    assert.ok(existsSync(join(skillDir, "SKILL.md")), "空目录未被填充");
    assert.ok(!result.output.includes("已备份"), "空目录不该产生备份");
  });
});

test("缺少技能名参数返回三段式并给示例", async () => {
  await withTempRoot(async (root) => {
    const lines = (await dispatch("new", ctxOf(root))).split("\n");

    assert.equal(lines.length, 3);
    assert.equal(lines[0], "错误：缺少参数 <技能名>");
    assert.ok(lines[1].startsWith("改法：运行 skill_zh new "), lines[1]);
    assert.equal(lines[2], "可用：skill_zh help");
  });
});
