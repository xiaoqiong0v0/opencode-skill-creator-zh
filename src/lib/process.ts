/**
 * 子进程执行工具：不带 shell 启动命令、收集 stdout/stderr，并支持超时与调用方取消。
 *
 * 迁自上游 `plugin/lib/process.ts`（基线 `d4383924`），行为保持不变：只在「无法启动」
 * 时 reject，退出码与超时交给调用方判定。
 */

import { spawn } from "node:child_process";

/** `runProcess` 的可选项。 */
interface RunProcessOptions {
  /** 子进程的工作目录。 */
  cwd?: string;
  /** 子进程环境变量。 */
  env?: NodeJS.ProcessEnv;
  /** 超时毫秒数；到点先 SIGTERM，宽限期后仍不退出则 SIGKILL。 */
  timeoutMs: number;
  /** SIGTERM 与 SIGKILL 之间的宽限毫秒数，默认 1000。 */
  killGraceMs?: number;
  /** stderr 保留上限（字符）；超出时只留末尾这一段，默认 64 KiB。 */
  maxStderrChars?: number;
  /** stdout 分块回调；返回真值表示可以提前结束子进程。 */
  onStdoutChunk?: (chunk: string) => boolean | void;
  /**
   * 调用方持有的取消信号。abort 时先要求子进程停止（SIGTERM，宽限期后 SIGKILL），
   * promise 以 `aborted: true` 兑现而不是 reject。调用前就已 abort 的 signal 不会启动
   * 子进程。
   */
  signal?: AbortSignal;
}

/** `runProcess` 的结果。 */
export interface RunProcessResult {
  /** 退出码；进程被信号杀死时为 `null`。 */
  exitCode: number | null;
  /** 完整 stdout（按 utf-8 解码）。 */
  stdout: string;
  /** stderr，最多保留末尾 `maxStderrChars` 个字符。 */
  stderr: string;
  /** 是否因超时结束。 */
  timedOut: boolean;
  /** 是否因 `opts.signal` 取消结束。 */
  aborted: boolean;
}

/**
 * 判断退出码是否表示失败。
 *
 * @param exitCode 子进程退出码（可能为 `null`）
 * @returns 非 0 的已知退出码返回 `true`
 */
export function isFailedExitCode(exitCode: number | null): boolean {
  return exitCode != null && exitCode !== 0;
}

/**
 * 判断一次进程执行是否算失败（超时或非 0 退出码）。
 *
 * @param result `runProcess` 的结果
 * @returns 超时或有非 0 退出码时返回 `true`
 */
export function isFailedProcess(result: RunProcessResult): boolean {
  return result.timedOut || isFailedExitCode(result.exitCode);
}

/**
 * 构造调用 `opencode` 时使用的子进程环境，并把项目根钉到 `cwd`。
 *
 * opencode 从其 `$PWD` 解析项目根（而不是 spawn 的 cwd），继承来的或陈旧的调用方
 * PWD 会把错误项目泄漏进子进程。所有 `opencode` 调用共用这个构造器：`cwd` 永远是子
 * 进程应视作项目根的那个目录（评测根传自己的临时根）。
 *
 * 改编自贡献者提案
 * https://github.com/antongulin/opencode-skill-creator/pull/42
 * （Co-authored-by: sogeisetsu <47493432+sogeisetsu@users.noreply.github.com>）。
 *
 * @param cwd 子进程应视作项目根的目录
 * @returns 继承了当前进程环境、且 `PWD` 指向 `cwd` 的环境对象
 */
export function buildOpencodeEnv(cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, PWD: cwd };
}

/**
 * 不带 shell 启动命令，收集 stdout/stderr，并可按需把 stdout 分块流给解析器。
 *
 * 只在进程无法启动时 reject；退出码与超时由调用方自行处理，超时用 `timedOut` 与
 * 其它 `null` 退出状态区分。
 *
 * @param command 命令与参数（第一项是可执行文件）
 * @param opts 工作目录、环境变量、超时、取消信号与输出回调
 * @returns 退出码、stdout、stderr、超时与取消状态
 */
export function runProcess(
  command: string[],
  opts: RunProcessOptions,
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = command;
    if (!file) {
      reject(new Error("Cannot spawn an empty command"));
      return;
    }

    const maxStderrChars = opts.maxStderrChars ?? 64 * 1024;
    const killGraceMs = opts.killGraceMs ?? 1_000;

    // 调用前就已 abort 的 signal 一律不启动子进程。
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }

    // stdin 必须关闭（"ignore"）。`opencode` 二进制在 stdin 管道打开但未写入时会
    // 阻塞且不产出任何输出 —— 回归测试见 process.test.ts。`stdout`/`stderr` 不是
    // 合法的 spawn 选项键。
    const proc = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let stopRequested = false;
    let killTimeoutId: ReturnType<typeof setTimeout> | undefined;

    const requestStop = (): void => {
      if (settled || stopRequested) return;
      stopRequested = true;
      proc.kill();
      killTimeoutId = setTimeout(() => {
        if (!settled) {
          proc.kill("SIGKILL");
        }
      }, killGraceMs);
    };

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      requestStop();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
      killTimeoutId = setTimeout(() => {
        if (!settled) {
          proc.kill("SIGKILL");
        }
      }, killGraceMs);
    }, opts.timeoutMs);

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const shouldStop = opts.onStdoutChunk?.(chunk);
      if (shouldStop) requestStop();
    });

    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > maxStderrChars) {
        stderr = stderr.slice(-maxStderrChars);
      }
    });

    const detach = (): void => {
      opts.signal?.removeEventListener("abort", onAbort);
    };

    proc.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      detach();
      reject(error);
    });

    proc.on("close", (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
      detach();
      resolve({ exitCode, stdout, stderr, timedOut, aborted });
    });
  });
}
