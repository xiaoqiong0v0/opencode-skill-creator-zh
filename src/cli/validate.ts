/**
 * `skill_zh validate`：校验技能目录，并把结论与每条问题的改法翻成可直接照做的中文。
 *
 * 结构规则以 `lib/validate.ts` 的 `validateSkill` 为准（同一套口径，不在这里另立标准），但
 * `validateSkill` 只回**第一条**问题；本文件按同样的规则逐条扫描 frontmatter，把**全部**问题
 * 一次列出来（错误与提示分开计数），并补一条 `validateSkill` 不覆盖的检查：目录名 = `name`。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { log } from "../lib/logger.js";
import { parseSkillMd, resolveSkillMdPath } from "../lib/utils.js";
import { validateSkill } from "../lib/validate.js";
import { formatError } from "./errors.js";
import type { DispatchResult, HandlerInput } from "./types.js";

/** 单条校验问题。 */
export interface Issue {
  /** 严重级别：`error` 判失败；`hint` 缺省只提示，`--strict` 下升级为 `error`。 */
  severity: "error" | "hint";
  /** 一句话说明哪里不对。 */
  problem: string;
  /** 可直接照做的改法。 */
  fix: string;
  /** 相关文件（能定位时）。 */
  file?: string;
  /** 相关行号，从 1 起（能定位时）。 */
  line?: number;
}

/** 技能名合法形式（与 `new`、`validateSkill` 的 kebab-case 口径一致）。 */
const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `name` 上限。 */
const NAME_MAX_LENGTH = 64;

/** `description` 上限（与 `validateSkill` 一致）。 */
const DESCRIPTION_MAX_LENGTH = 1024;

/** `compatibility` 上限。 */
const COMPATIBILITY_MAX_LENGTH = 500;

/** 允许出现在 frontmatter 的键（与 `lib/validate.ts` 的 `ALLOWED_PROPERTIES` 同源）。 */
const ALLOWED_PROPERTIES = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];

/** 块标量头部（`|`/`>` 及其缩进、截断指示符）。 */
const BLOCK_SCALAR_MARKER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

/**
 * 把路径统一成 `/` 分隔，供输出与改法命令使用。
 *
 * @param path 任意文件系统路径
 * @returns 用 `/` 分段的路径文本
 */
function toDisplayPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * 统计字符串的可见字符数（按码点，避免中文与 emoji 被算成多个 UTF-16 单元）。
 *
 * @param text 待计数的文本
 * @returns 码点数量
 */
function countChars(text: string): number {
  return [...text].length;
}

/**
 * 取显示路径的父目录，并保留用户原有写法。
 *
 * 改法里要能直接照抄，所以不返回 `resolve()` 后的绝对路径：用户写 `./skills/demo`
 * 就回 `./skills`，写 `demo` 就回 `.`。
 *
 * @param displayPath 用户传入的路径（已统一成 `/` 分隔）
 * @returns 父目录；无分隔符时为 `.`
 */
function parentOfDisplayPath(displayPath: string): string {
  const normalized = displayPath.replace(/\/+$/, "");
  const at = normalized.lastIndexOf("/");
  if (at === -1) return ".";
  return normalized.slice(0, at) || "/";
}

/**
 * 判断取值是否被引号整体包住。
 *
 * @param value 冒号后的取值文本
 * @returns 被成对引号包住时为 `true`
 */
function isQuotedValue(value: string): boolean {
  return (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  );
}

/**
 * 取 SKILL.md 的 frontmatter 行（不含两行 `---`）。
 *
 * @param content 已把 CRLF 归一成 LF 的 SKILL.md 全文
 * @returns frontmatter 行数组；找不到结束的 `---` 时为 `null`
 */
function readFrontmatterLines(content: string): string[] | null {
  const lines = content.split("\n");
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return endIndex === -1 ? null : lines.slice(1, endIndex);
}

/**
 * 扫描 frontmatter，逐条产出问题（同一目录多处问题一次报全）。
 *
 * 规则与 `validateSkill` 一一对应，差别只在「不提前 return」：未知键、未加引号的非法取值、
 * 缺失必填字段、name/description 规范各自成为一条独立问题。
 *
 * @param fmLines frontmatter 行（不含两行 `---`）
 * @param skillFile SKILL.md 的显示路径
 * @param dirName 技能目录名（用于给出可直接照抄的 `name` 改法）
 * @param meta `parseSkillMd` 解析出的 name / description；解析失败时为 `null`
 * @returns 问题列表（可能为空）
 */
