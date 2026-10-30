/**
 * `skill_zh validate`：校验技能目录，并把结论与每条问题的改法翻成可直接照做的中文。
 *
 * 结构规则以 `lib/validate.ts` 的 `validateSkill` 为准（同一套口径，不在这里另立标准），但
 * `validateSkill` 只回**第一条**问题；本文件按同样的规则逐条扫描 frontmatter，把**全部**问题
 * 一次列出来（错误与提示分开计数），并补一条 `validateSkill` 不覆盖的检查：目录名 = `name`。
 * `validateSkill` 的结论仍会并入（它以后新增的规则不会被漏掉），但同一类别的问题只报一次。
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

/**
 * `new` 生成的占位 description 原文（`templates/skill-md.md` 渲染后的值）。
 *
 * `new` 直接用它填模板（见 `src/cli/new.ts`），这里同时作为「整体等于模板原文」的判据，
 * 避免「生成文案」与「占位判据」各写一份后漂移。
 */
export const TEMPLATE_DESCRIPTION = "TODO: 用一句话写清做什么 + 何时触发 + 不适用，≤ 60 字符";

/**
 * 占位形态：**开头**就是 `TODO` / `待填` 加冒号（半角或全角）。
 *
 * 只锚定开头，不做子串匹配：`管理 TODO 清单`、`处理等待填写的审批表单` 都是合法 description，
 * 中间出现这两个词不构成占位。
 */
const PLACEHOLDER_PREFIX = /^\s*(TODO|待填)\s*[:：]/i;

/** 允许出现在 frontmatter 的键（与 `lib/validate.ts` 的 `ALLOWED_PROPERTIES` 同源）。 */
const ALLOWED_PROPERTIES = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];

/** 合规顶层键：小写字母开头，只用小写字母、数字、连字符与下划线（与 `lib/validate.ts` 一致）。 */
const KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * 宽松的顶层键探测：无前导空白且不是注释的「键: 值」行都先收进来，键名合规性随后再判。
 *
 * 不能用小写开头正则直接过滤——`Allowed-tools:` 这类键匹配失败后整行被丢弃，既不报错也不
 * 参与字段校验，结果仍是「通过」（假通过）。前导空白的嵌套行（如 `metadata` 下的键）不匹配
 * 本正则，不会被误当顶层键。
 */
