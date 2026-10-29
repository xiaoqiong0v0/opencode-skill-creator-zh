# installation.md 变更说明（2026-10-29）

## 「技能安装位置与共存」重写，安装状态移到技能目录外

**原来**：只写「装到 `~/.config/opencode/skills/opencode-skill-creator-zh/` 即可，与上游英文技能靠目录名共存」；升级小节写「保留你对 `SKILL.md` 的改动，备份为**同目录下**的 `SKILL.md.user-backup`，每次升级刷新」；验证与排障也按「技能目录内有版本标记」写。

**现在**：

1. 列出 opencode v1.18.25 的**全部**发现源（外部 `.claude` / `.agents`、配置目录 `{skill,skills}`、`skills.paths`、`skills.urls`）与对应环境变量，并说明「同名技能后扫描的覆盖先扫描的」，因此「装到这个路径 ≠ 一定生效」；
2. 给出**真正能禁用**旧技能的动作（改 `SKILL.md` 文件名、移出 `skills/`、权限 deny、环境变量关外部来源、改 `name` 用于防覆盖），并明确「重命名目录无效」；
3. 声明本插件只写自己的技能目录与 `~/.config/opencode/skills/.skill-zh-state/`，不碰 `.claude/`、`.agents/` 或其它技能目录；
4. 升级改为「`SKILL.md` 有本地改动默认不覆盖 + 提示 `--force`」，备份落状态目录、带时间戳；验证安装、卸载、排障同步改口径。

**为什么**：原文档照抄了上游安装器的两处设计缺陷——把元数据写进技能目录、升级时「备份后覆盖」——与本版新增的 SPEC `R6.1` 冲突；且把「装对路径就生效」当成结论，掩盖了 `.claude` / `.agents` / `skills.paths` 的同名覆盖。问题推导与源码行号见 [../design/技能安装与目录问题.md](../design/技能安装与目录问题.md)。

## 安装自检步骤同步 7 个子命令（同日第二批）

**原来**：「装好后在 OpenCode 里输入 `skill_zh help`：应返回 6 个子命令与示例。」

**现在**：「应返回 7 个子命令与示例（`install` 在 B5 前提示尚未实现）。」

**为什么**：用户拿这一行做安装自检，数量对不上会把正常安装误判成失败；同时提前说明 `install` 现在的行为，避免被当成故障。

## 前置条件：Node.js ≥ 18 改为 ≥ 22.3（同日第三批）

**原来**：「前置条件」写「Node.js ≥ 18（本包声明的最低版本；不代表所有运行时/系统组合都已实测）」。

**现在**：「Node.js **≥ 22.3**：本包声明的最低版本，原因是测试脚本用到 `node --test --experimental-test-module-mocks`（该开关 22.3 才引入）；不代表所有运行时/系统组合都已实测」。

**为什么**：安装页的前置条件是用户判断「我能不能装」的唯一依据，而 `package.json` 的 `engines.node` 已改为 `>= 22.3`；两处不一致会让 Node 20 用户误判可用。老 Node 用户需先升级 Node（仅影响开发与跑测试，插件运行本身不需要该 flag）。

## 安装器落地后的口径更新

**原来**：installation 多处标注「`src/lib/skill-install.ts` 未迁入 / B5 落地前为目标行为」，验证步骤还写着 `install` 会提示尚未实现。

**现在**：状态改为 B0–B5 完成；白名单、状态目录、冲突探测与用户改动保护都改为「已实现」，指向 ROADMAP B5 与 tools 的 install 一节；验证步骤改为可直接跑 `skill_zh install --dry-run`。

**为什么**：安装器已落地，继续保留「目标行为」措辞会让用户按文档去验证一个不存在的状态。

## 删掉 `XDG_CONFIG_HOME` 宣称，明确 `skills.urls` 不探测（终审修复）

**原来**：安装位置表写「`~/.config/opencode/skills/opencode-skill-creator-zh/`（设了 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/opencode/skills/...`）」；「装到 `~/.config/opencode/skills` 不等于一定生效」一节写「本包安装时会探测**上述位置**」，而上述发现源表含第 5 行 `skills.urls`；排障表也把 `skills.urls` 与探测动作并列。

**现在**：删掉 `XDG_CONFIG_HOME` 那半句，改为「可用 `skill_zh install --dir <目标根>` 改目标根」；探测范围明确写成 `.claude`、`.agents`、配置目录（`{skill,skills}`）与 `skills.paths`，并加一句「**`skills.urls` 本版不探测**：来自远程地址的同名技能不会被安装器点名，需自行核对配置」；排障行同批注明「安装器的冲突探测只看前四类，不含 `skills.urls`」。

**为什么**：实现里安装目标根是常量 + `--dir`，从不读 `XDG_CONFIG_HOME`；`skills.urls` 只在 opencode 侧参与发现，安装器没有 url 探测逻辑。原写法给出两条不存在的保障，用户会据此误判「设了环境变量就装对地方」「url 里的同名技能安装器会提示」。

## 状态行补 B6 完成（终审修复）

**原来**：开头状态行写「B0–B5 完成」。

**现在**：改为「B0–B6 完成（发布链路未做，`npm publish` 由用户手动执行）」。

**为什么**：B6 已把技能正文改为 `skill_zh` 口径，安装到本机的技能正文就是那次改写的产物；状态行漏掉 B6 会让排障者以为安装的正文还是旧版。
