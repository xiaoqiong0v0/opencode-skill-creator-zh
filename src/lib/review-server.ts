/**
 * 评测结果审阅服务：把工作区里的各次 run 内联进一个自包含 HTML 页面，并用本地 HTTP
 * 服务提供浏览与反馈收集。
 *
 * 迁自上游 `plugin/lib/review-server.ts`（基线 `d4383924`），等价于上游对
 * `eval-viewer/generate_review.py` 的移植；**行为保持不变**：每次页面请求都重新扫描
 * 工作区并重新生成 HTML，反馈通过 `POST /api/feedback` 落盘到工作区的
 * `feedback.json`。无第三方运行时依赖。
 *
 * 两处必须记住的上游事实：
 *   - 服务只监听 `127.0.0.1`，端口默认 3117；端口被占用时**报错而不是杀掉占用进程**
 *     （上游早期用 `lsof -ti | SIGTERM`，会误杀同端口上的无关服务，已废弃）。
 *   - 打开浏览器是**交互式工具**的默认行为（`openBrowser` 默认 `true`），自动化调用方
 *     必须显式传 `openBrowser: false` 或设 `OPENCODE_SKILL_CREATOR_OPEN_BROWSER=0`，
 *     否则会真的弹出用户浏览器。
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename, extname, join, relative } from "node:path";

/** 输出目录里不作为内容展示的元数据文件。 */
const METADATA_FILES = new Set(["transcript.md", "user_notes.md", "metrics.json"]);

/** 以文本形式内联展示的扩展名。 */
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".csv", ".py", ".js", ".ts", ".tsx", ".jsx",
  ".yaml", ".yml", ".xml", ".html", ".css", ".sh", ".rb", ".go", ".rs",
  ".java", ".c", ".cpp", ".h", ".hpp", ".sql", ".r", ".toml",
]);

/** 以图片形式内联展示的扩展名。 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

/** 反馈请求体的最大字节数；超出返回 413。 */
const MAX_FEEDBACK_BODY_BYTES = 1_000_000;

/** 常见类型的 MIME 覆盖（默认对齐 Node 的扩展名推断）。 */
const MIME_OVERRIDES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 页面里内联的一个输出文件。 */
export interface EmbeddedFile {
  name: string;
  type: "text" | "image" | "pdf" | "xlsx" | "binary" | "error";
  content?: string;
  mime?: string;
  data_uri?: string;
  data_b64?: string;
}

/** 工作区里发现的一次 run。 */
export interface Run {
  id: string;
  prompt: string;
  eval_id: number | string | null;
  outputs: EmbeddedFile[];
  grading: Record<string, unknown> | null;
}

/** 上轮迭代的数据：run id → 上轮反馈与输出。 */
export type PreviousIterationData = Record<
  string,
  { feedback: string; outputs: EmbeddedFile[] }
>;

/** `POST /api/feedback` 请求体里的一条评审。 */
interface FeedbackReviewItem {
  run_id: string;
  feedback: string;
  timestamp?: string;
}

/** `POST /api/feedback` 的请求体。 */
interface FeedbackPayload {
  reviews: FeedbackReviewItem[];
  status?: string;
}

/**
 * 按扩展名推断 MIME 类型。
 *
 * @param filePath 文件路径
 * @returns MIME 类型字符串（未知类型返回 `application/octet-stream`）
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext in MIME_OVERRIDES) return MIME_OVERRIDES[ext];

  // 常见类型的最小对照表，避免为几十个后缀引入依赖。
  const mimeMap: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return mimeMap[ext] ?? "application/octet-stream";
}

/**
 * 读取一个输出文件并转成可内联进 HTML 的结构。
 *
 * 读取失败不抛异常，而是返回 `type: "error"` 的条目，让页面显示「读取失败」而不是
 * 让整个审阅页打不开。
 *
 * @param filePath 文件绝对路径
 * @returns 内联文件对象
 */