function scanFrontmatter(
  fmLines: string[],
  skillFile: string,
  dirName: string,
  meta: { name: string; description: string } | null,
): Issue[] {
  const issues: Issue[] = [];
  const keyLines = new Map<string, number>();
  const values = new Map<string, string>();
  const unexpected: string[] = [];

  fmLines.forEach((line, index) => {
    const kv = /^([a-z][a-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (kv === null) return;

    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    // +2：frontmatter 从文件第 2 行开始（第 1 行是 `---`），数组下标还要再 +1。
    const lineNo = index + 2;

    if (!keyLines.has(key)) keyLines.set(key, lineNo);
    if (!ALLOWED_PROPERTIES.includes(key)) unexpected.push(key);
    if (!values.has(key)) values.set(key, BLOCK_SCALAR_MARKER.test(value) ? "" : value.replace(/^['"]|['"]$/g, ""));

    // 与 `validateSkill` 同一条判据：未加引号且含「: 」或以冒号结尾的取值不是合法 YAML。
    if (value !== "" && !isQuotedValue(value) && !BLOCK_SCALAR_MARKER.test(value) && (/:[ \t]/.test(value) || value.endsWith(":"))) {
      issues.push({
        severity: "error",
        problem: `frontmatter 的 ${key} 取值不是合法 YAML（含「: 」或以冒号结尾），运行时会丢弃该技能`,
        fix: `把 ${skillFile} 第 ${lineNo} 行的 ${key} 整体用双引号包住，例如 ${key}: "把冒号后的空格换成顿号"`,
        file: skillFile,
        line: lineNo,
      });
    }
  });

  if (unexpected.length > 0) {
    issues.push({
      severity: "error",
      problem: `frontmatter 含不支持的键：${unexpected.sort().join("、")}`,
      fix: `删除这些键，只保留允许的键：${ALLOWED_PROPERTIES.join("、")}`,
      file: skillFile,
    });
  }

  const name = (meta?.name ?? values.get("name") ?? "").trim();
  const description = (meta?.description ?? values.get("description") ?? "").trim();
  const nameLine = keyLines.get("name");
  const descriptionLine = keyLines.get("description");

  if (name === "") {
    issues.push({
      severity: "error",
      problem: "frontmatter 缺少必填字段 name",
      fix: `在 ${skillFile} 的 frontmatter 里加一行 name: ${dirName}（小写 kebab-case，与目录名一致）`,
      file: skillFile,
    });
  } else if (!KEBAB_PATTERN.test(name)) {
    issues.push({
      severity: "hint",
      problem: `name「${name}」不是 kebab-case（只允许小写字母、数字与单个连字符）`,
      fix: `把 name 改成全小写、单词间用单个连字符的形式（例如 ${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "my-skill"}）`,
      file: skillFile,
      ...(nameLine === undefined ? {} : { line: nameLine }),
    });
  } else if (name.length > NAME_MAX_LENGTH) {
    issues.push({
      severity: "hint",
      problem: `name 过长：${name.length} 字符，上限 ${NAME_MAX_LENGTH} 字符`,
      fix: "删掉 name 里冗余的修饰词，保留能区分用途的 2～4 个单词",
      file: skillFile,
      ...(nameLine === undefined ? {} : { line: nameLine }),
    });
  }

  if (description === "") {
    issues.push({
      severity: "error",
      problem: "frontmatter 缺少必填字段 description",
      fix: `在 ${skillFile} 的 frontmatter 里加一行 description: "做什么 + 何时触发 + 不适用"，用双引号包住`,
      file: skillFile,
    });
  } else if (/[<>]/.test(description)) {
    issues.push({
      severity: "error",
      problem: "description 含尖括号（< 或 >），会被加载器丢弃",
      fix: "把 description 里的尖括号换成中文引号，例如把 <路径> 写成「路径」",
      file: skillFile,
      ...(descriptionLine === undefined ? {} : { line: descriptionLine }),
    });
  } else if (countChars(description) > DESCRIPTION_MAX_LENGTH) {
    issues.push({
      severity: "hint",
      problem: `description 超长：${countChars(description)} 字符，上限 ${DESCRIPTION_MAX_LENGTH} 字符`,
      fix: "把细则移到正文或 references/，description 只保留「做什么 + 何时触发 + 不适用边界」",
      file: skillFile,
      ...(descriptionLine === undefined ? {} : { line: descriptionLine }),
    });
  }

  const compatibility = (values.get("compatibility") ?? "").trim();
  if (countChars(compatibility) > COMPATIBILITY_MAX_LENGTH) {
    issues.push({
      severity: "error",
      problem: `compatibility 过长：${countChars(compatibility)} 字符，上限 ${COMPATIBILITY_MAX_LENGTH} 字符`,
      fix: "只保留运行环境要求的版本区间与必要说明，细节移到正文",
      file: skillFile,
      ...(keyLines.get("compatibility") === undefined ? {} : { line: keyLines.get("compatibility") }),
    });
  }

  return issues;
}

/**
 * 收集全部问题：frontmatter 逐条扫描 + 目录名与 `name` 的一致性。
 *
 * `validateSkill` 只用来兜底（它加了扫描没覆盖的新规则时，至少不会漏判「通过」）。
 *
 * @param skillPath 技能目录绝对路径
 * @param displayPath 技能目录显示路径
 * @returns 问题列表（可能为空）
 */
export function collectIssues(skillPath: string, displayPath: string): Issue[] {
  const dirName = basename(skillPath);
  const skillMdPath = resolveSkillMdPath(skillPath);

  if (skillMdPath === null) {
    return [
      {
        severity: "error",
        problem: `SKILL.md 不存在：${toDisplayPath(join(displayPath, "SKILL.md"))}`,
        fix: `在 ${toDisplayPath(skillPath)} 下新建 SKILL.md，内容以 --- 开头、frontmatter 写 name 与 description，再写正文；也可用 skill_zh new 生成骨架后复制过来`,
      },
    ];
  }

  const skillFile = toDisplayPath(join(displayPath, basename(skillMdPath)));

  // CRLF 先归一到 LF：下面按行匹配 `---` 与键名都假定是 \n。
  const content = readFileSync(skillMdPath, "utf-8").replace(/\r\n/g, "\n");
  if (!content.startsWith("---")) {
    return [
      {
        severity: "error",
        problem: "SKILL.md 开头没有 frontmatter（第 1 行必须是 ---）",
        fix: `把 ${skillFile} 第 1 行改成 ---，并在 name / description 之后补一行 --- 收尾`,
        file: skillFile,
        line: 1,
      },
    ];
  }

  const fmLines = readFrontmatterLines(content);
  if (fmLines === null) {
    return [
      {
        severity: "error",
        problem: "frontmatter 不完整：找不到结束的 ---",
        fix: `在 ${skillFile} 的 frontmatter 末尾补一行 ---，其后再写正文`,
        file: skillFile,
      },
    ];
  }

  let meta: { name: string; description: string } | null = null;
  try {
    const parsed = parseSkillMd(skillPath);
    meta = { name: parsed.name, description: parsed.description };
  } catch {
    // frontmatter 已由上面确认成形；这里失败只说明解析器更严格，退回按原始键值判定。
  }

  const issues = scanFrontmatter(fmLines, skillFile, dirName, meta);

  const name = (meta?.name ?? "").trim();
  if (name !== "" && name !== dirName) {
    issues.push({
      severity: "error",
      problem: `目录名与 frontmatter name 不一致：目录 ${dirName}，name ${name}`,
      fix: `把目录重命名为 ${name}，或把 ${skillFile} 的 name 改为 ${dirName}`,
      file: skillFile,
    });
  }

  // 兜底：扫描没覆盖的规则（例如新增字段校验）仍以 `validateSkill` 的结论为准。
  const verdict = validateSkill(skillPath);
  if (!verdict.valid && issues.length === 0) {
    issues.push({
      severity: "error",
      problem: `校验未通过：${verdict.message}`,
      fix: `按提示修改 ${skillFile}，再运行 skill_zh validate 复核`,
      file: skillFile,
    });
  }

  return issues;
}

/**
 * 渲染一条问题：`[标签] 问题` + `文件:行`（能定位时）+ `改法`。
 *
 * @param issue 问题
 * @param label 标签，例如 `错误 1` / `提示 2`
 * @returns 渲染后的文本块
 */
function renderIssue(issue: Issue, label: string): string {
  const lines = [`  [${label}] 问题：${issue.problem}`];
  if (issue.file !== undefined) {
    lines.push(`      文件：${issue.file}${issue.line === undefined ? "" : `:${issue.line}`}`);
  }
  lines.push(`      改法：${issue.fix}`);
  return lines.join("\n");
}

/**
 * 渲染通过时的摘要（name 与 description 实际字符数）。
 *
 * @param skillPath 技能目录绝对路径
 * @returns 摘要文本行
 */
function renderSummary(skillPath: string): string[] {
  const meta = parseSkillMd(skillPath);
  // 块标量 description 末尾带一个换行，计数前去掉，只算实际正文字符。
  return [
    `  name         ${meta.name.trim()}（与目录名一致）`,
    `  description  ${countChars(meta.description.trim())} 字符（上限 ${DESCRIPTION_MAX_LENGTH}）`,
  ];
}

/**
 * `validate` 子命令实现。
 *
 * @param input handler 入参（`positionals[0]` 为技能目录，`flags.strict` 为严格模式）
 * @returns 结论与逐条改法；参数或路径有问题时为三段式
 */
export function validateHandler(input: HandlerInput): DispatchResult {
  const target = input.positionals[0];

  if (target === undefined) {
    return {
      ok: false,
      output: formatError(
        "缺少参数 <技能目录>",
        "运行 skill_zh validate ./skills/my-skill（新建技能用 skill_zh new my-skill）",
      ),
    };
  }

  const skillPath = resolve(input.projectDir, target);
  const displayPath = toDisplayPath(target);

  if (!existsSync(skillPath) || !statSync(skillPath).isDirectory()) {
    const dirName = basename(skillPath);
    const parent = parentOfDisplayPath(displayPath);
    return {
      ok: false,
      output: formatError(
        `技能目录不存在：${displayPath}`,
        KEBAB_PATTERN.test(dirName)
          ? `确认目录名拼写，或运行 skill_zh new ${dirName} --dir ${parent} 新建一个`
          : `确认目录名拼写；技能目录名需为 kebab-case（如 my-skill），先按 kebab-case 改目录名，或运行 skill_zh new my-skill --dir ${parent} 新建一个`,
      ),
    };
  }

  const strict = input.flags.strict === true;
  const issues = collectIssues(skillPath, displayPath);
  // `--strict` 只升级「提示」级别：description 超长与命名不规范。结构性错误两级都判失败。
  const graded = issues.map((issue) => (strict && issue.severity === "hint" ? { ...issue, severity: "error" as const } : issue));
  const errors = graded.filter((issue) => issue.severity === "error");
  const hints = graded.filter((issue) => issue.severity === "hint");

  log.info(`validate ${displayPath}：${errors.length === 0 ? "通过" : `${errors.length} 处错误`}${strict ? "（strict）" : ""}`);

  const errorBlocks = errors.map((issue, index) => renderIssue(issue, `错误 ${index + 1}`));
  const hintBlocks = hints.map((issue, index) => renderIssue(issue, `提示 ${index + 1}`));

  // 错误与提示一起输出：否则用户要先修完错误再跑一次才能看见提示，多花一轮。
  if (errors.length > 0) {
    const counts = hints.length > 0 ? `${errors.length} 处错误，${hints.length} 处提示` : `${errors.length} 处错误`;
    return { ok: false, output: [`校验 ${displayPath}：未通过（${counts}）`, ...errorBlocks, ...hintBlocks].join("\n") };
  }

  const lines = [`校验 ${displayPath}：通过`, ...renderSummary(skillPath)];
  if (hints.length > 0) {
    lines.push(`提示（${hints.length} 处，缺省不判失败；加 --strict 会判失败）：`, ...hintBlocks);
  }

  return { ok: true, output: lines.join("\n") };
}

