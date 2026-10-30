/**
 * `skill_zh new`：按 `templates/` 里的中文模板生成技能骨架（`SKILL.md` + `references/` +
 * `eval_set.json`）。
 *
 * 三条硬口径：① 技能名必须匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` 且 ≤ 64 字符——它同时是目录名与
 * frontmatter 的 `name`，命名不合规的技能在加载期就会被丢弃；② 目标目录已存在且非空时**默认拒绝**，
 * 只有显式 `--force` 才覆盖（覆盖前把旧 `SKILL.md`、`references/示例.md` 备份成 `.bak`），避免误删
 * 用户已写的内容；③ 已存在的 `eval_set.json` **一律保留**——它是用户手写 / 调过的评测集，重跑
 * `--force` 也不该吃掉（其余生成物有 `.bak` 兜底，评测集没有「可重建」这一说）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../lib/logger.js";
import { formatError } from "./errors.js";
import { TEMPLATE_DESCRIPTION } from "./validate.js";
import type { DispatchResult, HandlerInput } from "./types.js";

/** 技能名的合法形式：小写字母/数字分段，段间单个连字符（kebab-case）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 技能名长度上限（与 `lib/validate.ts` 的 `name` 上限一致）。 */
const MAX_SKILL_NAME_LENGTH = 64;

/** 技能名举例：失败时给出的可照抄改写。 */
const SKILL_NAME_EXAMPLE = "api-doc-writer";

/** 模板目录（仓库根 `templates/`）；编译后 `dist/cli/new.js` 相对其上两级。 */
const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

/** 骨架正文模板文件名。 */
const SKILL_TEMPLATE_FILE = "skill-md.md";

/** `references/` 占位资料模板文件名。 */
const REFERENCE_TEMPLATE_FILE = "reference-example.md";

/** 参考资料目录名。 */
const REFERENCES_DIR = "references";

/** 生成的占位资料文件名（中文名，读技能时可直接看懂用途）。 */
const REFERENCE_FILE = "示例.md";

/** 评测集骨架模板文件名。 */
const EVAL_SET_TEMPLATE_FILE = "eval-set.json";

/** 评测集文件名（`eval` / `optimize` 的默认读取位置，见 `src/cli/eval-common.ts`）。 */
const EVAL_SET_FILE = "eval_set.json";

/** `--force` 覆盖时旧文件的备份后缀。 */
const BACKUP_SUFFIX = ".bak";

/** 生成脚本里的 `name` 占位符。 */
const NAME_PLACEHOLDER = "{{name}}";

/** 生成脚本里的 `description` 占位符。 */
const DESCRIPTION_PLACEHOLDER = "{{description}}";

/**
 * 把路径统一成 `/` 分隔，供输出与改法命令使用。
 *
 * Windows 上 `join` 产出 `\`；统一成 `/` 后与 `docs/tools.md` 的示例一致，且 Node 与
 * 本工具的路径解析都能识别。
 *
 * @param path 任意文件系统路径
 * @returns 用 `/` 分段的路径文本
 */
function toDisplayPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * 读取模板文件。
 *
 * @param fileName `templates/` 下的文件名
 * @returns 模板原文（保留占位符）
 * @throws 模板缺失时抛错，由分发层转成三段式
 */
function readTemplate(fileName: string): string {
  return readFileSync(join(TEMPLATES_DIR, fileName), "utf-8");
}

/**
 * 用技能名与占位 description 替换模板占位符。
 *
 * description 与 name 一起替换：description 在模板里是带引号的 TODO 文案，换行与引号都由
 * 模板负责，代码只做纯文本替换，避免在 ts 里内联大段文案。占位文案取自 `validate` 导出的
 * {@link TEMPLATE_DESCRIPTION}——`--strict` 的占位判据认「整体等于它」，两处必须完全同源。
 *
 * @param template 模板原文
 * @param name 合法技能名
 * @returns 可直接写盘的文本
 */
function renderTemplate(template: string, name: string): string {
  return template
    .replaceAll(NAME_PLACEHOLDER, name)
    .replaceAll(DESCRIPTION_PLACEHOLDER, TEMPLATE_DESCRIPTION);
}

/**
 * 校验技能名是否合法。
 *
 * @param name 待校验的技能名
 * @returns 不合法时的中文原因；合法时为 `null`
 */
function checkSkillName(name: string): string | null {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return `技能名不是 kebab-case：${name}（只允许小写字母、数字与单个连字符）`;
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return `技能名过长：${name.length} 字符，上限 ${MAX_SKILL_NAME_LENGTH} 字符`;
  }
  return null;
}

/**
 * 判断目录是否已存在且非空。
 *
 * 目录不存在视为「可写」；存在但为空同样允许直接生成，避免用户先 `mkdir` 再建技能时被拦。
 *
 * @param dir 目标目录
 * @returns 存在且含至少一个条目时为 `true`
 */
function isNonEmptyDir(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).length > 0;
}

/**
 * `new` 子命令实现。
 *
 * @param input handler 入参（`positionals[0]` 为技能名，`flags.dir` 为父目录，`flags.force` 为覆盖开关）
 * @returns 成功时的生成清单与下一步，失败时为三段式
 */