function embedFile(filePath: string): EmbeddedFile {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = getMimeType(filePath);

  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      return { name, type: "text", content };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const raw = readFileSync(filePath);
      const b64 = raw.toString("base64");
      return { name, type: "image", mime, data_uri: `data:${mime};base64,${b64}` };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  if (ext === ".pdf") {
    try {
      const raw = readFileSync(filePath);
      const b64 = raw.toString("base64");
      return { name, type: "pdf", data_uri: `data:${mime};base64,${b64}` };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  if (ext === ".xlsx") {
    try {
      const raw = readFileSync(filePath);
      const b64 = raw.toString("base64");
      return { name, type: "xlsx", data_b64: b64 };
    } catch {
      return { name, type: "error", content: "(Error reading file)" };
    }
  }

  // 其余二进制按 base64 下载链接展示。
  try {
    const raw = readFileSync(filePath);
    const b64 = raw.toString("base64");
    return { name, type: "binary", mime, data_uri: `data:${mime};base64,${b64}` };
  } catch {
    return { name, type: "error", content: "(Error reading file)" };
  }
}

/**
 * 递归查找 run：凡含 `outputs/` 子目录的目录即为一次 run，找到后不再向下深入。
 *
 * @param root 工作区根目录（用于计算 run id）
 * @param current 当前遍历目录
 * @param runs 收集结果（原地追加）
 * @returns 无返回值
 */
function findRunsRecursive(root: string, current: string, runs: Run[]): void {
  if (!existsSync(current) || !statSync(current).isDirectory()) return;

  const outputsDir = join(current, "outputs");
  if (existsSync(outputsDir) && statSync(outputsDir).isDirectory()) {
    const run = buildRun(root, current);
    if (run) runs.push(run);
    return;
  }

  // 这些目录不会产出 run，遍历时跳过以免扫进大量无关文件。
  const skip = new Set(["node_modules", ".git", "__pycache__", "skill", "inputs"]);
  const entries = readdirSync(current).sort();
  for (const entry of entries) {
    const full = join(current, entry);
    if (statSync(full).isDirectory() && !skip.has(entry)) {
      findRunsRecursive(root, full, runs);
    }
  }
}

/**
 * 扫描工作区里的全部 run，并按 `eval_id`（数字优先）与 id 排序。
 *
 * @param workspace 工作区根目录
 * @returns run 列表
 */
function findRuns(workspace: string): Run[] {
  const runs: Run[] = [];
  findRunsRecursive(workspace, workspace, runs);
  runs.sort((a, b) => {
    const aId = typeof a.eval_id === "number" ? a.eval_id : Infinity;
    const bId = typeof b.eval_id === "number" ? b.eval_id : Infinity;
    if (aId !== bId) return aId - bId;
    return a.id.localeCompare(b.id);
  });
  return runs;
}

/**
 * 从 run 目录构造 run 对象：prompt、eval_id、输出文件与 grading。
 *
 * prompt 依次尝试 `eval_metadata.json`（本目录、父目录）与 `transcript.md`
 * （本目录、`outputs/`）里的 `## Eval Prompt` 小节。
 *
 * @param root 工作区根目录
 * @param runDir run 目录
 * @returns run 对象
 */
function buildRun(root: string, runDir: string): Run | null {
  let prompt = "";
  let evalId: number | string | null = null;

  for (const candidate of [
    join(runDir, "eval_metadata.json"),
    join(runDir, "..", "eval_metadata.json"),
  ]) {
    if (existsSync(candidate)) {
      try {
        // 边界断言：元数据文件由评测脚本产出；与上游一致，取值原样透传（非字符串的
        // prompt 也照收），因此这里用断言而不是再校验一遍类型。
        const metadata = JSON.parse(readFileSync(candidate, "utf-8")) as Record<
          string,
          unknown
        >;
        prompt = (metadata.prompt as string | undefined) ?? "";
        evalId = (metadata.eval_id as number | string | null | undefined) ?? null;
      } catch {
        /* 解析失败按「没有元数据」处理 */
      }
      if (prompt) break;
    }
  }

  if (!prompt) {
    for (const candidate of [
      join(runDir, "transcript.md"),
      join(runDir, "outputs", "transcript.md"),
    ]) {
      if (existsSync(candidate)) {
        try {
          const text = readFileSync(candidate, "utf-8");
          const match = text.match(/## Eval Prompt\n\n([\s\S]*?)(?=\n##|$)/);
          if (match) prompt = match[1].trim();
        } catch {
          /* 读取失败按「没有 transcript」处理 */
        }
        if (prompt) break;
      }
    }
  }

  if (!prompt) prompt = "(No prompt found)";

  // run id 用相对工作区的路径，路径分隔符统一换成 `-`。
  const runId = relative(root, runDir).replace(/[/\\]/g, "-");

  const outputsDir = join(runDir, "outputs");
  const outputFiles: EmbeddedFile[] = [];
  if (existsSync(outputsDir) && statSync(outputsDir).isDirectory()) {
    const files = readdirSync(outputsDir).sort();
    for (const f of files) {
      const full = join(outputsDir, f);
      if (statSync(full).isFile() && !METADATA_FILES.has(f)) {
        outputFiles.push(embedFile(full));
      }
    }
  }

  let grading: Record<string, unknown> | null = null;
  for (const candidate of [join(runDir, "grading.json"), join(runDir, "..", "grading.json")]) {
    if (existsSync(candidate)) {
      try {
        // 边界断言：与上游一致，只判断解析结果是否为真，形状异常也照收。
        const parsed: unknown = JSON.parse(readFileSync(candidate, "utf-8"));
        grading = (parsed as Record<string, unknown> | null) ?? null;
      } catch {
        /* 解析失败按「没有 grading」处理 */
      }
      if (grading) break;
    }
  }

  return { id: runId, prompt, eval_id: evalId, outputs: outputFiles, grading };
}

/**
 * 校验 `POST /api/feedback` 的请求体形状：`reviews` 必须是数组，每项含字符串
 * `run_id` 与 `feedback`，可选的 `timestamp` / `status` 必须是字符串。
 *
 * @param value 解析后的请求体
 * @returns 结构合法时返回 `true` 并收窄类型
 */
function isValidFeedbackPayload(value: unknown): value is FeedbackPayload {
  if (typeof value !== "object" || value === null) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "reviews")) return false;

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.reviews)) return false;

  for (const item of record.reviews) {
    if (typeof item !== "object" || item === null) return false;
    const review = item as Record<string, unknown>;
    if (typeof review.run_id !== "string") return false;
    if (typeof review.feedback !== "string") return false;
    if (
      Object.prototype.hasOwnProperty.call(review, "timestamp") &&
      typeof review.timestamp !== "string"
    ) {
      return false;
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(record, "status") &&
    typeof record.status !== "string"
  ) {
    return false;
  }

  return true;
}

