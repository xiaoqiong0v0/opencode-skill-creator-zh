# 变更说明：安装文档新增「独立终端入口 `skill-zh`（bin）」

日期：2026-10-30

**原来**：installation.md 只写插件的两种安装方式（npm 全局 / 本地目录），使用入口只有 OpenCode 内的 `skill_zh` 工具；长评测只能靠工具调用，会占住会话。

**现在**：在「方式一：npm 安装」之后新增一节，说明：

1. 包内提供 `bin.skill-zh`，全局安装后任意 shell 可用，未全局安装可用 `npx @xiaoqiong0v0/opencode-skill-creator-zh`；
2. 长评测示例（先 `cd` 到项目、再 `skill-zh eval … --runs 3 --workers 4`），不依赖 OpenCode 会话；
3. 口径：子命令与三段式文案和工具一致、bin 不注册工具；目录基准是 shell cwd、不向上查找；cwd 在 `~/.config/opencode` / `~/.opencode` 时警告但继续；成功 stdout / 退出码 0、失败 stderr / 退出码 1；`--version` 与 `package.json` 同源。

**为什么**：安装文档必须覆盖「装完怎么用」，而 bin 是本次新增的官方使用入口；同时 cwd 口径与插件（`ToolContext.directory`）不同，不写清会让用户在 home 或配置目录里跑出错误基准。

**2026-10-30 复核收口**：bin 输出把命令名归一为 `skill-zh`，三段式结构与工具一致但命令可直接照抄；用例数最终 287。
