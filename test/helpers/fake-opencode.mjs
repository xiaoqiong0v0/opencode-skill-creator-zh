/**
 * 测试用假 `opencode`：放在 PATH 上，用真实子进程模拟 `opencode run` / `opencode debug skill`。
 *
 * 目的：端到端验证 `runEval` / `runEval` 的子进程管线（行缓冲、触发判定、超时、取消、
 * 镜像落盘、deny 配置），而不调用任何真实模型、不产生费用。
 *
 * 跨平台做法：
 * - POSIX：写一个带 `#!/usr/bin/env node` 的脚本；
 * - Windows：Node 不能直接 spawn `.cmd`（CVE 修复后需 shell），因此把 `node` 可执行文件
 *   硬链接成 `opencode.exe`，再用 `NODE_OPTIONS=--require <bootstrap>` 在 Node 启动最早期
 *   接管：写 scenario 指定的输出后 `process.exit`，不会进入真正的主模块解析。
 *
 * scenario 字段：
 * - `lines`：逐行输出；其中 `{skill}` 替换为当前 cwd 下合成技能名
 * - `exitCode`：退出码（默认 0）
 * - `sleepMs`：输出后等待多久再退出（用于超时/取消/提前结束用例）
 * - `chunkSize`：按块输出（验证跨块拼行）
 * - `noFinalNewline`：去掉末尾换行（验证收尾冲刷）
 * - `ignoreSigterm`：忽略 SIGTERM（验证宽限期后 SIGKILL）
 * - `startLog` / `markerFile` / `argvFile` / `envFile`：观测文件
 * - `debugSkills`：`opencode debug skill` 返回的技能数组
 */

import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** 假 opencode 的 bootstrap 源码（CJS；POSIX 与 Windows 共用）。 */
const BOOTSTRAP_SOURCE = `const fs = require("fs");
const path = require("path");
const scenario = JSON.parse(fs.readFileSync(process.env.SKC_EVAL_SCENARIO, "utf-8"));
const raw = process.argv.slice(2);
const argv = process.env.SKC_FAKE_ARGV_MODE === "node-exe"
  ? [path.basename(process.argv[1] || ""), ...raw]
  : raw;
// Windows 用 node.exe + NODE_OPTIONS=--require 启动：preload 返回后 Node 会继续按
// argv[1] 加载主模块（这里是 "run"，并不存在）。把「找不到的主模块」解析到本文件：
// 它已在模块缓存里，不会二次执行；主模块加载变成空操作，事件循环得以继续跑完定时器。
if (process.env.SKC_FAKE_ARGV_MODE === "node-exe") {
  const Module = require("module");
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    try {
      return originalResolve.call(this, request, ...rest);
    } catch {
      return __filename;
    }
  };
}
const cwd = process.cwd();
if (scenario.startLog) fs.appendFileSync(scenario.startLog, JSON.stringify({ pid: process.pid, cwd }) + "\\n");
let cleanName = "unknown";
try {
  const skills = fs.readdirSync(path.join(cwd, ".opencode", "skills"));
  const synthetic = skills.find((name) => name.includes("-skill-"));
  if (synthetic) cleanName = synthetic;
} catch {}
if (scenario.markerFile) fs.writeFileSync(scenario.markerFile, String(process.pid));
if (scenario.argvFile) fs.writeFileSync(scenario.argvFile, JSON.stringify(argv));
if (scenario.envFile) {
  const rootConfigs = ["opencode.json", "opencode.jsonc"].filter((name) => fs.existsSync(path.join(cwd, name)));
  const instructionFiles = ["local-rules.md"].filter((name) => fs.existsSync(path.join(cwd, name)));
  const instructionContent = instructionFiles.length ? fs.readFileSync(path.join(cwd, "local-rules.md"), "utf-8") : null;
  const denyPath = path.join(cwd, ".opencode", "opencode.json");
  let denyConfig = null;
  try { denyConfig = fs.readFileSync(denyPath, "utf-8"); } catch {}
  fs.writeFileSync(scenario.envFile, JSON.stringify({
    cwd: fs.realpathSync(cwd),
    pwd: process.env.PWD ? fs.realpathSync(process.env.PWD) : null,
    rootConfigs,
    instructionFiles,
    instructionContent,
    testedSkillPresent: fs.existsSync(path.join(cwd, ".opencode", "skills", "demo-skill")),
    denyConfig,
  }));
}
if (argv[0] === "debug" && argv[1] === "skill") {
  if (scenario.debugSkillExitCode) process.exit(scenario.debugSkillExitCode);
  process.stdout.write(JSON.stringify(scenario.debugSkills || []) + "\\n");
  process.exit(0);
}
const lines = Array.isArray(scenario.lines) ? scenario.lines : [];
const payload = lines.map((line) => line.split("{skill}").join(cleanName) + "\\n").join("");
const exitCode = scenario.exitCode === undefined ? 0 : scenario.exitCode;
const writeChunk = (text) => {
  if (!text) return;
  try { fs.writeSync(1, text); } catch { /* 读端提前关闭（提前结束/取消），忽略 */ }
};
const finish = () => {
  if (scenario.sleepMs) setTimeout(() => process.exit(exitCode), scenario.sleepMs);
  else process.exit(exitCode);
};
if (scenario.ignoreSigterm) process.on("SIGTERM", () => {});
if (scenario.chunkSize) {
  let offset = 0;
  const writeNext = () => {
    if (offset >= payload.length) return finish();
    writeChunk(payload.slice(offset, offset + scenario.chunkSize));
    offset += scenario.chunkSize;
    setImmediate(writeNext);
  };
  writeNext();
} else if (payload) {
  writeChunk(scenario.noFinalNewline ? payload.replace(/\\n$/, "") : payload);
  finish();
} else {
  finish();
}
`;

