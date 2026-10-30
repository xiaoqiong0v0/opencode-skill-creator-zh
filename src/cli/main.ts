#!/usr/bin/env node
/**
 * 独立 shell 入口 `skill-zh`（npm `bin` 指向本文件编译产物 `dist/cli/main.js`）。
 *
 * 定位：插件仍是主入口（`src/index.ts` 唯一注册工具，见 docs/SPEC.md R1）；本文件只是
 * `runCommand` 的第二个消费方——**不注册任何工具**，只把 argv 送进同一套
 * `parseArgs` → `runCommand`，让长评测（`--runs 3 --workers 4`）能在独立终端里跑、不阻塞会话。
 *
 * 输出与退出码：成功写 stdout、退出码 0；失败写 stderr、退出码 1；三段式文案原样输出，不增删行
 * （唯一的文本替换是把工具名 `skill_zh` 归一成终端里真实存在的 bin 名 `skill-zh`，否则
 * 「可用：skill_zh help」照抄会 command not found）。
 *
 * 路径口径（docs/SPEC.md R6.2-J2）：独立 CLI 没有 `ToolContext`，因此**显式把 `process.cwd()`
 * 当作 `directory`**，不向上查找；cwd 位于 OpenCode 配置/运行时目录时只警告到 stderr，仍继续执行。
 * 这是 `src/cli/**` 里唯一允许读 cwd 的位置（源码门禁按白名单钉死），插件与分发层仍为 0。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "./dispatch.js";
import { formatError } from "./errors.js";
import { parseArgs } from "./parse-args.js";
import type { DispatchContext, DispatchResult } from "./types.js";

/** 包清单位置：编译后 `dist/cli/main.js` 相对其上两级就是仓库/包根。 */
const PACKAGE_JSON_URL = new URL("../../package.json", import.meta.url);

/** `--version` 标志（只看首 token，避免与子命令参数混淆）。 */
const VERSION_FLAG = "--version";

/** 不应作为项目根的 OpenCode 目录，相对用户 home。 */
const OPENCODE_DIRS = [join(".config", "opencode"), ".opencode"] as const;

/** shell 入口名：终端里能直接执行的命令是 bin 的 `skill-zh`，不是工具名 `skill_zh`。 */
const SHELL_ENTRY_NAME = "skill-zh";

/**
 * 工具名在输出里的出现形式；`\b` 保证不误伤 `skill_zh_xxx` 这类更长的标识符。
 */
const TOOL_NAME_PATTERN = /skill_zh\b/g;

/**
 * 把共享文案里的工具名归一成 shell 入口名。
 *
 * `formatError` / `HELP_TEXT` 由插件与 bin 共用，构造器本身不该感知入口；因此在 bin 写结果前
 * 做一次替换，插件路径（`src/tool.ts` → `dispatch`）保持原样。
 *
 * @param text `runCommand` 返回的原始文案
 * @returns 把 `skill_zh`（按词边界）替换成 `skill-zh` 后的文案
 */
function normalizeEntryName(text: string): string {
  return text.replace(TOOL_NAME_PATTERN, SHELL_ENTRY_NAME);
}

/**
 * 判断写流错误是否为下游提前关闭（`| head` 等）。
 *
 * @param error 写流抛出的任意值
 * @returns 错误码为 `EPIPE` 时为 `true`
 */
function isEpipe(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EPIPE";
}

/**
 * 写一段文本：EPIPE 静默吞掉，其它写错误只置退出码 1，不把栈喷到终端。
 *
 * @param stream 目标流（stdout / stderr）
 * @param text 要写入的文本
 */
function writeStream(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text);
  } catch (error) {
    if (!isEpipe(error)) process.exitCode = 1;
  }
}

/**
 * 写流异步错误（`error` 事件）的兜底：同样只处理 EPIPE / 置退出码，不抛栈。
 *
 * @param error 流发出的错误
 */
function ignoreStreamError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") process.exitCode = 1;
}

