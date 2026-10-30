/**
 * 评测评审启动前的工作流守卫。
 *
 * 在打开评审查看器之前，强制要求成对的「带技能 / 基线」运行结构存在，除非显式放行。
 */

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 列出目录下满足命名规则的子目录（绝对路径，按字典序排序）。
 *
 * 每个目录项都先 `lstat` 再解析：`readdirSync` 会把**断链符号链接**也当成普通目录项
 * 列出来，直接 `statSync` 会跟随链接、目标不存在时抛 `ENOENT`，让守卫的
 * 「返回问题清单」契约失效。因此不可解析的项一律跳过，并把原因交给调用方记进 `issues`
 * （不能静默忽略：用户需要知道工作区里有坏链接）。
 *
 * @param dir 待扫描的父目录
 * @param pattern 目录名需匹配的正则；省略则不按名字过滤
 * @param issues 跳过不可解析目录项时追加一条问题
 * @returns 匹配的子目录路径数组；目录不存在或不是目录时返回空数组
 */
function sortedDirs(
  dir: string,
  pattern?: RegExp,
  issues: WorkflowValidationIssue[] = [],
): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    // 父目录本身不可解析（权限等）：按「没有子目录」处理，由调用方另行报问题。
    return [];
  }

  /** 把底层错误压成一行原因（优先错误码，便于用户搜索与定位）。 */
  const reasonOf = (error: unknown): string =>
    error instanceof Error
      ? ((error as NodeJS.ErrnoException).code ?? error.message)
      : String(error);

  /** 记一条「跳过」：目录项不可解析，或父目录整个列不出来。 */
  const noteSkipped = (label: string, what: string, error: unknown): void => {
    issues.push({
      evalDir: label,
      issue: `${what}，已跳过：${label}（${reasonOf(error)}）`,
    });
  };

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // 父目录存在但列不出来（权限不足等）：与「不可解析的目录项」同口径，跳过并记一条，
    // 而不是让整个守卫抛错。
    noteSkipped(basename(dir), "目录不可读取", error);
    return [];
  }

  const matched: string[] = [];
  for (const name of entries) {
    const full = join(dir, name);

    // lstat 只看目录项本身：链接是否断链由后面的 stat 判断。
    let stats;
    try {
      stats = lstatSync(full);
    } catch (error) {
      noteSkipped(name, "目录项不可解析", error);
      continue;
    }

    // 符号链接 / junction 再跟随目标判定；断链时 stat 抛错，跳过而非让整个守卫抛错。
    // 不能只靠 lstat：那会把「指向目录的合法链接」误判成非目录。
    if (stats.isSymbolicLink()) {
      try {
        stats = statSync(full);
      } catch (error) {
        noteSkipped(name, "目录项不可解析", error);
        continue;
      }
    }

    if (!stats.isDirectory()) continue;
    if (pattern && !pattern.test(basename(full))) continue;
    matched.push(full);
  }

  return matched.sort();
}

/**
 * 判断某个运行配置目录下是否至少有一次运行产物。
 *
 * `outputs/` 只是「未建 `run-N` 时的产物兜底布局」：目录存在但里面一条都没有，
 * 说明这一轮没跑出任何东西，不能算「有运行」——否则守卫会放行一个打开后空白的
 * 评测目录（少报问题）。
 *
 * @param configDir `with_skill` / `without_skill` / `old_skill` 这类配置目录
 * @param issues 跳过不可解析目录项时追加一条问题
 * @returns 存在 `run-*` 目录，或 `outputs` 目录内至少一个条目时为 `true`
 */
function hasAtLeastOneRun(
  configDir: string,
  issues: WorkflowValidationIssue[] = [],
): boolean {
  const runDirs = sortedDirs(configDir, /^run-/, issues);
  if (runDirs.length > 0) return true;

  // 未创建 run-N 目录时，任务输出常见的布局是直接给一个 outputs 目录。
  const outputsDir = join(configDir, "outputs");
  if (!existsSync(outputsDir)) return false;
  try {
    if (!statSync(outputsDir).isDirectory()) return false;
    return readdirSync(outputsDir).length > 0;
  } catch {
    // 不可读 / 不可解析（断链链接、权限不足）按「没有产物」计。
    return false;
  }
}