/**
 * 读取上一轮迭代的数据（反馈 + 输出），用于页面里的「上轮对照」。
 *
 * 反馈里出现、但本轮已找不到对应 run 的条目也会保留（输出为空），避免历史反馈丢失。
 *
 * @param workspace 上一轮工作区根目录
 * @returns 按 run id 索引的上轮数据
 */
function loadPreviousIteration(workspace: string): PreviousIterationData {
  const result: PreviousIterationData = {};

  const feedbackMap: Record<string, string> = {};
  const feedbackPath = join(workspace, "feedback.json");
  if (existsSync(feedbackPath)) {
    try {
      // 边界断言：feedback.json 由本服务自己的 POST 处理器写出，形状即 `{reviews: [...]}`。
      const data = JSON.parse(readFileSync(feedbackPath, "utf-8")) as {
        reviews?: Array<{ run_id: string; feedback?: string }>;
      };
      for (const r of data.reviews ?? []) {
        const feedback = r.feedback;
        if (typeof feedback === "string" && feedback.trim()) {
          feedbackMap[r.run_id] = feedback;
        }
      }
    } catch {
      /* 损坏的反馈文件按「没有反馈」处理 */
    }
  }

  const prevRuns = findRuns(workspace);
  for (const run of prevRuns) {
    result[run.id] = {
      feedback: feedbackMap[run.id] ?? "",
      outputs: run.outputs ?? [],
    };
  }

  // 有反馈但本轮找不到 run 的条目也保留下来。
  for (const [runId, fb] of Object.entries(feedbackMap)) {
    if (!(runId in result)) {
      result[runId] = { feedback: fb, outputs: [] };
    }
  }

  return result;
}