/** 假 opencode 测试台。 */
export function createFakeOpencodeHarness() {
  const root = mkdtempSync(join(tmpdir(), "skill-eval-harness-"));
  const binDir = join(root, "bin");
  const projectRoot = join(root, "project");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const bootstrapPath = join(root, "fake-opencode.js");
  writeFileSync(bootstrapPath, BOOTSTRAP_SOURCE, "utf-8");

  /** 子进程额外环境变量（调用方据此构造 PATH / NODE_OPTIONS）。 */
  const childEnv = {};
  if (process.platform === "win32") {
    const target = join(binDir, "opencode.exe");
    try {
      linkSync(process.execPath, target);
    } catch {
      copyFileSync(process.execPath, target);
    }
    childEnv.NODE_OPTIONS = `--require ${bootstrapPath}`;
    childEnv.SKC_FAKE_ARGV_MODE = "node-exe";
  } else {
    const target = join(binDir, "opencode");
    writeFileSync(target, `#!/usr/bin/env node\n${BOOTSTRAP_SOURCE}`, "utf-8");
    chmodSync(target, 0o755);
    childEnv.SKC_FAKE_ARGV_MODE = "shebang";
  }

  const scenarioPath = join(root, "scenario.json");

  return {
    root,
    binDir,
    projectRoot,
    scenarioPath,
    childEnv,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * 构造一条「读到了合成技能」的 `tool_use` 事件行。
 *
 * @param {string} tool 工具名（`read` 或 `skill`）
 * @returns {string} JSON 行
 */
export function triggerLine(tool = "read") {
  return JSON.stringify({
    type: "tool_use",
    part: { tool, input: { path: "{skill}/SKILL.md" } },
  });
}

/**
 * 把假 opencode 装进当前进程环境，执行主体后原样恢复。
 *
 * @param {ReturnType<typeof createFakeOpencodeHarness>} harness 测试台
 * @param {(scenario: Record<string, unknown>) => unknown} body 用例主体（每次调用前写 scenario）
 * @returns {Promise<unknown>} 主体返回值
 */
export async function withFakeOpencode(harness, body) {
  const previousPath = process.env.PATH;
  const previousScenario = process.env.SKC_EVAL_SCENARIO;
  const previousOptions = process.env.NODE_OPTIONS;
  const previousMode = process.env.SKC_FAKE_ARGV_MODE;

  process.env.PATH = `${harness.binDir}${delimiter}${previousPath ?? ""}`;
  process.env.SKC_EVAL_SCENARIO = harness.scenarioPath;
  if (harness.childEnv.NODE_OPTIONS !== undefined) {
    process.env.NODE_OPTIONS = harness.childEnv.NODE_OPTIONS;
  }
  process.env.SKC_FAKE_ARGV_MODE = harness.childEnv.SKC_FAKE_ARGV_MODE;

  const writeScenario = (scenario) => {
    writeFileSync(
      harness.scenarioPath,
      JSON.stringify({ debugSkills: [], ...scenario }),
      "utf-8",
    );
  };

  try {
    return await body(writeScenario);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousScenario === undefined) delete process.env.SKC_EVAL_SCENARIO;
    else process.env.SKC_EVAL_SCENARIO = previousScenario;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
    if (previousMode === undefined) delete process.env.SKC_FAKE_ARGV_MODE;
    else process.env.SKC_FAKE_ARGV_MODE = previousMode;
  }
}
