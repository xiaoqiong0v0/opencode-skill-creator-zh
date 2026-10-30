# 变更说明：新增 R8 独立 shell 入口（bin `skill-zh`）、J2 的独立 CLI 口径与 cwd 门禁白名单

日期：2026-10-30

**原来**：SPEC 只有插件入口（R1 唯一工具注册点）；J2 规定「插件与分发层不用 `process.cwd()`、不向上查找」，独立 CLI 场景被描述为「允许兜底向上查找，但排除 `~/.opencode` / `~/.config/opencode`、校验项目形态」；源码门禁要求 `src/cli/**` 与 `src/tool.ts` 内 `process.cwd()` 真实调用数为 0。

**现在**：

1. 新增 **R8 独立 shell 入口（bin）**：`package.json` 提供 `bin.skill-zh` → `./dist/cli/main.js`；入口只做 `argv` → `parseArgs` → `runCommand`，**不注册工具**，因此 R1 的「唯一注册点」不变；成功 stdout / 退出码 0，失败 stderr / 退出码 1；`--version` 读 `package.json`；`parseArgs` 接受 argv 数组且按 token 直接用。
2. **J2 的独立 CLI 分支**改为：`process.cwd()` 即 `directory`，**不向上查找**；cwd 位于 `~/.opencode` / `~/.config/opencode`（含子树）时警告到 stderr 但继续执行。
3. 源码门禁从「`src/cli/**` 全部为 0」改为「白名单仅 `src/cli/main.ts` 且恰好 1 处，其余为 0」——`main.ts` 是 bin 入口，必须读 cwd；插件、`dispatch` 与各子命令仍禁止。
4. §4 新增 R8 验收行，并同步 R6.2-J2 行。

**为什么**：真机反馈指出 `eval --runs 3 --workers 4` 只能靠工具调用触发、会把会话卡住；内核已预留 `runCommand` 返回的 `ok`（注释写明供 CLI 决定退出码），但仓库没有 shell 入口。用户确认采用「cwd 即项目目录、不向上查找」的口径（避免重蹈上游 `findProjectRoot()` 把 `~/.opencode` 当项目根的坑），因此 J2 的独立 CLI 分支与门禁必须同批改口径；否则 bin 无法读 cwd 或会与门禁冲突。

**2026-10-30 复核收口**：R8 增加入口名归一——bin 写结果前把 `skill_zh`（按词边界）替换成 `skill-zh`，共享 `formatError` / `HELP_TEXT` 不变、插件路径输出不变；空输出不写孤立换行；stdout/stderr 的 EPIPE（`| head`）静默吞掉。同批复核确认 `findProjectRoot()` 已无生产调用方，删除函数及其 6 条专属用例，`grep -n findProjectRoot src/` 命中 0；最终用例数 287。