/**
 * 把 run 数据内联进审阅页模板，生成完整 HTML。
 *
 * 模板里 `/*__EMBEDDED_DATA__*\/` 占位符被替换为 `const EMBEDDED_DATA = {...};`，
 * 因此页面不依赖任何外部数据文件，可直接双击打开或由 HTTP 服务返回。
 *
 * @param opts run 列表、技能名、上轮数据、benchmark 与模板路径
 * @returns 生成的 HTML 文本
 */
export function generateReviewHtml(opts: {
  runs: Run[];
  skillName: string;
  previous?: PreviousIterationData | null;
  benchmark?: Record<string, unknown> | null;
  templatePath: string;
}): string {
  const { runs, skillName, previous, benchmark, templatePath } = opts;

  const template = readFileSync(templatePath, "utf-8");

  const previousFeedback: Record<string, string> = {};
  const previousOutputs: Record<string, EmbeddedFile[]> = {};
  if (previous) {
    for (const [runId, data] of Object.entries(previous)) {
      if (data.feedback) previousFeedback[runId] = data.feedback;
      if (data.outputs?.length) previousOutputs[runId] = data.outputs;
    }
  }

  const embedded: Record<string, unknown> = {
    skill_name: skillName,
    runs,
    previous_feedback: previousFeedback,
    previous_outputs: previousOutputs,
  };
  if (benchmark) embedded.benchmark = benchmark;

  const dataJson = JSON.stringify(embedded);
  return template.replace("/*__EMBEDDED_DATA__*/", `const EMBEDDED_DATA = ${dataJson};`);
}

/** 请求体超过 `MAX_FEEDBACK_BODY_BYTES` 时抛出的错误（映射为 413）。 */
class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
    Object.setPrototypeOf(this, PayloadTooLargeError.prototype);
  }
}

/**
 * 读取请求体，超过上限时以 `PayloadTooLargeError` reject。
 *
 * @param stream 请求流
 * @param maxBytes 允许的最大字节数（按 utf-8 字节计）
 * @returns 请求体文本
 */
function readStream(stream: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let rejected = false;
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      if (rejected) return;
      const chunkBytes = Buffer.byteLength(chunk, "utf-8");
      if (bytes + chunkBytes > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError());
        return;
      }
      bytes += chunkBytes;
      body += chunk;
    });
    stream.on("end", () => {
      if (!rejected) resolve(body);
    });
    stream.on("error", reject);
  });
}

/**
 * 判断错误是否为端口被占用（EADDRINUSE）。
 *
 * @param error 待判断的错误
 * @returns 是 `EADDRINUSE` 时返回 `true`
 */
