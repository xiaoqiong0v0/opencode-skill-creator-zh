/**
 * `skill_zh package`：把技能目录按白名单导出成可分发目录（不产出 npm 包）。
 *
 * 三条硬口径：
 *   1. `--out` 必填，且导出目标不能落在源目录内部（否则会自我复制）；
 *   2. 导出前先做与 `validate` 同源的结构检查，不产出半成品；
 *   3. 只导出白名单（`SKILL.md`、`agents/**`、`references/**`、`templates/**`），
 *      白名单外条目跳过并列出来；`references/` 与 `agents/` 都是可选的——只有 `SKILL.md`
 *      的技能同样能导出。安装器元数据永远不在白名单里，所以不会被导出。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { log } from "../lib/logger.js";
import { isPathInside, listSkillBundle, toDisplayPath } from "../lib/skill-install.js";
import { formatError } from "./errors.js";
import type { DispatchResult, HandlerInput } from "./types.js";
import { collectIssues, type Issue } from "./validate.js";

/** 缺 `--out` 时给出的可照抄示例。 */
const PACKAGE_EXAMPLE = "skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer";

/**
 * 判断目录是否存在且至少含一个条目。
 *
 * @param dir 目标目录
 * @returns 存在且非空时为 `true`
 */
function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * 渲染一条校验错误（最多列 5 条，其余计数）。
 *
 * @param issues 错误列表
 * @returns 多行文本
 */
function renderIssues(issues: Issue[]): string[] {
  return issues.slice(0, 5).map((issue) => `  - ${issue.problem}；${issue.fix}`);
}

/**
 * 格式化字节数。
 *
 * @param bytes 字节数
 * @returns 带单位的文本
 */
function formatBytes(bytes: number): string {
  return `${bytes} 字节`;
}

/**
 * `package` 子命令实现。
 *
 * @param input handler 入参（`positionals[0]` 为技能目录，`flags.out` 为导出目标）
 * @returns 成功时的导出清单与下一步，失败时为三段式
 */
export function packageHandler(input: HandlerInput): DispatchResult {
  const target = input.positionals[0];
  if (target === undefined) {
    return {
      ok: false,
      output: formatError("缺少参数 <技能目录>", `运行 ${PACKAGE_EXAMPLE}`),
    };
  }

  const outFlag = input.flags.out;
  if (typeof outFlag !== "string" || outFlag === "") {
    return {
      ok: false,
      output: formatError("缺少参数 --out <产物路径>", `运行 ${PACKAGE_EXAMPLE}`),
    };
  }

  const displaySource = toDisplayPath(target);
  const sourcePath = resolve(input.projectDir, target);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    return {
      ok: false,
      output: formatError(
        `技能目录不存在：${displaySource}`,
        `确认目录拼写，或运行 skill_zh new my-skill --dir ./skills 新建一个后重试`,
      ),
    };
  }

  const displayOut = toDisplayPath(outFlag);
  const outPath = resolve(input.projectDir, outFlag);

  // 先挡导出到源目录内部：否则 copy 会把刚写出的文件再当成源文件，越导越乱。
  if (isPathInside(sourcePath, outPath)) {
    return {
      ok: false,
      output: formatError(
        `导出目标不能是技能目录本身或其子目录：${displayOut}`,
        `换一个源目录之外的路径，例如 ${PACKAGE_EXAMPLE}`,
      ),
    };
  }
  // 反向：--out 是源的祖先（例如 --out ./skills）会把源目录包进产物，同样拒绝。
  if (isPathInside(outPath, sourcePath)) {
    return {
      ok: false,
      output: formatError(
        `导出目标不能是技能目录的祖先目录：${displayOut}`,
        `换一个与源目录互不包含的路径，例如 ${PACKAGE_EXAMPLE}`,
      ),
    };
  }
  if (isNonEmptyDir(outPath)) {
    return {
      ok: false,
      output: formatError(
        `导出目标已存在且非空：${displayOut}`,
        `先自行清理该目录，或改用 --out ./skills-package/${target.replaceAll("\\", "/").split("/").pop() ?? "my-skill"}`,
      ),
    };
  }
  if (existsSync(outPath) && !statSync(outPath).isDirectory()) {
    return {
      ok: false,
      output: formatError(`导出目标已存在且不是目录：${displayOut}`, `换一个目录路径重试，例如 ${PACKAGE_EXAMPLE}`),
    };
  }

  // 与 validate 同源的结构检查：有错误就拒绝导出，不产出半成品。`references/` 不在检查项内
  // ——它是可选目录（简单技能可以只有 SKILL.md），白名单本来就不要求它存在。
  const issues = collectIssues(sourcePath, displaySource);
  const errors = issues.filter((issue) => issue.severity === "error");

  if (errors.length > 0) {
    log.info(`package 校验未通过：${displaySource}（${errors.length} 处错误）`);
    return {
      ok: false,
      output: `错误：导出前校验未通过（${errors.length} 处错误）\n改法：\n${renderIssues(errors).join("\n")}\n可用：skill_zh help`,
    };
  }

  const bundle = listSkillBundle(sourcePath);
  let totalBytes = 0;
  for (const file of bundle.files) {
    const dest = join(outPath, file.relativePath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file.sourcePath, dest);
    totalBytes += file.size;
  }

  log.info(`package 已导出：${sourcePath} → ${outPath}（${bundle.files.length} 个文件）`);

  const lines = [
    `导出 ${displaySource} → ${displayOut}`,
    "自检：SKILL.md 存在；目录名与 frontmatter name 一致；只导出白名单内容",
    `文件（${bundle.files.length} 个，共 ${formatBytes(totalBytes)}）：`,
    ...bundle.files.map((file) => `  ${file.relativePath}  ${formatBytes(file.size)}`),
  ];

  if (bundle.skipped.length > 0) {
    lines.push("跳过（白名单外，未导出）：", ...bundle.skipped.map((entry) => `  ${entry}`));
  } else {
    lines.push("跳过：无（源目录只有白名单内容）");
  }

  lines.push(
    "下一步：",
    `  1. 把 ${displayOut} 复制到 ~/.config/opencode/skills/ 或项目 .opencode/skills/ 下启用`,
    "  2. npm 发布由用户手动执行（本子命令只导出目录，不做 npm 打包、不代发）",
  );

  return { ok: true, output: lines.join("\n") };
}
