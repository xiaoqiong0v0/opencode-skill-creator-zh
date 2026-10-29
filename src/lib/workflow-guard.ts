/**
 * 评测评审启动前的工作流守卫。
 *
 * 在打开评审查看器之前，强制要求成对的「带技能 / 基线」运行结构存在，除非显式放行。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 列出目录下满足命名规则的子目录（绝对路径，按字典序排序）。
 *
 * @param dir 待扫描的父目录
 * @param pattern 目录名需匹配的正则；省略则不按名字过滤
 * @returns 匹配的子目录路径数组；目录不存在或不是目录时返回空数组
 */
function sortedDirs(dir: string, pattern?: RegExp): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((full) => statSync(full).isDirectory())
    .filter((full) => (pattern ? pattern.test(basename(full)) : true))
    .sort();
}

/**
 * 判断某个运行配置目录下是否至少有一次运行产物。
 *
 * @param configDir `with_skill` / `without_skill` / `old_skill` 这类配置目录
 * @returns 存在 `run-*` 目录，或存在 `outputs` 目录时为 `true`
 */
function hasAtLeastOneRun(configDir: string): boolean {
  const runDirs = sortedDirs(configDir, /^run-/);
  if (runDirs.length > 0) return true;

  // 未创建 run-N 目录时，任务输出常见的布局是直接给一个 outputs 目录。
  const outputsDir = join(configDir, "outputs");
  return existsSync(outputsDir) && statSync(outputsDir).isDirectory();
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
          issue: "workspace path does not exist",
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
          issue: "workspace path is not a directory",
        },
      ],
      foundConfigs: [],
      searchRoot: workspace,
    };
  }

  let searchRoot = workspace;
  let evalDirs = sortedDirs(searchRoot, /^eval-/);
  if (evalDirs.length === 0) {
    // 兼容「评测目录统一放在 runs/ 下」的布局。
    const runsRoot = join(workspace, "runs");
    const nested = sortedDirs(runsRoot, /^eval-/);
    if (nested.length > 0) {
      searchRoot = runsRoot;
      evalDirs = nested;
    }
  }

  if (evalDirs.length === 0) {
    issues.push({
      evalDir: basename(workspace),
      issue:
        "no eval-* directories found (expected evals with with_skill and baseline runs)",
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
      hasAtLeastOneRun(withSkillDir);

    const hasWithoutSkill =
      existsSync(withoutSkillDir) &&
      statSync(withoutSkillDir).isDirectory() &&
      hasAtLeastOneRun(withoutSkillDir);

    const hasOldSkill =
      existsSync(oldSkillDir) &&
      statSync(oldSkillDir).isDirectory() &&
      hasAtLeastOneRun(oldSkillDir);

    if (!hasWithSkill) {
      issues.push({
        evalDir: basename(evalDir),
        issue: "missing with_skill run outputs",
      });
    }

    if (!hasWithoutSkill && !hasOldSkill) {
      issues.push({
        evalDir: basename(evalDir),
        issue: "missing baseline run outputs (without_skill or old_skill)",
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
