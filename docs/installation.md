# 安装与恢复

[项目概览](../README.md) · [子命令参考](tools.md) · [技能打包决策](design/技能打包决策.md) · [技能安装与目录问题](design/技能安装与目录问题.md)

> 当前状态：B0–B6 完成（CI 已补；npm 发布未做，`npm publish` 由用户手动执行），安装器（`src/lib/skill-install.ts`）与 `skill_zh install` 已落地；技能发现规则取自 opencode v1.18.25（跨版本需复核）。

## 前置条件

- OpenCode V1（本插件只提供 V1 入口 `export default { id, server }`）。
- Node.js **≥ 22.3**：本包声明的最低版本，原因是测试脚本用到 `node --test --experimental-test-module-mocks`（该开关 22.3 才引入）；不代表所有运行时/系统组合都已实测。
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

本插件只写**两处**，都是自己的：

| 用途 | 路径 |
|---|---|
| 技能本体 | `~/.config/opencode/skills/opencode-skill-creator-zh/`（可用 `skill_zh install --dir <目标根>` 改目标根） |
| 安装状态 | `~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json` |

- 技能目录内**只有技能本体**：`SKILL.md`、`agents/`、`references/`、`templates/`（安装走白名单，源目录里别的东西不会搬进来）。
- 版本标记、属主文件清单、升级备份都在状态目录里，**不在技能目录内**——所以「技能目录内容」可以直接拿去比对源 `skill/`。
- 目录名 `opencode-skill-creator-zh` 与插件 id、技能 frontmatter `name` 三者一致。
- 上游英文版技能目录名是 `opencode-skill-creator`，**两者并存**：本插件只在自己的技能目录与状态目录内写/删。

> 以上白名单、状态目录与探测行为由 `src/lib/skill-install.ts` 实现；细节见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)。冲突处置的入口是 `skill_zh install`（`--dry-run` 预览 / `--force` 覆盖 / `--dir` 指定目标根，见 [tools.md](tools.md)）。

## 插件启动时的自动安装

插件加载时会**自动安装/升级随包技能**（开箱即用，与上游一致）：无同名冲突、目标不存在或版本不同、且本地 `SKILL.md` 未被改动时才写盘，其余情况只记日志。

- **默认行为**：写 `~/.config/opencode/skills/opencode-skill-creator-zh/` 与 `~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json`；不碰其它技能目录、`.claude/`、`.agents/` 或全局配置。
- **每次启动必记一条日志**：装成功为「已自动安装技能到 …」，未写盘为「启动安装跳过：原因」（同名冲突 / 本地有改动 / 已是最新 / 已关闭）。
- **关闭方式**：设 `SKILL_ZH_NO_STARTUP_INSTALL=1` 后完全跳过启动安装（不探测、不写盘，只记跳过日志）；之后需要时用 `skill_zh install` 显式安装。
- 升级/回滚语义与手动安装一致（见下文「升级」）；状态文件记录版本与属主哈希，本地改动默认不被覆盖。

### 装到 `~/.config/opencode/skills` 不等于一定生效

OpenCode **v1.18.25** 的技能发现源不止一处（源码 `packages/opencode/src/skill/index.ts:185-227`，**跨版本仍建议复核**），按扫描顺序：

| 序 | 来源 | 开关 |
|---|---|---|
| 1 | 外部 `.claude/skills/**/SKILL.md`（含用户级 `~/.claude/skills`，`:187` 显式纳入；以及项目逐层同路径） | `OPENCODE_DISABLE_EXTERNAL_SKILLS` 或 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE` |
| 2 | 外部 `.agents/skills/**/SKILL.md`（含用户级 `~/.agents/skills` 与项目逐层同路径） | 只受 `OPENCODE_DISABLE_EXTERNAL_SKILLS` 控制 |
| 3 | `~/.config/opencode/{skill,skills}/**/SKILL.md` | — |
| 4 | 配置项 `skills.paths` 列出的目录 | — |
| 5 | 配置项 `skills.urls` 列出的远程地址 | — |

同名技能**后扫描的覆盖先扫描的**。因此「装成功、命令无报错」但技能不生效，通常是下面几种情况：

- `.claude/skills` 或 `.agents/skills` 里有同名技能被先扫到、又被后面的来源顶掉，或反过来顶掉了本包这份；
- 配置里 `skills.paths` / `skills.urls` 指到了另一份同名技能；
- 本包目录名与 frontmatter `name` 不一致（发现按目录，命名不一致会表现为「技能在但不同名」）。

本包安装时会探测 `.claude`、`.agents`、配置目录（`{skill,skills}`）与 `skills.paths`，在**发现同名时提示**（点名哪几个路径有同名技能、按扫描顺序当前哪个生效），**只提示、不改写**——不会删改你 `.claude/`、`.agents/` 或其它技能目录里的东西。**`skills.urls` 本版不探测**：来自远程地址的同名技能不会被安装器点名，需自行核对配置。

### 要禁用旧技能，只有这几种做法

技能发现的条件是路径里有 `SKILL.md`（`skills/**/SKILL.md`），**跟目录叫什么名字无关**，所以：

| 做法 | 为什么有效 |
|---|---|
| 把 `SKILL.md` 改名为 `SKILL.md.disabled` | 文件名不再匹配发现规则；想恢复改回来即可 |
| 把整个目录移出任何 `skills/` 路径（如挪到 `~/skills-archive/`） | 不在扫描范围内 |
| 用 OpenCode 的权限 deny 规则拦掉该技能 | 由平台在执行侧拦住 |
| 设 `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`（或 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` 只关 `.claude`） | 整类外部来源不再扫描 |
| 改 frontmatter `name` | 让「同名覆盖」不成立（用于避免被别人顶掉），**不是禁用**：技能仍会被发现和触发 |