/**
 * 读取包版本。
 *
 * 不硬编码版本号：`--version` 必须与 `package.json` 同源，否则发版时会漂移。
 *
 * @returns `package.json` 的 `version` 字段
 * @throws 清单缺失、无法解析或版本不是字符串时抛错（由 `main` 转成三段式）
 */
function readPackageVersion(): string {
  const raw = readFileSync(fileURLToPath(PACKAGE_JSON_URL), "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error("package.json 不是对象");
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") throw new Error("package.json 缺少 version");
  return version;
}

/**
 * 判断路径是否等于某目录或位于其下。
 *
 * Windows 路径不区分大小写，统一转小写后比较；比较前先 `resolve` 归一分隔符与 `..`。
 *
 * @param target 待判断的绝对路径
 * @param base 基准目录
 * @returns `target` 等于 `base` 或在其子树内时为 `true`
 */
function isInsideOrEqual(target: string, base: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const t = normalize(target);
  const b = normalize(base);
  return t === b || t.startsWith(`${b}${process.platform === "win32" ? "\\" : "/"}`);
}

/**
 * 生成 cwd 警告：位于 OpenCode 配置/运行时目录时提醒，但不阻断执行。
 *
 * @param cwd 当前工作目录
 * @returns 一行中文警告；不在配置目录时为 `null`
 */
function configDirWarning(cwd: string): string | null {
  const home = homedir();
  const hit = OPENCODE_DIRS.find((relative) => isInsideOrEqual(cwd, join(home, relative)));
  if (hit === undefined) return null;
  return `警告：当前目录位于 OpenCode 配置/运行时目录（${cwd}）。独立的 skill-zh 不做向上查找，相对路径会按这里解析；建议先 cd 到项目目录再执行。`;
}

/**
 * 把结果写到对应流：成功 → stdout，失败 → stderr；两端都保证以换行结尾。
 *
 * 只补一个行尾换行，不添加标题、摘要或额外空行，三段式仍然是原来的三行；空输出不写
 * 孤立换行。入口名归一在这里做，保证终端里照抄的 `skill-zh …` 是真实命令。
 *
 * @param result `runCommand` 的返回值
 */
function writeResult(result: DispatchResult): void {
  if (result.output === "") return;
  const text = normalizeEntryName(result.output);
  writeStream(
    result.ok ? process.stdout : process.stderr,
    text.endsWith("\n") ? text : `${text}\n`,
  );
}

/** 入口主流程：处理 `--version`、打印 cwd 警告、分发并落到退出码。 */
async function main(): Promise<void> {
  // `| head` 等场景下游提前关闭会触发 EPIPE：挂上监听避免未捕获的 stream error 喷栈。
  process.stdout.on("error", ignoreStreamError);
  process.stderr.on("error", ignoreStreamError);

  const argv = process.argv.slice(2);

  if (argv[0] === VERSION_FLAG) {
    try {
      writeStream(process.stdout, `${readPackageVersion()}\n`);
    } catch (error) {
      writeStream(
        process.stderr,
        `${formatError(`读取版本失败：${error instanceof Error ? error.message : String(error)}`, "重新安装本包，或检查 package.json 是否完整")}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  // 独立 CLI 的目录语义：cwd 即项目目录，不向上查找（J2 的独立 CLI 分支）。
  const directory = process.cwd();
  const warning = configDirWarning(directory);
  if (warning !== null) writeStream(process.stderr, `${warning}\n`);

  const ctx: DispatchContext = { directory, worktree: "" };

  try {
    const result = await runCommand(parseArgs(argv), ctx);
    writeResult(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    // 分发层已把 handler 失败转成三段式；这里是最后兜底，绝不把堆栈抛给终端。
    writeStream(
      process.stderr,
      `${formatError(
        `命令执行失败：${error instanceof Error ? error.message : String(error)}`,
        "先用 skill-zh help 确认参数写法，再重试一次",
      )}\n`,
    );
    process.exitCode = 1;
  }
}

// 用 `process.exitCode` 而非 `process.exit()`：让 stdout/stderr 自然冲刷完，避免管道下截断。
await main();
