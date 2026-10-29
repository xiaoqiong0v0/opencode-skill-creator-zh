/**
 * SKILL.md frontmatter 读取工具。
 *
 * 不依赖 YAML 库，只解析受控子集：顶层 `name:` 与 `description:` 两个键，其中
 * description 既可写单行标量，也可写 `|`/`>` 块标量（可带截断指示符 `+`/`-`
 * 与显式缩进数字 `1-9`，两者顺序任意）。它不是通用 YAML 解析器 —— 锚点、转义、
 * 流式映射、嵌套映射与多文档流都不在支持范围内。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** SKILL.md 的解析结果：技能名、描述与文件原文。 */
export interface SkillMeta {
  name: string;
  description: string;
  fullContent: string;
}

/**
 * 块标量头部语法，与 `lib/validate.ts` 中的同名判断保持一致：先是指示符
 * （`|` 或 `>`），其后可带显式缩进（`1-9`）与截断指示符（`+`/`-`），两者顺序任意。
 */
const BLOCK_SCALAR_HEADER_RE = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/;

/** 块标量的截断方式：clip 保留末尾一个换行，strip 全部去掉，keep 全部保留。 */
type Chomp = "clip" | "strip" | "keep";

/** 块标量头部的解析结果。 */
interface BlockScalarHeader {
  /** 是否为字面量块（`|`）；`false` 表示折叠块（`>`）。 */
  literal: boolean;
  /** 截断方式。 */
  chomp: Chomp;
  /** 显式缩进数字；为 `null` 时由首个非空行推断。 */
  indent: number | null;
}

/**
 * 解析块标量头部文本。
 *
 * @param header 去掉 `description:` 前缀后的头部，例如 `|`、`>2+`、`|-2`
 * @returns 字面量标志、截断方式与显式缩进（未写时为 `null`）
 */
function parseBlockScalarHeader(header: string): BlockScalarHeader {
  const literal = header.startsWith("|");
  const chomp: Chomp = header.includes("-")
    ? "strip"
    : header.includes("+")
      ? "keep"
      : "clip";
  const indentMatch = header.match(/[1-9]/);
  return { literal, chomp, indent: indentMatch ? Number(indentMatch[0]) : null };
}

/** 块标量的一行内容。 */
interface ContentLine {
  /** 去掉块缩进后的行内容（缩进更深的行保留多余缩进）。 */
  text: string;
  /** 是否为空行。 */
  blank: boolean;
  /** 该行在源文件里是否比块缩进更深。 */
  moreIndented: boolean;
}

/**
 * 去掉行尾单个回车符，使 CRLF 输入产出 LF 标量值。
 *
 * `fullContent` 不受影响，因此文件字节保持原样。
 *
 * @param line 原始行（可能以 `\r` 结尾）
 * @returns 去掉行尾 `\r` 的行
 */
function stripTrailingCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * 拼接字面量块：换行与内部空行原样保留，包括每行的额外缩进与行尾空格。
 *
 * @param lines 块内各行
 * @returns 未经截断处理的块内容
 */
function joinLiteral(lines: ContentLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

/**
 * 折叠 `>` 块：相邻普通行以单个空格相连；空行变成一个换行；缩进更深的行原样
 * 保留，且其前后仍是换行（符合 YAML 参考实现对这一子集的行为）。截断由调用方
 * 在剪掉尾部空行之后施加。
 *
 * @param lines 块内各行
 * @returns 未经截断处理的折叠结果
 */
function foldLines(lines: ContentLine[]): string {
  let out = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index === 0) {
      out += line.blank ? "\n" : line.text;
      continue;
    }
    const previous = lines[index - 1];
    if (line.blank) {
      out += "\n";
    } else if (previous.blank) {
      // 空行已经输出过一个换行；缩进更深的行还要带上自己前面的那个换行，
      // 普通行则不需要。
      out += (line.moreIndented ? "\n" : "") + line.text;
    } else if (previous.moreIndented || line.moreIndented) {
      out += "\n" + line.text;
    } else {
      out += " " + line.text;
    }
  }
  return out;
}

/**
 * 从 `startIndex` 起读取有界的 YAML 块标量主体。
 *
 * @param header 块标量头部文本（决定字面量/折叠与截断方式）
 * @param lines frontmatter 的整行数组
 * @param startIndex 块主体的起始行下标
 * @returns `value` 为标量值，`next` 为块之后第一行的下标
 *
 * 块在第一个「非空且缩进小于块缩进」的行处结束；显式缩进时首行若为非空且
 * 缩进为 0，则说明块为空。
 */