**重命名目录无效**：`skills/foo.disabled/SKILL.md` 仍然命中 `skills/**/SKILL.md`，技能照旧被发现、照旧触发。

### 项目内使用

想把技能限定在单个项目里，把 `skill/` 拷到项目的 `.opencode/skills/opencode-skill-creator-zh/`。项目级与用户级同时存在同名技能时的优先级取决于 OpenCode 版本（按 `packages/opencode/src/skill/index.ts:205-208` 的实现确认，跨版本需复核），**建议只保留一份**，避免「改了这份、生效的是那份」。

决策背景见 [design/技能打包决策.md](design/技能打包决策.md)，问题清单见 [design/技能安装与目录问题.md](design/技能安装与目录问题.md)。

## 验证安装

1. `~/.config/opencode/skills/opencode-skill-creator-zh/` 下应只有 `SKILL.md`、`agents/`、`references/`、`templates/` 四项，且**不含**点开头的元数据文件、不含 `*.user-backup`。
2. `~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json` 存在，记录了安装版本。
3. 在 OpenCode 里输入 `skill_zh help`：应返回 7 个子命令与示例；`skill_zh install --dry-run` 可预览安装。
4. 工具列表只应新增 **1 个**工具（`skill_zh`）；如果还能看到 `skill_validate` 之类的名字，说明加载的是上游英文版插件，不是本包。
5. 技能确实被 OpenCode 发现：若没触发，按上文「装到 `~/.config/opencode/skills` 不等于一定生效」逐项排查同名覆盖。

配置写入成功（命令无报错）**不等于**插件加载成功；工具缺失时优先看 OpenCode 的插件加载错误，而不是反复改配置。

## 升级

```sh
npm i -g @xiaoqiong0v0/opencode-skill-creator-zh@latest
```

- 插件代码随包升级；技能目录按状态文件里记录的版本决定是否重新写入（版本变了才装，同版本不重复覆盖）。
- **你对 `SKILL.md` 的改动受保护**：状态文件里记着安装时的文件哈希，磁盘上的 `SKILL.md` 与它不一致（= 你改过）时**默认不覆盖**，升级只提示，处置交给你显式执行 `skill_zh install --force`（此时你的版本先备份到状态目录），或自己先另存一份再重试。
- 备份落在 `~/.config/opencode/skills/.skill-zh-state/`（文件名带时间戳），**不写进技能目录**，也不会被下次升级刷新掉。
- 辅助文件（`agents/`、`references/`、`templates/`）随包更新会被覆盖；要长期保留改动，请改源仓而不是改安装副本。
- 升级只写本包的技能目录与状态目录；不碰上游英文技能目录，也不碰 `.claude/`、`.agents/` 等外部技能目录。
- 安装与升级逻辑见 [ROADMAP.md](ROADMAP.md) 的 B5（已完成）与 [tools.md 的 install 一节](tools.md#skill_zh-install)。

## 卸载与回滚

卸载三步（顺序执行）：

1. 从 OpenCode 配置的 plugin 列表移除 `@xiaoqiong0v0/opencode-skill-creator-zh`，重启 OpenCode，确认工具列表里 `skill_zh` 消失。
2. 删除技能目录 `~/.config/opencode/skills/opencode-skill-creator-zh/` 与状态文件 `~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json`（**只删这两个**，先确认里面没有你手写且未备份的改动；状态目录里的备份按需自取）。
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
| `skill_zh help` 有输出但子命令报「尚未实现」 | 装的是旧版本插件（B5 前）；升级到最新版后重启 OpenCode |
| `eval` / `optimize` 报无法调用 `opencode` | 检查 `opencode run` 是否可用、模型是否配置；再按错误里的「改法」重试 |
| 技能目录在，但技能不被发现 | ① 目录名与 frontmatter `name` 是否一致（都应是 `opencode-skill-creator-zh`）；② 是否有同名技能在 `.claude/skills`、`.agents/skills`、`skills.paths`、`skills.urls` 里覆盖了它（见上文发现源表；安装器的冲突探测只看前四类，**不含 `skills.urls`**） |
| 改过的 `SKILL.md` 升级后没变 | 正常：本地有改动时默认不覆盖。要换成包内版本，跑 `skill_zh install --force`（你的版本会先进状态目录备份），或先自行另存 |
| 升级后技能正文变回旧内容 | 安装了旧版本包；核对 `~/.config/opencode/skills/.skill-zh-state/opencode-skill-creator-zh.json` 里记录的版本 |
| 把技能目录改名成 `xxx.disabled` 后技能还在触发 | 预期行为：发现条件是 `skills/**/SKILL.md`，与目录名无关。要禁用请改 `SKILL.md` 文件名或把目录移出 `skills/` |