/** 单条问题：出错的评测目录名与原因。 */
export interface WorkflowValidationIssue {
  evalDir: string;
  issue: string;
}

/** 工作流校验结果。 */
export interface WorkflowValidationResult {
  /** 没有任何问题时为 `true`。 */
  valid: boolean;
  /** 找到的评测目录数量。 */
  evalCount: number;
  /** 逐条问题清单。 */
  issues: WorkflowValidationIssue[];
  /** 实际出现过的运行配置名（去重后排序）。 */
  foundConfigs: string[];
  /** 实际扫描的根目录（workspace 或其下的 runs/）。 */
  searchRoot: string;
}

/**
 * 校验一个对比评测工作区是否具备「带技能 + 基线」的成对运行结构。
 *
 * 优先在 workspace 下找 `eval-*` 目录；找不到时退回 `workspace/runs/`。
 * 每个评测目录必须有 `with_skill` 的运行产物，且 `without_skill` 与 `old_skill`
 * 至少要有一个有运行产物。
 *
 * @param workspace 工作区路径
 * @returns 校验结论、评测目录数、问题清单、出现过的配置名与实际扫描根目录
 */
export function validateComparisonWorkspace(
  workspace: string,
): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];
  const foundConfigs = new Set<string>();

  if (!existsSync(workspace)) {
    return {
      valid: false,
      evalCount: 0,
      issues: [
        {
          evalDir: basename(workspace),
          issue: "工作区路径不存在",
        },
      ],
      foundConfigs: [],
      searchRoot: workspace,
    };
  }

  if (!statSync(workspace).isDirectory()) {
    return {
      valid: false,
      evalCount: 0,
      issues: [
        {
          evalDir: basename(workspace),
          issue: "工作区路径不是目录",
        },
      ],
      foundConfigs: [],
      searchRoot: workspace,
    };
  }

  let searchRoot = workspace;
  let evalDirs = sortedDirs(searchRoot, /^eval-/, issues);
  if (evalDirs.length === 0) {
    // 兼容「评测目录统一放在 runs/ 下」的布局。
    const runsRoot = join(workspace, "runs");
    const nested = sortedDirs(runsRoot, /^eval-/, issues);
    if (nested.length > 0) {
      searchRoot = runsRoot;
      evalDirs = nested;
    }
  }

  if (evalDirs.length === 0) {
    issues.push({
      evalDir: basename(workspace),
      issue:
        "未找到 eval-* 评测目录（应为含 with_skill 与基线运行的评测目录）",
    });
  }

  for (const evalDir of evalDirs) {
    const withSkillDir = join(evalDir, "with_skill");
    const withoutSkillDir = join(evalDir, "without_skill");
    const oldSkillDir = join(evalDir, "old_skill");

    if (existsSync(withSkillDir) && statSync(withSkillDir).isDirectory()) {
      foundConfigs.add("with_skill");
    }
    if (existsSync(withoutSkillDir) && statSync(withoutSkillDir).isDirectory()) {
      foundConfigs.add("without_skill");
    }
    if (existsSync(oldSkillDir) && statSync(oldSkillDir).isDirectory()) {
      foundConfigs.add("old_skill");
    }

    const hasWithSkill =
      existsSync(withSkillDir) &&
      statSync(withSkillDir).isDirectory() &&
      hasAtLeastOneRun(withSkillDir, issues);

    const hasWithoutSkill =
      existsSync(withoutSkillDir) &&
      statSync(withoutSkillDir).isDirectory() &&
      hasAtLeastOneRun(withoutSkillDir, issues);

    const hasOldSkill =
      existsSync(oldSkillDir) &&
      statSync(oldSkillDir).isDirectory() &&
      hasAtLeastOneRun(oldSkillDir, issues);

    if (!hasWithSkill) {
      issues.push({
        evalDir: basename(evalDir),
        issue: "缺少 with_skill 的运行产物",
      });
    }

    if (!hasWithoutSkill && !hasOldSkill) {
      issues.push({
        evalDir: basename(evalDir),
        issue: "缺少基线运行产物（without_skill 或 old_skill）",
      });
    }
  }

  return {
    valid: issues.length === 0,
    evalCount: evalDirs.length,
    issues,
    foundConfigs: [...foundConfigs].sort(),
    searchRoot,
  };
}