function isAddressInUse(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

/** 处理一次审阅请求所需的上下文。 */
interface ReviewRequestContext {
  workspace: string;
  skillName: string;
  feedbackPath: string;
  previous: PreviousIterationData | null;
  benchmarkPath?: string | null;
  templatePath: string;
}

/** 与传输层无关的响应描述（便于单测直接调用处理函数）。 */
interface ReviewResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * 构造 JSON 响应。
 *
 * @param body 会被 `JSON.stringify` 的响应体
 * @param status HTTP 状态码
 * @returns 响应描述
 */
function jsonResponse(body: unknown, status = 200): ReviewResponse {
  return {
    status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * 构造文本响应。
 *
 * @param body 响应体
 * @param status HTTP 状态码
 * @param contentType Content-Type 头
 * @returns 响应描述
 */
function textResponse(
  body: string,
  status = 200,
  contentType = "text/plain",
): ReviewResponse {
  return {
    status,
    headers: { "Content-Type": contentType },
    body,
  };
}

/**
 * 路由一次审阅请求（与传输层解耦，便于直接单测）。
 *
 * 路由表：`GET /`、`GET /index.html` 返回页面；`GET /api/feedback` 返回反馈原文；
 * `POST /api/feedback` 校验并落盘反馈；其余 404。
 *
 * @param method HTTP 方法
 * @param requestUrl 请求 URL（可只带路径）
 * @param requestBody 已读取的请求体（非 POST 时为空串）
 * @param context 审阅上下文
 * @returns 响应描述
 */
async function handleReviewRequest(
  method: string,
  requestUrl: string,
  requestBody: string,
  context: ReviewRequestContext,
): Promise<ReviewResponse> {
  const url = new URL(requestUrl, "http://localhost");

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const runs = findRuns(context.workspace);

    let benchmark: Record<string, unknown> | null = null;
    if (context.benchmarkPath && existsSync(context.benchmarkPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(context.benchmarkPath, "utf-8"));
        benchmark = (parsed as Record<string, unknown> | null) ?? null;
      } catch {
        /* 基准文件损坏时按「没有基准」处理 */
      }
    }

    const html = generateReviewHtml({
      runs,
      skillName: context.skillName,
      previous: context.previous,
      benchmark,
      templatePath: context.templatePath,
    });

    return textResponse(html, 200, "text/html; charset=utf-8");
  }

  if (method === "GET" && url.pathname === "/api/feedback") {
    let data = "{}";
    if (existsSync(context.feedbackPath)) {
      try {
        data = readFileSync(context.feedbackPath, "utf-8");
      } catch {
        /* 读取失败时回空对象 */
      }
    }
    return textResponse(data, 200, "application/json");
  }

  if (method === "POST" && url.pathname === "/api/feedback") {
    let body: unknown;
    try {
      body = JSON.parse(requestBody);
    } catch (e) {
      return jsonResponse({ error: String(e) }, 400);
    }

    if (!isValidFeedbackPayload(body)) {
      return jsonResponse(
        { error: "Expected JSON object with a valid 'reviews' array" },
        400,
      );
    }

    try {
      // 两空格缩进 + 结尾换行，保证落盘文件可读且与上游一致。
      writeFileSync(context.feedbackPath, JSON.stringify(body, null, 2) + "\n");
    } catch (e) {
      return jsonResponse({ error: String(e) }, 500);
    }

    return jsonResponse({ ok: true });
  }

  return textResponse("Not Found", 404);
}

/**
 * Node HTTP 处理器：读取请求体（仅 POST）、交给路由、写回响应。
 *
 * @param req 请求对象
 * @param res 响应对象
 * @param context 审阅上下文
 * @returns 处理完成后兑现的 promise
 */
async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReviewRequestContext,
): Promise<void> {
  try {
    const body =
      req.method === "POST" ? await readStream(req, MAX_FEEDBACK_BODY_BYTES) : "";
    const result = await handleReviewRequest(req.method ?? "GET", req.url ?? "/", body, context);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e) }));
  }
}

/**
 * 在 `127.0.0.1` 上监听端口。
 *
 * @param server HTTP 服务
 * @param port 端口（0 表示让系统挑一个空闲端口）
 * @returns 监听成功后兑现的 promise
 */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("error", onError);
      reject(error);
    };

    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * 绑定端口，并把「端口被占用」翻译成可操作的提示。
 *
 * OpenCode 与用户其它服务并存，上游早期用 `lsof -ti | SIGTERM` 腾端口，会杀掉同端口上
 * 的无关进程；现在改成只监听、不碰其它进程，占用时明确报错（提示传 `port: 0` 让系统
 * 挑空闲端口）。
 *
 * @param server HTTP 服务
 * @param port 期望端口
 * @returns 绑定成功后兑现的 promise
 */
async function bindReviewServer(server: Server, port: number): Promise<void> {
  try {
    await listen(server, port);
    return;
  } catch (error) {
    if (isAddressInUse(error)) {
      throw new Error(
        `Review server port ${port} is already in use by another process. Stop that process or pass a different port (skill_serve_review accepts a "port" argument, and port 0 picks a free port).`,
      );
    }
    throw error;
  }
}

