/**
 * 用户可见文案的唯一出处：工具名、一行描述、子命令表与完整帮助。
 *
 * 集中在一处的原因：工具注册（`src/tool.ts`）、错误三段式（`src/cli/errors.ts`）、
 * 子命令分发（`src/cli/dispatch.ts`）都引用同一批常量，避免文案各写一份后漂移。
 */

/** 允许的子命令，顺序即 `help` 中的展示顺序。 */
export const SUBCOMMANDS = ["help", "new", "validate", "eval", "optimize", "package", "install"] as const;

/** 子命令名的联合类型（由 `SUBCOMMANDS` 派生，保证与 `help` 顺序同源）。 */
export type Subcommand = (typeof SUBCOMMANDS)[number];

/** 工具名：注册到 OpenCode 后工具列表里显示的名字。 */
export const TOOL_NAME = "skill_zh";

/** 工具列表里显示的一行描述；中文按字符计 ≤ 60（见 docs/SPEC.md R4）。 */
export const TOOL_DESCRIPTION = "中文技能工坊：新建、校验、评测、优化并打包 OpenCode 技能";

/**
 * 判断字符串是否为已知子命令。
 *
 * @param value 待判定的子命令名
 * @returns 是已知子命令时为 `true`，并收窄类型到 {@link Subcommand}
 */
export function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

/** `help` 与空参数时返回的完整用法；每个子命令至少含 1 条可复制示例。 */
export const HELP_TEXT = `skill_zh —— 中文 OpenCode 技能创建工具（CLI 风格单工具）

用法：
  skill_zh help
  skill_zh new <技能名> [--dir <目录>] [--force]
  skill_zh validate <技能目录> [--strict]
  skill_zh eval <技能目录> [--runs N] [--workers N] [--timeout 毫秒] [--model provider/model]
                       [--agent 名称] [--eval-set 路径] [--log-dir 路径] [--no-shadow-guard]
  skill_zh optimize <技能目录> [--iterations N] [--runs N] [--workers N] [--timeout 毫秒]
                       [--model provider/model] [--agent 名称] [--eval-set 路径] [--log-dir 路径]
                       [--no-shadow-guard]
  skill_zh package <技能目录> --out <产物路径>
  skill_zh install [--dry-run] [--force] [--dir <目标根>]

子命令：
  help      显示本帮助，覆盖全部子命令与示例
  new       按中文模板生成技能骨架（SKILL.md + references/），--force 覆盖前留 .bak
  validate  校验 SKILL.md 结构与 frontmatter，--strict 把长度/命名提示升级为错误
  eval      跑触发率评测，输出通过率与失败用例
  optimize  按评测失败反复改写 description（先训练/测试集切分）
  package   只导出白名单内的技能目录（--out 必填，不产出 npm 包）
  install   把包内技能装到用户级技能目录（默认不覆盖本地改动）

示例：
  skill_zh help
  skill_zh new api-doc-writer --dir ./skills
  skill_zh validate ./skills/api-doc-writer
  skill_zh eval ./skills/api-doc-writer --runs 3 --workers 4
  skill_zh eval ./skills/api-doc-writer --eval-set ./evals/eval_set.json --log-dir ./.evals
  skill_zh eval ./skills/api-doc-writer --no-shadow-guard
  skill_zh optimize ./skills/api-doc-writer --iterations 5
  skill_zh optimize ./skills/api-doc-writer --iterations 3 --runs 2 --workers 2
  skill_zh package ./skills/api-doc-writer --out ./skills-package/api-doc-writer
  skill_zh install
  skill_zh install --dry-run
  skill_zh install --force
  skill_zh install --dir ./skills

说明：
  - 7 个子命令均已可用；package 只导出目录，npm 发布由用户手动执行。
  - eval 默认：--runs 1、--workers 1、--timeout 120000 毫秒、评测集 <技能目录>/eval_set.json、
    报告目录 <技能目录>/.evals；同名技能默认自动屏蔽（--no-shadow-guard 关闭）。
  - optimize 默认：--iterations 5、--runs 1、--workers 1、--timeout 120000 毫秒，训练/测试集 6:4 切分，
    报告根目录 <技能目录>/.evals（每次运行在其下建独立子目录）。
  - install 默认：装到 ~/.config/opencode/skills/opencode-skill-creator-zh，元数据写 .skill-zh-state/；
    本地改过 SKILL.md 时默认不覆盖，--force 才覆盖（先备份到状态目录）。
  - 失败一律三段式：错误（哪里不对）→ 改法（可直接照做的命令）→ 可用：skill_zh help。
  - 缺参、路径不存在、参数非法等失败都给出一句可复制执行的改法，例如
    「改法：运行 skill_zh validate ./skills/my-skill」。
  - 出错不打印异常堆栈与内部模块路径。
`;
