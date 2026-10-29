/**
 * CLI 层共享类型。
 *
 * 集中放在这里的原因：`parse-args` / `dispatch` / 工具入口三处都要用到同一组类型，
 * 放在某一实现文件里会形成 `tool -> dispatch -> parse-args` 之外的额外依赖方向（循环导入）。
 */

/** 命令行标志的取值：`--flag value` 为字符串，只出现 `--flag` 时为 `true`。 */
export type FlagValue = string | boolean;

/** 参数解析结果：首段为子命令，其余为位置参数与标志。 */
export interface ParsedArgs {
  /** 子命令名（未做合法性校验，保持原样）；调用方用 `isSubcommand` 判定。 */
  command: string;
  /** 非标志参数，按出现顺序排列。 */
  positionals: string[];
  /** 解析出的标志；同名标志后者覆盖前者。 */
  flags: Record<string, FlagValue>;
}

/** 一次子命令调用的结果：`ok=false` 表示失败，但 `output` 同样是给人看的完整文案。 */
export interface DispatchResult {
  /** 是否成功；CLI 调试入口用它决定退出码。 */
  ok: boolean;
  /** 回给模型（或终端）的完整文本，失败时为三段式错误。 */
  output: string;
}

/**
 * 分发层拿到的项目上下文，原样来自工具调用的 `ToolContext`。
 *
 * 口径（见 docs/SPEC.md R6.2-J2）：相对路径一律按 `directory` 解析，取不到再用 `worktree`；
 * **禁止用 `process.cwd()` 推断项目根，禁止向上查找**——上游 `findProjectRoot()` 就是在这上面
 * 把 home 目录当成项目根的（`~/.opencode` 是运行时目录，不是项目根）。
 */
export interface DispatchContext {
  /** 当前会话的项目目录（`ToolContext.directory`），路径解析的**首选**基准。 */
  directory: string;
  /** 项目工作树根（`ToolContext.worktree`），`directory` 为空时的次选基准。 */
  worktree: string;
}

/** 子命令 handler 的入参：解析结果 + 项目上下文，B3/B4 接实现时只从这里取路径。 */
export interface HandlerInput {
  /** 非标志参数，按出现顺序排列。 */
  positionals: string[];
  /** 解析出的标志。 */
  flags: Record<string, FlagValue>;
  /** 已按 `directory` → `worktree` 解析出的项目目录；为空说明调用链没给到目录。 */
  projectDir: string;
  /** 原始上下文，需要区分来源（会话目录 / 工作树）时用。 */
  ctx: DispatchContext;
}

/**
 * 子命令实现签名。
 *
 * 同步实现（`new` / `validate`）直接返回结果；`eval` / `optimize` 需要等待
 * `opencode run`，返回 Promise，由分发层统一 `await`。
 */
export type SubcommandHandler = (input: HandlerInput) => DispatchResult | Promise<DispatchResult>;

