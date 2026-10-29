/**
 * `skill_zh install`：把包内 `skill/` 装到用户级技能目录（或 `--dir` 指定的根）。
 *
 * 实际写盘全部在 `lib/skill-install.ts`：本文件只负责参数校验、路径解析与把结果翻成
 * 可读的中文清单。默认不覆盖本地改过的 `SKILL.md`；`--force` 才覆盖且先备份到状态目录。
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { log } from "../lib/logger.js";
import {
  installBundledSkill,
  resolveBundledSkillDir,
  summarizeSkillMdDiff,
  toDisplayPath,
  type SkillConflict,
  type SkillInstallResult,
} from "../lib/skill-install.js";
import { formatError } from "./errors.js";
import type { DispatchResult, HandlerInput } from "./types.js";

/** 缺 `--dir` 取值时的示例。 */
const INSTALL_EXAMPLE = "skill_zh install --dir ./skills";

/**
 * 展开 `~` 前缀（`~` / `~/x` / `~\\x`），其它写法原样返回。
 *
 * @param path 用户输入路径
 * @param home home 目录
 * @returns 展开后的路径
 */
function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/**
 * 渲染同名技能冲突：只提示、不改写，处置动作只给真正生效的 5 类。
 *
 * @param conflicts 探测结果
 * @returns 文本行（没有生效冲突时为空数组）
 */
function renderConflicts(conflicts: SkillConflict[]): string[] {
  const active = conflicts.filter((conflict) => conflict.enabled);
  if (active.length === 0) return [];

  const lines = [`探测：发现 ${active.length} 处当前生效的同名技能（只提示，不改写任何外部目录）`];
  for (const conflict of conflicts) {
    const status = conflict.enabled
      ? conflict.effective
        ? "当前生效：是"
        : "当前生效：否"
      : "已被环境变量关闭，不算冲突";
    lines.push(`  ${toDisplayPath(conflict.path)}（${conflict.sourceLabel}，${status}）`);
  }

  const sample = toDisplayPath(active[0]?.path ?? "<冲突目录>");
  lines.push(
    "处置（任选其一）：",
    `  - 把 ${sample}/SKILL.md 改名为 SKILL.md.disabled`,
    `  - 把 ${sample} 整个移出任何 skills/ 路径`,
    `  - 改 ${sample}/SKILL.md 的 frontmatter name（避免同名覆盖，不等于禁用）`,
    "  - 在 OpenCode 配置里用 permission deny 拦掉该技能",
    "  - 设 OPENCODE_DISABLE_EXTERNAL_SKILLS=1（只关 .claude 用 OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1）",
  );
  return lines;
}

/**
 * 渲染文件处置清单。
 *
 * @param files 文件结果
 * @param dryRun 是否为预览
 * @returns 文本行
 */
function renderFiles(files: SkillInstallResult["files"], dryRun: boolean): string[] {
  const writeVerb = dryRun ? "将写入" : "写入";
  const skipVerb = dryRun ? "将跳过" : "跳过";
  const toWrite = files.filter((file) => file.action === "write").map((file) => file.relativePath);
  const same = files.filter((file) => file.action === "same").map((file) => file.relativePath);
  const kept = files.filter((file) => file.action === "keep-user").map((file) => file.relativePath);
  const lines: string[] = [];

  lines.push(`${writeVerb}（${toWrite.length}）：${toWrite.join("  ") || "无"}`);
  if (same.length > 0) lines.push(`${skipVerb}：${same.join("  ")}（内容一致）`);
  if (kept.length > 0) lines.push(`${skipVerb}：${kept.join("  ")}（本地已改动，保留）`);
  return lines;
}

/**
 * `install` 子命令实现。
 *
 * @param input handler 入参（`flags.dir` 为目标根、`flags["dry-run"]` 预览、`flags.force` 覆盖）
 * @returns 安装结果与下一步，参数或环境有问题时为三段式
 */