function parseBlockScalar(
  header: string,
  lines: string[],
  startIndex: number,
): { value: string; next: number } {
  const { literal, chomp, indent } = parseBlockScalarHeader(header);

  const body: ContentLine[] = [];
  let blockIndent = indent;
  let index = startIndex;
  while (index < lines.length) {
    const raw = stripTrailingCr(lines[index]);
    if (raw.trim() === "") {
      body.push({ text: "", blank: true, moreIndented: false });
      index++;
      continue;
    }
    const lineIndent = raw.length - raw.trimStart().length;
    if (blockIndent === null) {
      if (lineIndent === 0) break;
      blockIndent = lineIndent;
    }
    if (lineIndent < blockIndent) break;
    body.push({
      text: raw.slice(blockIndent),
      blank: false,
      moreIndented: lineIndent > blockIndent,
    });
    index++;
  }

  // 尾部空行走「截断」而不是「折叠」，所以先剪掉再拼接。
  let end = body.length;
  while (end > 0 && body[end - 1].blank) end--;
  const trailingBlanks = body.length - end;
  const content = body.slice(0, end);

  const joined = literal ? joinLiteral(content) : foldLines(content);
  let suffix = "";
  if (chomp === "keep") {
    // keep 保留块自身的全部尾部换行：末行内容自己的换行（有内容时才有），
    // 加上每个尾部空行各一个换行。纯空行的 keep 块则原样保留其空行数。
    const breaks = (content.length > 0 ? 1 : 0) + trailingBlanks;
    suffix = "\n".repeat(breaks);
  } else if (chomp === "clip" && content.length > 0) {
    // clip 对非空块保留恰好一个末尾换行；纯空行的 clip 块为空串。
    suffix = "\n";
  }
  // strip（以及纯空行的 clip）保留空前缀。

  return { value: joined + suffix, next: index };
}

/**
 * 定位技能目录里的 SKILL.md（文件名不区分大小写，`skill.md` 等价）。
 *
 * @param skillPath 技能目录
 * @returns 实际文件路径；不存在时为 `null`
 */
export function resolveSkillMdPath(skillPath: string): string | null {
  const exact = join(skillPath, "SKILL.md");
  if (existsSync(exact)) return exact;
  try {
    for (const entry of readdirSync(skillPath)) {
      if (entry.toLowerCase() === "skill.md") return join(skillPath, entry);
    }
  } catch {
    // 目录读不到按「没有 SKILL.md」处理，具体错误由调用方报。
  }
  return null;
}

/**
 * 解析 SKILL.md，返回技能名、描述与文件原文。
 *
 * description 既可以是单行标量，也可以是 `|`/`>` 块标量（头部语法见上），其截断、
 * 空行与缩进更深的行都按 YAML 参考实现在该子集下的行为处理。
 *
 * @param skillPath 技能目录（其下应有 `SKILL.md`）
 * @returns 名称、描述与未经改写的 `fullContent`
 * @throws 缺少开头或结尾的 `---` 分隔符时抛出错误
 */
export function parseSkillMd(skillPath: string): SkillMeta {
  const skillMdPath = resolveSkillMdPath(skillPath);
  if (skillMdPath === null) throw new Error("SKILL.md not found");
  const content = readFileSync(skillMdPath, "utf-8");
  const lines = content.split("\n");

  if (lines[0].trim() !== "---") {
    throw new Error("SKILL.md missing frontmatter (no opening ---)");
  }

  let endIdx: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }

  if (endIdx === null) {
    throw new Error("SKILL.md missing frontmatter (no closing ---)");
  }

  let name = "";
  let description = "";
  const frontmatterLines = lines.slice(1, endIdx);
  let i = 0;

  while (i < frontmatterLines.length) {
    const line = frontmatterLines[i];

    if (line.startsWith("name:")) {
      name = line.slice("name:".length).trim().replace(/^['"]|['"]$/g, "");
    } else if (line.startsWith("description:")) {
      const value = line.slice("description:".length).trim();

      if (BLOCK_SCALAR_HEADER_RE.test(value)) {
        const parsed = parseBlockScalar(value, frontmatterLines, i + 1);
        description = parsed.value;
        i = parsed.next;
        continue;
      } else {
        description = value.replace(/^['"]|['"]$/g, "");
      }
    }
    i++;
  }

  return { name, description, fullContent: content };
}