/**
 * 关闭服务：先销毁所有已建立连接（否则 keep-alive 连接会让 close 挂住），再关闭监听。
 *
 * @param server HTTP 服务
 * @param sockets 已建立的连接集合
 * @returns 关闭完成后兑现的 promise
 */
function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** `serveReview` 的入参。 */
export interface ServeReviewOptions {
  /** 工作区目录（每次请求都重新扫描）。 */
  workspace: string;
  /** 监听端口，默认 3117；传 0 让系统挑空闲端口。 */
  port?: number;
  /** 页面标题用的技能名；缺省时从工作区目录名推导。 */
  skillName?: string;
  /** 上一轮工作区目录，用于页面里的「上轮对照」。 */
  previousWorkspace?: string | null;
  /** benchmark.json 路径，提供时内联进页面。 */
  benchmarkPath?: string | null;
  /** HTML 模板路径（模板里须含 `/*__EMBEDDED_DATA__*\/` 占位符）。 */
  templatePath: string;
  /**
   * 是否在启动后用默认浏览器打开审阅页。面向交互式 `skill_serve_review` 默认 `true`；
   * 自动化/库调用方传 `false`（或设环境变量
   * `OPENCODE_SKILL_CREATOR_OPEN_BROWSER=0`），以免测试弹出用户浏览器。
   */
  openBrowser?: boolean;
  /**
   * 测试接缝：替换浏览器启动器（默认用 `browserOpenCommand` 的平台命令）。启动器必须把
   * 异步失败（例如找不到可执行文件）交给 `onError`，好让审阅服务继续存活并提示手动打开。
   */
  openBrowserImpl?: (url: string, onError: (error: Error) => void) => void;
}

/**
 * 判断是否通过环境变量禁止自动打开浏览器。
 *
 * @param env 待检查的环境变量对象，默认当前进程环境
 * @returns 值为 `0` 或 `false` 时返回 `true`
 */
export function browserOpenDisabledByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.OPENCODE_SKILL_CREATOR_OPEN_BROWSER;
  return value === "0" || value === "false";
}

/**
 * 取「用默认浏览器打开 URL」的平台命令。
 *
 * `open` 只在 macOS 存在，Windows 与 Linux 各有自己的启动器；调错平台会得到异步 ENOENT
 * （由 `defaultOpenBrowser` 接住）。导出它是为了测试只断言「命令与参数」而不真的执行。
 *
 * @param url 要打开的地址
 * @param platform 目标平台，默认当前平台
 * @returns 命令名与参数数组
 */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    // `cmd /c start` 会把第一个带引号的参数当成窗口标题，所以先给一个空标题再给 URL。
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * 默认浏览器启动器：spawn 平台命令，失败（同步抛错或异步 error 事件）交给 `onError`。
 *
 * @param url 要打开的地址
 * @param onError 失败回调
 * @returns 无返回值
 */
