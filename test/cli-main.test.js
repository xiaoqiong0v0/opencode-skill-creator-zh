/**
 * 独立 shell 入口 `skill-zh`（`dist/cli/main.js`，见 docs/SPEC.md R8）。
 *
 * 全部用例用**真实子进程**跑编译产物，而不是 import `main.ts`：入口的价值就在「独立终端里
 * 起一个进程、按退出码与 stdout/stderr 分流」，进程内 import 会把这两件事都测掉。
 *
 * 不碰真实用户配置目录：cwd 告警用例把 `HOME` / `USERPROFILE` 指到临时目录再 chdir 进去。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** 仓库根（本测试位于 `test/` 下）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 编译后的 bin 入口。 */
const CLI_PATH = join(ROOT, "dist", "cli", "main.js");

/** `package.json` 真值（`--version` 必须与它同源）。 */
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

/** 定稿的 7 个子命令（顺序同 `help`）。 */
const SUBCOMMANDS = ["help", "new", "validate", "eval", "optimize", "package", "install"];

/**
 * 以独立进程执行 bin。
 *
 * @param {string[]} args argv（不含 node 与脚本路径）
 * @param {{cwd?: string, env?: Record<string, string>}} [options] cwd 与环境变量覆盖
 * @returns {import("node:child_process").SpawnSyncReturns<string>} 退出码与 stdout/stderr
 */
function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf-8",
    timeout: 60_000,
  });
}

/**
 * 在临时目录里执行用例并在结束时清理。
 *
 * @param {string} prefix 临时目录前缀
 * @param {(root: string) => void} body 用例体
 */
function withTempDir(prefix, body) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("help 把 7 个子命令写到 stdout，退出码 0", () => {
  const result = runCli(["help"]);

  assert.equal(result.status, 0, `期望退出码 0，实际 ${result.status}；stderr：${result.stderr}`);
  assert.equal(result.stderr, "");
  for (const command of SUBCOMMANDS) {
    assert.match(result.stdout, new RegExp(`^\\s+${command}\\s`, "m"), `help 缺少子命令：${command}`);
    assert.ok(result.stdout.includes(`skill-zh ${command}`), `help 示例不是 shell 入口名：skill-zh ${command}`);
  }
  // 终端里没有 `skill_zh` 这个命令：帮助正文必须全部归一成 bin 名。
  assert.ok(!result.stdout.includes("skill_zh"), "help 仍含工具名 skill_zh，照抄会 command not found");
});

test("未知子命令写 stderr 三段式、退出码 1、stdout 为空", () => {
  const result = runCli(["validat"]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const lines = result.stderr.trimEnd().split("\n");
  assert.equal(lines.length, 3, `三段式应恰好三行，实际：${JSON.stringify(lines)}`);
  assert.match(lines[0], /^错误：未知子命令 "validat"/);
  assert.match(lines[1], /^改法：可用子命令：help \/ new \/ validate \/ eval \/ optimize \/ package \/ install$/);
  assert.equal(lines[2], "可用：skill-zh help");
});

test("new → validate 往返：退出码 0 且生成骨架", () => {
  withTempDir("skill-zh-main-roundtrip-", (root) => {
    const created = runCli(["new", "demo", "--dir", root], { cwd: root });
    assert.equal(created.status, 0, created.stderr);
    assert.ok(existsSync(join(root, "demo", "SKILL.md")), "未生成 SKILL.md");

    const validated = runCli(["validate", join(root, "demo")], { cwd: root });
    assert.equal(validated.status, 0, validated.stderr);
    assert.match(validated.stdout, /：通过/);
  });
});

test("argv 形态按 token 解析：含空格的目录名不被拆开", () => {
  withTempDir("skill-zh-main-space-", (root) => {
    // shell 已去掉引号，交给进程的就是一个含空格的 token；若入口 join 后再分词，这里会碎成两个。
    const created = runCli(["new", "space-demo", "--dir", "./my skills"], { cwd: root });
    assert.equal(created.status, 0, created.stderr);
    assert.ok(
      existsSync(join(root, "my skills", "space-demo", "SKILL.md")),
      "含空格的目录名被拆开，骨架没有落在 ./my skills/space-demo",
    );

    const validated = runCli(["validate", "./my skills/space-demo"], { cwd: root });
    assert.equal(validated.status, 0, validated.stderr);
  });
});

test("--version 与 package.json 版本一致", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), PACKAGE.version);
});

test("cwd 在 OpenCode 配置目录时警告到 stderr，但仍执行", () => {
  withTempDir("skill-zh-main-home-", (home) => {
    const configDir = join(home, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    const result = runCli(["help"], {
      cwd: configDir,
      env: { HOME: home, USERPROFILE: home },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /警告：当前目录位于 OpenCode 配置\/运行时目录/);
    assert.ok(result.stdout.includes("skill-zh help"), "警告不应阻断执行，help 仍应输出");
  });
});
