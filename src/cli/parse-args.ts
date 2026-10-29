/**
 * 把工具收到的单个 `args` 字符串解析成「子命令 + 位置参数 + 标志」。
 *
 * 工具只暴露一个字符串入参（见 docs/SPEC.md R1），所有分词与标志识别都在这里做，
 * 子命令实现只消费结构化结果。
 */

import type { FlagValue, ParsedArgs } from "./types.js";

/** 可作为参数边界的引号字符（含空格参数用它包裹）。 */
const QUOTE_CHARS: ReadonlySet<string> = new Set(['"', "'"]);

/** 标志前缀；只有一个 `--` 时按位置参数处理，避免产生空名标志。 */
const FLAG_PREFIX = "--";

/**
 * 按空白切分参数，引号内的空白不切分，引号本身不进入结果。
 *
 * 未闭合的引号不做报错（等价于「引号一直延续到结尾」）：工具层的解析失败一律由
 * `dispatch` 用三段式回报，这里保持纯函数、不产生半成品错误文案。
 *
 * @param input 原始 `args` 字符串
 * @returns 切分后的 token 列表（已去掉引号）
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: string | null = null;

  for (const char of input) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (QUOTE_CHARS.has(char)) {
      quote = char;
      // 空引号 `""` 也要产出一个空字符串 token，因此单独记录「有过内容」。
      hasCurrent = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (hasCurrent) {
        tokens.push(current);
        current = "";
        hasCurrent = false;
      }
      continue;
    }

    current += char;
    hasCurrent = true;
  }

  if (hasCurrent) tokens.push(current);
  return tokens;
}

/**
 * 解析一次工具调用的参数。
 *
 * 支持 `--flag value`、`--flag=value` 与单独 `--flag`（值为 `true`）；首段不是标志时作为子命令，
 * 其余非标志 token 进 `positionals`。空串返回 `command: ""`，由调用方等价 `help`。
 *
 * @param args 工具收到的原始 `args` 字符串，例如 `validate ./skills/demo --strict`
 * @returns 子命令、位置参数与标志；同一标志重复出现时后者覆盖前者
 */
export function parseArgs(args: string): ParsedArgs {
  const tokens = tokenize(args);
  const [command = "", ...rest] = tokens;
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  // TODO(B3): 首 token 是标志时（如 `--runs 3 validate`）目前会被当成子命令，
  // 进而落到「未知子命令」；等子命令实现接入后按需改成「先跳过标志再取子命令」。

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;

    if (!token.startsWith(FLAG_PREFIX) || token === FLAG_PREFIX) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(FLAG_PREFIX.length);
    const equalsAt = body.indexOf("=");

    // `--=v` 会得到空名标志，语义上等于没有名字，按位置参数处理。
    if (equalsAt === 0) {
      positionals.push(token);
      continue;
    }

    if (equalsAt > 0) {
      // `--flag=value`：等号右侧整段都是值，允许为空串。
      flags[body.slice(0, equalsAt)] = body.slice(equalsAt + 1);
      continue;
    }

    const next = rest[index + 1];
    // 只有紧跟的 token 不以 `--` 开头时才当作取值，否则视为布尔标志。
    if (next !== undefined && !next.startsWith(FLAG_PREFIX)) {
      flags[body] = next;
      index += 1;
      continue;
    }

    flags[body] = true;
  }

  return { command, positionals, flags };
}