function defaultOpenBrowser(url: string, onError: (error: Error) => void): void {
  const { command, args } = browserOpenCommand(url);
  let openProc: ChildProcess;
  try {
    openProc = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
  } catch (error) {
    // 同步 spawn 失败（例如 URL 对 `cmd` 而言非法）。
    onError(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  // 启动器缺失（例如无桌面的 Linux）表现为异步 'error' 事件，调用方的 try/catch 抓不到；
  // 必须接住，否则未处理的 'error' 会让进程崩溃。
  openProc.on("error", onError);
  openProc.unref();
}

/**
 * 启动评测审阅 HTTP 服务。
 *
 * 每次页面请求都重新扫描工作区并生成 HTML，因此刷新即可看到新输出，无需重启服务。
 *
 * @param opts 工作区、端口、技能名、上轮/基准路径、模板与打开浏览器开关
 * @returns 服务实例、访问 URL、反馈文件路径与 `stop()` 关闭函数
 */
export async function serveReview(opts: ServeReviewOptions): Promise<{
  server: Server;
  url: string;
  feedbackPath: string;
  stop: () => Promise<void>;
}> {
  const {
    workspace,
    port = 3117,
    skillName: skillNameOpt,
    previousWorkspace,
    benchmarkPath,
    templatePath,
    openBrowser = true,
    openBrowserImpl = defaultOpenBrowser,
  } = opts;

  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }

  const skillName = skillNameOpt ?? basename(workspace).replace(/-workspace$/, "");
  const feedbackPath = join(workspace, "feedback.json");

  let previous: PreviousIterationData | null = null;
  if (previousWorkspace && existsSync(previousWorkspace)) {
    previous = loadPreviousIteration(previousWorkspace);
  }

  const context: ReviewRequestContext = {
    workspace,
    skillName,
    feedbackPath,
    previous,
    benchmarkPath,
    templatePath,
  };
  const server = createServer((req, res) => {
    void handleNodeRequest(req, res, context);
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await bindReviewServer(server, port);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Review server did not bind to a TCP port");
  }
  const actualPort = (address as AddressInfo).port;
  const serverUrl = `http://localhost:${actualPort}`;

  // 只在交互式使用下打开浏览器；自动化调用方通过 `openBrowser: false` 或
  // OPENCODE_SKILL_CREATOR_OPEN_BROWSER=0 关掉。
  if (openBrowser && !browserOpenDisabledByEnv()) {
    // 尽力而为且不阻塞：try/catch 覆盖同步抛错，`onError` 覆盖异步启动失败（缺可执行
    // 文件），这样服务仍然存活、手动 URL 仍然可用。
    const reportOpenFailure = (error: Error): void => {
      console.warn(
        `Could not open the review page automatically (${error.message}). ` +
          `Open it manually: ${serverUrl}`,
      );
    };
    try {
      openBrowserImpl(serverUrl, reportOpenFailure);
    } catch (error) {
      reportOpenFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return {
    server,
    url: serverUrl,
    feedbackPath,
    stop: () => closeServer(server, sockets),
  };
}

/** `exportStaticReview` 的入参。 */
export interface StaticExportOptions {
  /** 工作区目录。 */
  workspace: string;
  /** 导出的 HTML 路径。 */
  outputPath: string;
  /** 页面标题用的技能名；缺省时从工作区目录名推导。 */
  skillName?: string;
  /** 上一轮工作区目录。 */
  previousWorkspace?: string | null;
  /** benchmark.json 路径。 */
  benchmarkPath?: string | null;
  /** HTML 模板路径。 */
  templatePath: string;
}

/**
 * 生成独立的 HTML 文件（不需要起服务）。
 *
 * @param opts 工作区、输出路径、技能名、上轮/基准路径与模板
 * @returns 写出的文件路径
 */
export function exportStaticReview(opts: StaticExportOptions): string {
  const {
    workspace,
    outputPath,
    skillName: skillNameOpt,
    previousWorkspace,
    benchmarkPath,
    templatePath,
  } = opts;

  const skillName = skillNameOpt ?? basename(workspace).replace(/-workspace$/, "");
  const runs = findRuns(workspace);

  if (runs.length === 0) {
    throw new Error(`No runs found in ${workspace}`);
  }

  let previous: PreviousIterationData | null = null;
  if (previousWorkspace && existsSync(previousWorkspace)) {
    previous = loadPreviousIteration(previousWorkspace);
  }

  let benchmark: Record<string, unknown> | null = null;
  if (benchmarkPath && existsSync(benchmarkPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(benchmarkPath, "utf-8"));
      benchmark = (parsed as Record<string, unknown> | null) ?? null;
    } catch {
      /* 基准文件损坏时按「没有基准」处理 */
    }
  }

  const html = generateReviewHtml({
    runs,
    skillName,
    previous,
    benchmark,
    templatePath,
  });

  // 输出目录可能不存在，递归创建。
  const parentDir = join(outputPath, "..");
  mkdirSync(parentDir, { recursive: true });
  writeFileSync(outputPath, html);

  return outputPath;
}


