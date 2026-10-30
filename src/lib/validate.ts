/**
 * SKILL.md 校验 —— 检查 frontmatter 与结构是否合规。
 *
 * 与上游 `scripts/quick_validate.py` 口径保持一致；frontmatter 用手写解析
 * （与 `lib/utils.ts` 同风格，不引入 YAML 库）。
 */

import { readFileSync } from "node:fs";

import { resolveSkillMdPath } from "./utils.js";

/** 校验结果：`valid` 为结论，`message` 为给用户看的一句说明。 */
export interface ValidationResult {
  valid: boolean;
  message: string;
}

/** frontmatter 允许出现的顶层键。 */
const ALLOWED_PROPERTIES = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
]);

/**
 * 判断取值是否被引号整体包住。
 *
 * 有意只做首尾字符判断：本校验器是针对常见 frontmatter 错误的 lint 启发式，
 * 不是完整的 YAML 解析器。
 *
 * @param value 冒号后的取值文本
 * @returns 被成对单引号或双引号包住时为 `true`
 */
function isQuotedValue(value: string): boolean {
  return (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  );
}

/**
 * 判断取值是否为块标量头部。
 *
 * 头部允许缩进指示符（`1-9`）与截断指示符（`+`/`-`），两者顺序任意。
 *
 * @param value 冒号后的取值文本
 * @returns 是块标量头部时为 `true`
 */
function isBlockScalarMarker(value: string): boolean {
  return /^[|>](?:[1-9][+-]?|[+-][1-9]?)?$/.test(value);
}

/**
 * 校验一个技能目录。
 *
 * 检查 `SKILL.md` 是否存在、frontmatter 是否成形、必填字段是否齐全，并按规则
 * 校验命名、描述长度等。
 *
 * @param skillPath 技能目录（其下应有 `SKILL.md`）
 * @returns 校验结论与一句说明；不抛错
 */