export function newHandler(input: HandlerInput): DispatchResult {
  const name = input.positionals[0];

  if (name === undefined) {
    return {
      ok: false,
      output: formatError(
        "缺少参数 <技能名>",
        `运行 skill_zh new ${SKILL_NAME_EXAMPLE} --dir ./skills（技能名用小写 kebab-case）`,
      ),
    };
  }

  // `--dir` 只写开关不写取值（`--dir` 紧跟另一个标志或行尾）时拿到的是 `true`，按缺值报错，
  // 否则会把它当成目录名拼出一个名为 "true" 的父目录。
  const dirFlag = input.flags.dir;
  if (dirFlag === true) {
    return {
      ok: false,
      output: formatError(
        "缺少参数 --dir <目录>",
        `运行 skill_zh new ${name} --dir ./skills，或直接 skill_zh new ${name} 用当前项目目录`,
      ),
    };
  }

  const nameProblem = checkSkillName(name);
  if (nameProblem !== null) {
    return {
      ok: false,
      output: formatError(
        nameProblem,
        `改用 kebab-case 名重试，例如 skill_zh new ${SKILL_NAME_EXAMPLE} --dir ${
          typeof dirFlag === "string" ? dirFlag : "./skills"
        }`,
      ),
    };
  }

  const displayBase = toDisplayPath(typeof dirFlag === "string" ? dirFlag : input.projectDir);
  const baseDir = resolve(input.projectDir, displayBase);
  const targetDir = join(baseDir, name);
  const displayTarget = toDisplayPath(join(displayBase, name));
  const force = input.flags.force === true;

  if (isNonEmptyDir(targetDir) && !force) {
    log.info(`new 目标目录已存在且非空，未覆盖：${targetDir}`);
    return {
      ok: false,
      output: formatError(
        `目标目录已存在且非空，未覆盖：${displayTarget}`,
        `换一个技能名，或运行 skill_zh new ${name} --dir ${displayBase} --force（覆盖前会把旧 SKILL.md 备份为 SKILL.md.bak）`,
      ),
    };
  }

  const skillMdPath = join(targetDir, "SKILL.md");
  const referencesDir = join(targetDir, REFERENCES_DIR);
  const referencePath = join(referencesDir, REFERENCE_FILE);
  const evalSetPath = join(targetDir, EVAL_SET_FILE);
  const skillTemplate = readTemplate(SKILL_TEMPLATE_FILE);
  const referenceTemplate = readTemplate(REFERENCE_TEMPLATE_FILE);
  const evalSetTemplate = readTemplate(EVAL_SET_TEMPLATE_FILE);
  // 已存在的评测集视为用户资产：`--force` 也不覆盖，只在输出里点名「已保留」。
  const keepEvalSet = existsSync(evalSetPath);

  mkdirSync(referencesDir, { recursive: true });

  // 覆盖前只给「本次要重写的两个文件」留备份：用户改过的 SKILL.md 与 references/示例.md
  // 都会被重写，静默丢掉等于吃掉用户内容；其它自建文件不碰，也不备份。
  const backups: string[] = [];
  if (force) {
    for (const filePath of [skillMdPath, referencePath]) {
      if (existsSync(filePath)) {
        copyFileSync(filePath, `${filePath}${BACKUP_SUFFIX}`);
        backups.push(toDisplayPath(join(displayTarget, `${relative(targetDir, filePath)}${BACKUP_SUFFIX}`)));
      }
    }
  }

  writeFileSync(skillMdPath, renderTemplate(skillTemplate, name), "utf-8");
  writeFileSync(referencePath, referenceTemplate, "utf-8");
  if (!keepEvalSet) {
    writeFileSync(evalSetPath, renderTemplate(evalSetTemplate, name), "utf-8");
  }

  log.info(`已生成技能骨架：${targetDir}`);

  const lines = [
    `已生成技能骨架：${displayTarget}`,
    "  SKILL.md               （frontmatter：name、description 占位，正文为待填大纲）",
    `  ${REFERENCES_DIR}/${REFERENCE_FILE}      （按需加载的参考资料，文件开头写明何时读）`,
    keepEvalSet
      ? `  ${EVAL_SET_FILE}          （已存在，保留原评测集未覆盖）`
      : `  ${EVAL_SET_FILE}          （2 正 1 负的可跑评测集骨架，query 仍是 TODO 占位）`,
  ];
  for (const backup of backups) {
    lines.push(`  已备份：${backup}`);
  }
  if (keepEvalSet) {
    lines.push(`  已保留：${toDisplayPath(join(displayTarget, EVAL_SET_FILE))}（未覆盖已有评测集）`);
  }
  lines.push(
    "下一步：",
    `  1. 编辑 ${toDisplayPath(join(displayTarget, "SKILL.md"))}，把 description 的 TODO 换成「做什么 + 何时触发 + 不适用」`,
    `  2. 编辑 ${toDisplayPath(join(displayTarget, EVAL_SET_FILE))}，把占位 query 换成针对本技能的真实说法（保留原评测集时只复核）`,
    `  3. 运行 skill_zh validate ${displayTarget} --strict 复核结构（占位未改完会判失败）`,
    `  4. 运行 skill_zh eval ${displayTarget} --runs 1 试跑评测（调用 opencode，会产生费用）`,
  );

  return { ok: true, output: lines.join("\n") };
}
