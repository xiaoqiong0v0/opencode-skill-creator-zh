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

test("合法技能名生成 SKILL.md 与 references/示例.md，并能被 validate 通过", async () => {
  await withTempRoot(async (root) => {
    const output = await dispatch("new demo-skill --dir .", ctxOf(root));
    const skillDir = join(root, "demo-skill");
    const skillMd = join(skillDir, "SKILL.md");
    const reference = join(skillDir, "references", "示例.md");

    assert.ok(output.startsWith("已生成技能骨架："), `输出未报生成成功：${output}`);
    assert.ok(existsSync(skillMd), "未生成 SKILL.md");
    assert.ok(existsSync(reference), "未生成 references/示例.md");

    const content = readFileSync(skillMd, "utf-8");
    assert.match(content, /^---\nname: demo-skill\n/, "frontmatter 的 name 不是技能名");
    assert.ok(content.includes("TODO: 用一句话写清做什么"), "description 未留 TODO 占位");
    assert.ok(readFileSync(reference, "utf-8").includes("何时读本文件"), "参考资料未写「何时读本文件」");

    // 生成物是自洽的：紧接着跑 validate 必须通过（模板自己不能违反校验规则）。
    const validated = await dispatch(`validate "${skillDir.replaceAll("\\", "/")}"`, ctxOf(root));
    assert.ok(validated.includes("：通过"), `新生成的技能未通过校验：${validated}`);
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