export function validateSkill(skillPath: string): ValidationResult {
  const skillMdPath = resolveSkillMdPath(skillPath);

  // 先确认文件在不在（大小写不敏感：skill.md 与 SKILL.md 等价）
  if (skillMdPath === null) {
    return { valid: false, message: "未找到 SKILL.md" };
  }

  // 开头就把 CRLF（Windows 上 autocrlf 检出）统一成 LF：下面的正则与切分都
  // 假定是 \n，残留的 \r 要么直接判掉合法 frontmatter，要么破坏逐行的键值匹配。
  const content = readFileSync(skillMdPath, "utf-8").replace(/\r\n/g, "\n");
  if (!content.startsWith("---")) {
    return { valid: false, message: "缺少 YAML frontmatter（文件第 1 行必须是 ---）" };
  }

  // 取出 frontmatter 文本
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return { valid: false, message: "frontmatter 格式不正确：找不到结束的 ---" };
  }

  const frontmatterText = match[1];

  // 逐行解析键值对（简单按行处理，不做完整 YAML 解析）
  const frontmatter: Record<string, string> = {};
  let currentKey = "";
  let currentValue = "";
  let inMultiline = false;

  const frontmatterLines = frontmatterText.split("\n");
  for (const [index, line] of frontmatterLines.entries()) {
    if (inMultiline) {
      if (line.startsWith("  ") || line.startsWith("\t")) {
        currentValue += " " + line.trim();
        continue;
      } else {
        frontmatter[currentKey] = currentValue.trim();
        inMultiline = false;
      }
    }

    // 宽松顶层键探测：先收集**所有**「键: 值」形式的顶层行，键名合规性留到收集完再判。
    // 原实现直接用小写开头正则过滤，`Allowed-tools:` 这类键两个分支都不匹配，整行被
    // 静默丢弃，校验仍报「通过」（假通过）。这里前导空白仍归下面的嵌套键分支。
    const kvMatch = line.match(/^([^\s:#][^:]*?)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (
        value &&
        !isQuotedValue(value) &&
        !isBlockScalarMarker(value) &&
        (/:[ \t]/.test(value) || value.endsWith(":"))
      ) {
        return {
          valid: false,
          // +2：frontmatter 从文件第 2 行开始（开头 `---` 之后）。
          message: `frontmatter 第 ${index + 2} 行的 '${currentKey}' 取值不是合法 YAML：含「: 」或以冒号结尾的值会被运行时丢弃，导致该技能不生效。改法：给取值加引号，例如 ${currentKey}: "你的文本"`,
        };
      }

      if (isBlockScalarMarker(value)) {
        currentValue = "";
        inMultiline = true;
      } else if (
        currentKey === "metadata" &&
        (value === "" || value === "{}")
      ) {
        // metadata 是映射类型，只要写了就算存在
        frontmatter[currentKey] = value;
      } else {
        frontmatter[currentKey] = value.replace(/^['"]|['"]$/g, "");
      }
    } else if (line.match(/^\s+\w+\s*:/)) {
      // metadata 下的嵌套键：跳过内容，但保证父键存在
      if (!frontmatter["metadata"]) {
        frontmatter["metadata"] = "(map)";
      }
    }
  }

  if (inMultiline && currentKey) {
    frontmatter[currentKey] = currentValue.trim();
  }

  // 键名先按「合法顶层键」严格判定：宽松探测会把 `Allowed-tools:` 也收进来，这里必须
  // 报错并给出小写写法建议，不能让它静默通过（运行时按 YAML 大小写敏感处理，拼错即失效）。
  const malformedKeys = Object.keys(frontmatter).filter(
    (key) => !/^[a-z][a-z0-9_-]*$/.test(key),
  );
  if (malformedKeys.length > 0) {
    const hints = malformedKeys.map((key) => {
      const lowered = key.toLowerCase();
      return lowered === key ? key : `${key}（应写作 ${lowered}）`;
    });
    return {
      valid: false,
      message: `frontmatter 含不合规的顶层键：${hints.join("、")}。顶层键只能用小写字母、数字、连字符与下划线，且必须以小写字母开头`,
    };
  }

  // 再查未知键：出现非法键时优先报它，避免被后续字段校验掩盖
  const unexpectedKeys = Object.keys(frontmatter).filter(
    (k) => !ALLOWED_PROPERTIES.has(k)
  );
  if (unexpectedKeys.length > 0) {
    return {
      valid: false,
      message: `frontmatter 含不支持的键：${unexpectedKeys.sort().join("、")}。允许的键：${[...ALLOWED_PROPERTIES].sort().join("、")}`,
    };
  }

  // 再查必填字段
  if (!frontmatter["name"]) {
    return { valid: false, message: "frontmatter 缺少必填字段 name" };
  }
  if (!frontmatter["description"]) {
    return { valid: false, message: "frontmatter 缺少必填字段 description" };
  }

  // 校验 name
  const name = frontmatter["name"].trim();
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) {
      return {
        valid: false,
        message: `name「${name}」不是 kebab-case（只允许小写字母、数字与连字符）`,
      };
    }
    if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
      return {
        valid: false,
        message: `name「${name}」不能以连字符开头或结尾，也不能含连续连字符`,
      };
    }
    if (name.length > 64) {
      return {
        valid: false,
        message: `name 过长（${name.length} 字符），上限 64 字符`,
      };
    }
  }

  // 校验 description
  const description = frontmatter["description"].trim();
  if (description) {
    if (description.includes("<") || description.includes(">")) {
      return {
        valid: false,
        message: "description 不能含尖括号（< 或 >）",
      };
    }
    if (description.length > 1024) {
      return {
        valid: false,
        message: `description 过长（${description.length} 字符），上限 1024 字符`,
      };
    }
  }

  // 校验 compatibility（可选字段）
  const compatibility = frontmatter["compatibility"];
  if (compatibility) {
    if (compatibility.length > 500) {
      return {
        valid: false,
        message: `compatibility 过长（${compatibility.length} 字符），上限 500 字符`,
      };
    }
  }

  return { valid: true, message: "技能校验通过" };
}
