# 安装与恢复

[项目概览](../README.md) · [子命令参考](tools.md) · [技能打包决策](design/技能打包决策.md)

> 当前状态：`src/` 与 `package.json` 尚未创建（B1 批次落地），本文为**目标行为**。安装命令、配置字段名与路径需在 B1 真机核对后再冻结。

## 前置条件

- OpenCode V1（本插件只提供 V1 入口 `export default { id, server }`）。
- Node.js ≥ 18（本包声明的最低版本；不代表所有运行时/系统组合都已实测）。
- `eval` / `optimize` 子命令会调用 `opencode run`：需要可用的 CLI、provider 与模型，且**会产生费用**。
- 从 npm 安装需要能访问 npm registry；离线场景走下面的本地插件目录方式。

## 方式一：npm 安装（推荐）

```sh
npm i -g @xiaoqiong0v0/opencode-skill-creator-zh
```

在 OpenCode 配置里登记插件包名（用户级 `~/.config/opencode/opencode.jsonc`，或项目内同名文件），保留已有条目：

```jsonc
{
  "plugin": ["@xiaoqiong0v0/opencode-skill-creator-zh"]
}
```

重开 OpenCode 后生效。配置字段名与包名写法以当前 OpenCode 版本为准，B1 批次在真机上核对后回填到本节。

## 方式二：本地插件目录

适合开发调试、离线环境或改源码后立刻验证：

1. 在仓库内装依赖并构建：

   ```sh
   npm install
   npm run build      # prebuild 清 dist/，tsc 直出 dist/
   ```

2. 让 OpenCode 从本地路径加载该插件：在配置的 plugin 列表里填仓库绝对路径（或按当前 OpenCode 版本的本地插件目录约定放置）。路径写法在本机核对后填入。
3. 重启 OpenCode，用 `skill_zh help` 验证。

本地方式不复制文件到 npm 缓存目录；改动源码后重跑 `npm run build` 并重启 OpenCode 即可。

## 技能安装位置与共存

插件 npm 包内自带唯一一份技能目录 `skill/`（与 `dist/` 平级）。插件加载后把技能装到**用户级**技能目录：

| 环境 | 目标路径 |
|---|---|
| 默认 | `~/.config/opencode/skills/opencode-skill-creator-zh/` |
| 设了 `XDG_CONFIG_HOME` | `$XDG_CONFIG_HOME/opencode/skills/opencode-skill-creator-zh/` |

- 目录名 `opencode-skill-creator-zh` 与插件 id、技能 frontmatter `name` 三者一致（OpenCode 按目录名发现技能）。
- 上游英文版技能目录名是 `opencode-skill-creator`，**两者并存**：本插件只在自己的目录内写/删，不触碰其它技能目录。
- 想在单个项目里用技能，可把 `skill/` 拷到项目的 `.opencode/skills/opencode-skill-creator-zh/`；同名技能同时存在于用户级与项目级时的发现顺序（谁生效、是否去重）依赖 opencode 版本，需真机核对后再定口径。

决策背景见 [design/技能打包决策.md](design/技能打包决策.md)。

## 验证安装

1. `~/.config/opencode/skills/opencode-skill-creator-zh/` 下应有 `SKILL.md`、`agents/`、`references/`、`templates/` 四部分。
2. 在 OpenCode 里输入 `skill_zh help`：应返回 6 个子命令与示例。
3. 工具列表只应新增 **1 个**工具（`skill_zh`）；如果还能看到 `skill_validate` 之类的名字，说明加载的是上游英文版插件，不是本包。

配置写入成功（命令无报错）**不等于**插件加载成功；工具缺失时优先看 OpenCode 的插件加载错误，而不是反复改配置。

## 升级

```sh
npm i -g @xiaoqiong0v0/opencode-skill-creator-zh@latest
```

- 插件代码随包升级；技能目录按版本标记决定是否重新写入（目标策略沿用上游：版本变化才更新，同版本不重复覆盖）。
- 升级时会尝试保留你对 `SKILL.md` 的改动，备份为同目录下的 `SKILL.md.user-backup`。该备份**每次升级刷新**，不是历史归档；自己的改动请另外留一份。
- 辅助文件（`agents/`、`references/`、`templates/`）随包更新会被覆盖；要长期保留改动，请改源仓而不是改安装副本。
- 升级只重构本包技能目录；上游英文技能目录不受影响。

## 卸载与回滚

卸载三步（顺序执行）：

1. 从 OpenCode 配置的 plugin 列表移除 `@xiaoqiong0v0/opencode-skill-creator-zh`，重启 OpenCode，确认工具列表里 `skill_zh` 消失。
2. 删除技能目录 `~/.config/opencode/skills/opencode-skill-creator-zh/`（**只删这一个目录**，先确认里面没有你手写且未备份的改动）。
3. `npm uninstall -g @xiaoqiong0v0/opencode-skill-creator-zh`。

回滚到旧版本：

```sh
npm i -g @xiaoqiong0v0/opencode-skill-creator-zh@<旧版本号>
```

- 回滚只影响插件代码；技能目录若已被新版覆盖，需从你自己的备份恢复。
- 想彻底恢复成上游行为：装上上游 `opencode-skill-creator`（技能目录 `opencode-skill-creator/` 保留原状），两者互不干扰。

## 排障

| 现象 | 处理 |
|---|---|
| 工具列表没有 `skill_zh` | 确认配置里写的是本包名而非上游包名；重启 OpenCode；看插件加载错误 |
| 工具列表里有多个 `skill_*` | 同时装了上游英文版；二者可共存，但不是同一套工具，按需只留一个 |
| `skill_zh help` 有输出但子命令报「尚未实现」 | 当前批次只接线了部分子命令，见 [ROADMAP.md](ROADMAP.md) |
| `eval` / `optimize` 报无法调用 `opencode` | 检查 `opencode run` 是否可用、模型是否配置；再按错误里的「改法」重试 |
| 技能目录在，但技能不被发现 | 检查目录名与 frontmatter `name` 是否一致（都应是 `opencode-skill-creator-zh`），以及是否放在了 OpenCode 实际的技能发现路径下 |
| 升级后技能正文变回旧内容 | 安装了旧版本包；核对版本号与技能目录内的版本标记 |