export function installHandler(input: HandlerInput): DispatchResult {
  const dirFlag = input.flags.dir;
  if (dirFlag === true) {
    return {
      ok: false,
      output: formatError("缺少参数 --dir <目标根>", `运行 ${INSTALL_EXAMPLE}`),
    };
  }
  if (dirFlag !== undefined && typeof dirFlag !== "string") {
    return {
      ok: false,
      output: formatError("参数 --dir 取值非法", `运行 ${INSTALL_EXAMPLE}`),
    };
  }
  if (typeof dirFlag === "string" && dirFlag.trim() === "") {
    return {
      ok: false,
      output: formatError("参数 --dir 不能为空", `运行 ${INSTALL_EXAMPLE}`),
    };
  }

  const skillsRoot =
    dirFlag === undefined ? undefined : resolve(input.projectDir, expandTilde(dirFlag, homedir()));
  const sourceDir = resolveBundledSkillDir();
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    return {
      ok: false,
      output: formatError(
        `包内技能目录不存在：${toDisplayPath(sourceDir)}`,
        "重装本包（npm i -g @xiaoqiong0v0/opencode-skill-creator-zh@latest）后再试",
      ),
    };
  }

  const dryRun = input.flags["dry-run"] === true;
  const force = input.flags.force === true;

  let result: SkillInstallResult;
  try {
    result = installBundledSkill({
      sourceDir,
      skillsRoot,
      force,
      dryRun,
      projectDirs: [input.ctx.directory, input.ctx.worktree],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("install 失败", error instanceof Error ? error : new Error(message));
    return {
      ok: false,
      output: formatError(`安装失败：${message}`, "确认目标目录可写后重试；预览可先运行 skill_zh install --dry-run"),
    };
  }

  log.info(
    `install ${dryRun ? "(dry-run) " : ""}${result.status}：${result.targetDir}（${result.packageVersion}）`,
  );

  const target = toDisplayPath(result.targetDir);
  const versionText =
    result.previousVersion !== "" && result.previousVersion !== result.packageVersion
      ? `${result.packageVersion}（上次 ${result.previousVersion}）`
      : result.packageVersion;

  const lines: string[] = [];
  if (dryRun) {
    lines.push(`预览（未写盘）：${toDisplayPath(sourceDir)} → ${target}`);
    lines.push(`版本：${versionText}`);
  } else if (result.status === "up-to-date") {
    lines.push(`安装：已是最新（${versionText}）：${target}`);
  } else if (result.status === "kept-user") {
    lines.push(`安装：保留本地 SKILL.md，未覆盖（${versionText}）：${target}`);
  } else if (result.status === "upgraded") {
    lines.push(`安装：已升级（${versionText}）→ ${target}`);
  } else {
    lines.push(`安装：已安装（${versionText}）→ ${target}`);
  }

  lines.push(...renderFiles(result.files, dryRun));

  if (result.skipped.length > 0) {
    lines.push(`${dryRun ? "将跳过" : "跳过"}（白名单外）：${result.skipped.join("  ")}`);
  }
  if (result.cleanedMetadata.length > 0) {
    lines.push(
      `${dryRun ? "将清理" : "清理"}旧版元数据：${result.cleanedMetadata.join("  ")}（元数据${dryRun ? "将迁到" : "已迁到"}技能目录外）`,
    );
  }
  if (result.migratedBackups.length > 0) {
    lines.push(
      `${dryRun ? "将迁移" : "迁移"}旧版备份：${result.migratedBackups
        .map((item) => `${toDisplayPath(item.from)} → ${toDisplayPath(item.to)}`)
        .join("  ")}`,
    );
  }
  if (result.removed.length > 0) {
    lines.push(`${dryRun ? "将删除" : "删除"}（新包不再提供）：${result.removed.join("  ")}`);
  }

  if (result.backupPath !== null) {
    lines.push(
      `${dryRun ? "将备份" : "备份"}：${toDisplayPath(result.backupPath)}（用户改动${dryRun ? "将保存" : "已保存"}到状态目录）`,
    );
  }

  if (result.userModified && !force) {
    const diff = summarizeSkillMdDiff(join(result.targetDir, "SKILL.md"), join(sourceDir, "SKILL.md"));
    lines.push(`本地改动：${diff}`);
    lines.push("改法：确认要换成本包版本再运行 skill_zh install --force（旧文件会备份到状态目录）");
  }

  lines.push(...renderConflicts(result.conflicts));

  lines.push(
    `${dryRun ? "将写入状态" : "状态"}：${toDisplayPath(result.stateFile)}（版本、属主清单与备份都在技能目录外）`,
  );

  if (dryRun) {
    lines.push("下一步：去掉 --dry-run 执行安装：skill_zh install");
  } else if (result.userModified && !force) {
    lines.push("下一步：skill_zh install --force 覆盖本地改动；或保留现状（辅助文件已随包更新）");
  } else {
    lines.push("下一步：重启 OpenCode 使技能重新加载");
  }

  return { ok: true, output: lines.join("\n") };
}