const TOP_LEVEL_KEY_LINE = /^([^\s:#][^:]*?)\s*:\s*(.*)$/;

/** 块标量头部（`|`/`>` 及其缩进、截断指示符）。 */
const BLOCK_SCALAR_MARKER = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

/**
 * CLI 逐条扫描覆盖的问题类别。
 *
 * 合并 `validateSkill` 的结论时按它去重：同一类别 CLI 已逐条报过（还更细），就不再补一条
 * 笼统的兜底文案；`validateSkill` 以后新增、CLI 没覆盖的类别则原样补进来。
 */
type IssueCategory =
  | "structure"
  | "yaml-value"
  | "malformed-key"
  | "unexpected-key"
  | "missing-name"
  | "missing-description"
  | "name-format"
  | "name-length"
  | "description-angle"
  | "description-length"
  | "description-placeholder"
  | "compatibility-length";

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
 * 把 `validateSkill` 的一句结论归到 CLI 扫描的类别上，供合并时去重。
 *
 * 两套解析口径相同但粒度不同：lib 只回第一条、CLI 逐条列全。若同一类问题两边都报，用户会
 * 看到「提示 description 超长」+「错误 description 过长」这类重复。返回 `null` 表示 CLI
 * 没有对应规则（lib 以后新增的校验），必须原样补进结果，不能因为「已报过别的」就吞掉。
 *
 * @param message `validateSkill` 返回的一句说明
 * @returns 对应类别；CLI 未覆盖时为 `null`
 */
function classifyVerdict(message: string): IssueCategory | null {
  if (message.includes("不合规的顶层键")) return "malformed-key";
  if (message.includes("不支持的键")) return "unexpected-key";
  if (message.includes("取值不是合法 YAML")) return "yaml-value";
  if (message.includes("缺少必填字段 name")) return "missing-name";
  if (message.includes("缺少必填字段 description")) return "missing-description";
  if (message.includes("不是 kebab-case") || message.includes("不能以连字符开头")) return "name-format";
  if (message.includes("name 过长")) return "name-length";
  if (message.includes("description 不能含尖括号")) return "description-angle";
  if (message.includes("description 过长")) return "description-length";
  if (message.includes("compatibility 过长")) return "compatibility-length";
  if (message.includes("未找到 SKILL.md") || message.includes("缺少 YAML frontmatter") || message.includes("frontmatter 格式不正确")) {
    return "structure";
  }
  return null;
}

/**
 * 判断 `description` 是否仍是模板占位文案。
 *
 * **只看 description**：正文里写「如何写 TODO」是正常内容，不该误报。判据只有两条，宁窄勿宽：
 * ① **开头**是 `TODO` / `待填` 加冒号（半角或全角、大小写不敏感）；② 整体等于模板占位原文。
 * 中间出现 `TODO` / `待填` 一律不算（`管理 TODO 清单`、`处理等待填写的审批表单` 都是合法文案）。
 *
 * @param description frontmatter 的 description（已去引号与首尾空白）
 * @returns 命中的占位标记；不是占位时为 `null`
 */
function findPlaceholderMarker(description: string): string | null {
  const prefix = PLACEHOLDER_PREFIX.exec(description);
  if (prefix !== null) return prefix[0].trim();
  if (description === TEMPLATE_DESCRIPTION) return "模板占位原文";
  return null;
}

/**
 * 扫描 frontmatter，逐条产出问题（同一目录多处问题一次报全）。
 *
 * 规则与 `validateSkill` 一一对应，差别只在「不提前 return」：未知键、不合规键名、未加引号
 * 的非法取值、缺失必填字段、name/description 规范各自成为一条独立问题。
 *
 * @param fmLines frontmatter 行（不含两行 `---`）
 * @param skillFile SKILL.md 的显示路径
 * @param dirName 技能目录名（用于给出可直接照抄的 `name` 改法）
 * @param meta `parseSkillMd` 解析出的 name / description；解析失败时为 `null`
 * @param covered 已报出的问题类别，边扫描边写入（供合并 `validateSkill` 结论时去重）
 * @returns 问题列表（可能为空）
 */
function scanFrontmatter(
  fmLines: string[],
  skillFile: string,
  dirName: string,
  meta: { name: string; description: string } | null,
  covered: Set<IssueCategory>,
): Issue[] {
  const issues: Issue[] = [];
  const keyLines = new Map<string, number>();
  const values = new Map<string, string>();
  const unexpected: string[] = [];

  fmLines.forEach((line, index) => {
    const kv = TOP_LEVEL_KEY_LINE.exec(line);
    if (kv === null) return;

    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    // +2：frontmatter 从文件第 2 行开始（第 1 行是 `---`），数组下标还要再 +1。
    const lineNo = index + 2;

    const isKeyValid = KEY_PATTERN.test(key);
    if (!isKeyValid) {
      const lowered = key.toLowerCase();
      const renameFix =
        lowered === key
          ? `把第 ${lineNo} 行的键名「${key}」改成以小写字母开头、且只用小写字母、数字、连字符与下划线的形式`
          : `把第 ${lineNo} 行的键名「${key}」改成小写形式：应写作 ${lowered}`;
      covered.add("malformed-key");
      issues.push({
        severity: "error",
        problem: `frontmatter 第 ${lineNo} 行的顶层键「${key}」不合规：顶层键只能以小写字母开头，且只用小写字母、数字、连字符与下划线（运行时按大小写敏感解析，拼错即失效）`,
        fix: ALLOWED_PROPERTIES.includes(lowered)
          ? renameFix
          : `${renameFix}；「${lowered}」也不在允许的键内，删除该行或改用允许的键：${ALLOWED_PROPERTIES.join("、")}`,
        file: skillFile,
        line: lineNo,
      });
    }

    // 与 `validateSkill` 同一条判据：未加引号且含「: 」或以冒号结尾的取值不是合法 YAML。
    if (value !== "" && !isQuotedValue(value) && !BLOCK_SCALAR_MARKER.test(value) && (/:[ \t]/.test(value) || value.endsWith(":"))) {
      covered.add("yaml-value");
      issues.push({
        severity: "error",
        problem: `frontmatter 的 ${key} 取值不是合法 YAML（含「: 」或以冒号结尾），运行时会丢弃该技能`,
        fix: `把 ${skillFile} 第 ${lineNo} 行的 ${key} 整体用双引号包住，例如 ${key}: "把冒号后的空格换成顿号"`,
        file: skillFile,
        line: lineNo,
      });
    }

    // 不合规键只报键名问题，不再参与后续字段解析：否则既会重复报「不支持的键」，
    // 也会让大小写写错的 name/description 冒充合法字段。
    if (!isKeyValid) return;

    if (!keyLines.has(key)) keyLines.set(key, lineNo);
    if (!ALLOWED_PROPERTIES.includes(key)) unexpected.push(key);
    if (!values.has(key)) values.set(key, BLOCK_SCALAR_MARKER.test(value) ? "" : value.replace(/^['"]|['"]$/g, ""));
  });

  if (unexpected.length > 0) {
    covered.add("unexpected-key");
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
    covered.add("missing-name");
    issues.push({
      severity: "error",
      problem: "frontmatter 缺少必填字段 name",
      fix: `在 ${skillFile} 的 frontmatter 里加一行 name: ${dirName}（小写 kebab-case，与目录名一致）`,
      file: skillFile,
    });
  } else if (!KEBAB_PATTERN.test(name)) {
    covered.add("name-format");
    issues.push({
      severity: "hint",
      problem: `name「${name}」不是 kebab-case（只允许小写字母、数字与单个连字符）`,
      fix: `把 name 改成全小写、单词间用单个连字符的形式（例如 ${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "") || "my-skill"}）`,
      file: skillFile,
      ...(nameLine === undefined ? {} : { line: nameLine }),
    });
  } else if (name.length > NAME_MAX_LENGTH) {
    covered.add("name-length");
    issues.push({
      severity: "hint",
      problem: `name 过长：${name.length} 字符，上限 ${NAME_MAX_LENGTH} 字符`,
      fix: "删掉 name 里冗余的修饰词，保留能区分用途的 2～4 个单词",
      file: skillFile,
      ...(nameLine === undefined ? {} : { line: nameLine }),
    });
  }

  if (description === "") {
    covered.add("missing-description");
    issues.push({
      severity: "error",
      problem: "frontmatter 缺少必填字段 description",
      fix: `在 ${skillFile} 的 frontmatter 里加一行 description: "做什么 + 何时触发 + 不适用"，用双引号包住`,
      file: skillFile,
    });
  } else if (/[<>]/.test(description)) {
    covered.add("description-angle");
    issues.push({
      severity: "error",
      problem: "description 含尖括号（< 或 >），会被加载器丢弃",
      fix: "把 description 里的尖括号换成中文引号，例如把 <路径> 写成「路径」",
      file: skillFile,
      ...(descriptionLine === undefined ? {} : { line: descriptionLine }),
    });
  } else if (countChars(description) > DESCRIPTION_MAX_LENGTH) {
    covered.add("description-length");
    issues.push({
      severity: "hint",
      problem: `description 超长：${countChars(description)} 字符，上限 ${DESCRIPTION_MAX_LENGTH} 字符`,
      fix: "把细则移到正文或 references/，description 只保留「做什么 + 何时触发 + 不适用边界」",
      file: skillFile,
      ...(descriptionLine === undefined ? {} : { line: descriptionLine }),
    });
  }

  // 占位文案独立判定（不与上面的 else-if 串起来）：超长 + 占位要各报一条，用户才知道两处都得改。
  // 级别固定为 hint——`--strict` 的升级逻辑只认 `severity:"hint"`，写死 error 会绕过它。
  const placeholder = description === "" ? null : findPlaceholderMarker(description);
  if (placeholder !== null) {
    covered.add("description-placeholder");
    issues.push({
      severity: "hint",
      problem: `description 仍是占位文案（命中「${placeholder}」），不是该技能的真实触发说明`,
      fix: `把 ${skillFile} 的 description 换成「做什么 + 何时触发（含用户真实说法）+ 不适用边界」，再运行 skill_zh validate --strict 复核`,
      file: skillFile,
      ...(descriptionLine === undefined ? {} : { line: descriptionLine }),
    });
  }

  const compatibility = (values.get("compatibility") ?? "").trim();
  if (countChars(compatibility) > COMPATIBILITY_MAX_LENGTH) {
    covered.add("compatibility-length");
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
 * `validateSkill` 的结论始终并入（它加了扫描没覆盖的新规则时不会漏判），已覆盖的类别跳过。
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

  const covered = new Set<IssueCategory>();
  const issues = scanFrontmatter(fmLines, skillFile, dirName, meta, covered);

  const name = (meta?.name ?? "").trim();
  if (name !== "" && name !== dirName) {
    issues.push({
      severity: "error",
      problem: `目录名与 frontmatter name 不一致：目录 ${dirName}，name ${name}`,
      fix: `把目录重命名为 ${name}，或把 ${skillFile} 的 name 改为 ${dirName}`,
      file: skillFile,
    });
  }

  // 合并而非二选一：`validateSkill` 以后新增的规则（CLI 扫描没覆盖）仍要并入，不能因为
  // `issues` 非空就整条丢弃；CLI 已逐条报过的类别（更细、带行号）则跳过，避免重复。
  const verdict = validateSkill(skillPath);
  if (!verdict.valid) {
    const category = classifyVerdict(verdict.message);
    if (category === null || !covered.has(category)) {
      issues.push({
        severity: "error",
        problem: `校验未通过：${verdict.message}`,
        fix: `按提示修改 ${skillFile}，再运行 skill_zh validate 复核`,
        file: skillFile,
      });
    }
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

