# CONVENTIONS —— 项目规范

本文件约束本仓的代码与文档写法。与 [SPEC.md](SPEC.md) 冲突时以 SPEC 的需求口径为准；本文件只管「怎么写」。

## 1. 目录约定

```
opencode-skill-creator-zh/
├── src/                源码（唯一编译输入）
│   ├── index.ts        插件入口：export default { id, server }，唯一 1 处工具注册
│   ├── cli/            CLI 层：参数解析、子命令分发、help、错误三段式
│   │   └── main.ts     独立 shell 入口（npm bin `skill-zh`；不注册工具）
│   └── lib/            执行逻辑（迁自上游，只接线与中文化，不重构算法）
├── test/               测试（.js，对编译产物跑）
├── docs/               过程与方案文档（本目录）
├── scripts/            仓库脚本（清 dist、发布辅助等）
├── templates/          子命令产出的模板（技能骨架等）
├── skill/              随包分发的中文技能（与 dist/ 平级，包内唯一一份）
├── dist/               构建产物（git 忽略，不入库）
└── .tmp/               本地临时区（git 忽略；旧仓基线在 .tmp/old/，只读）
```

- 一次性产物放 `.tmp/scratch/`，用完即删；不要往仓库根丢临时文件。
- 新增顶层目录须在本节目录树与两处索引同批登记：仓库根 [../README.md](../README.md) 的「相关文档」表、[docs/README.md](README.md) 的「文档结构」表；未登记的不进仓。

### 入口点：插件为主、bin 为等价外壳

| 入口 | 落点 | 职责 | 注册工具 |
|---|---|---|---|
| 插件（主） | `src/index.ts` → `src/tool.ts` | OpenCode 加载，暴露唯一工具 `skill_zh` | 是，全仓 1 处 |
| shell bin（外壳） | `src/cli/main.ts` → `dist/cli/main.js` | 独立终端跑同一套子命令（长评测不占会话） | **否** |

- 两个入口共用 `parseArgs` → `runCommand`，**不写第二套参数语义**；bin 只决定 stdout/stderr 与退出码，并在写结果前把共享文案里的 `skill_zh`（按词边界）归一成 `skill-zh`——共享构造器不感知入口，插件路径输出保持不变。
- bin 的目录语义是 `process.cwd()` 即 `directory`（不向上查找）；这是 `src/cli/**` 里唯一允许读 cwd 的位置，插件与分发层仍为 0（源码门禁见 `test/lib-run-eval-j.test.js`）。
- `#!` 行只出现在 `src/cli/main.ts` 首行；`tsc` 会原样保留到产物。

## 2. TypeScript → JavaScript

| 项 | 定稿 | 理由 |
|---|---|---|
| 编译器 | `tsc` 直出 `dist/`（不用打包器） | 产物结构可预测，`node --test` 可直接跑，不需要额外运行时 |
| `module` / `moduleResolution` | `NodeNext` / `NodeNext` | 与 `"type": "module"` 对齐；相对导入必须带 `.js` 扩展名（编译后仍是 ESM） |
| `strict` | 打开 | 全量类型安全 |
| `declaration` | `false` | 不对外提供类型声明，减少包体积 |
| `outDir` | `dist` | 与 `files` 字段、`main` 指针对齐 |
| `prebuild` | 先清 `dist/` | 避免删掉的源文件在产物里残留 |
| `engines.node` | `>= 22.3` | `test` 用 `node --test --experimental-test-module-mocks`（该开关 22.3 才引入）；改测试脚本里的 Node flag 必须同批核对这个下限（见 SPEC R7-Node） |

- `dist/` **不入库**：`.gitignore` 已忽略；提交前确认 `git status` 不含 `dist/`。
- 源码里不写 `.ts` 扩展名导入，统一写 `.js`（NodeNext 要求）。

## 3. 注释

| 对象 | 要求 |
|---|---|
| 公共函数 / 公共常量 | 必须有注释：**功能 + 参数 + 返回值**（参数用 `@param`，返回值用 `@returns`） |
| 复杂逻辑（分发、参数解析、失败归类、上游行为适配） | **必须**写注释，说明「为什么这样做」，不只描述代码在做什么 |
| 其余（简单赋值、显而易见的循环） | 简单一句即可，不写无信息量的注释 |

- 注释语言一律**中文**；标识符仍用英文。
- 不留「TODO 待补」「临时方案」类注释进主干；必须留的写清条件与批次（如 `TODO(B4):`）。
- 过期注释与死代码同批删除，不留注释掉的旧实现。

## 4. 类型

- **函数全量标注**：函数参数与返回值必须有类型，不靠推断兜底；模块级常量与导出对象可依赖推断，推断不明确（字面量过宽、需要收窄联合类型）时显式标注。
- 对外共享的接口 / 联合类型放使用方同一文件顶部或 `src/cli/types.ts`，避免循环依赖。
- 不用 `any`；确需放宽用 `unknown` + 收窄，或在边界处集中断言并注释原因。
- 子命令名等有限集合用 `as const` 元组 + 派生联合类型，保证 `help` 顺序与分发一致。

## 5. 导入分组

顶部集中，按三段分组，组间空一行，组内按模块名排序：

```ts
// 1. 第三方
import { z } from "zod"

// 2. 项目内部（非相对路径）
import { something } from "@xiaoqiong0v0/some-pkg"

// 3. 本地相对路径
import { dispatch } from "./cli/dispatch.js"
```

- 不用动态 `import()` 规避循环依赖；真有循环就把共享类型提出来。
- 不做「按需懒加载」式内联 `require`（ESM 项目没有）。

## 6. 命名

| 对象 | 约定 |
|---|---|
| 文件 | kebab-case（`run-eval.ts`、`parse-args.ts`） |
| 函数 / 变量 | lowerCamelCase；布尔量用 `is/has/can` 前缀 |
| 类型 / 接口 | PascalCase |
| 常量 | UPPER_SNAKE_CASE（`TOOL_NAME`、`HELP_TEXT`、`TOOL_DESCRIPTION`） |
| 子命令 | 全小写单词，固定 7 个：`help` `new` `validate` `eval` `optimize` `package` `install` |
| 入口名 | 工具用下划线 `skill_zh`；shell bin 用连字符 `skill-zh`（npm `bin` 惯例），两者不可混写 |

- 不硬编码文案与路径：工具 description、`help`、错误模板、安装目标目录都提为常量，只留一处实现。
- 用户可见文案全中文；JSON 输出的**字段名保持英文**（下游脚本兼容），只汉化人读的 `message` 类字段。

## 7. 测试

- 位置 `test/`，文件名 `<主题>.test.js`，用 Node 内置 `node --test --experimental-test-module-mocks "test/*.test.js"`（`mock.module` 需要该开关，最低 Node 22.3；**显式 glob 不可省**——Node 默认把 `test/**` 下所有 `.js` 都当用例，`test/helpers/**` 会虚增用例数），不引第三方框架。
- **`mock.module` 的导出键按 Node 主版本选**：22 认 `namedExports`、24 认 `exports`（且弃用 `namedExports`）；传错键在 22 上被**静默忽略**（mock 变空模块 →「does not provide an export named …」）。统一用 `test/helpers/mock-module.js` 的 `MOCK_EXPORTS_KEY`。
- 测试跑**编译产物**（`dist/`）或对同构 JS 直接 `import`；不在测试里手写一份实现来「自证」。
- 必测项（对应 SPEC）：注册点计数、`HELP_TEXT` 覆盖度、description 长度、4 类失败（未知子命令 / 缺参 / 路径不存在 / 非法参数值）的三段式、子命令主路径。
- **不写假测试**：不改断言迁就实现，不跳过失败用例；修不了就留红并报出。
- 单测独立、不依赖执行顺序；涉及文件系统的一律用临时目录并在结尾清理。

## 8. 文档规则

- **默认就地改原文**：不另建副本、不保留被替换的旧文本。
- 需要留痕的变更写 `docs/changes/<原文档名>.<YYYYMMDD>.md`，内容三段：**原来是什么 → 现在是什么 → 为什么改**；同日多次变更合并成一份。触发条件（推翻既有结论 / 改动被依赖的约定 / 改全局规则或技能正文 / 用户要求）见 [docs/README.md 的「变更说明」一节](README.md#变更说明)。
- 他人给的原始材料放 `raw/` 只读；要加工就另写自有文档引用它。
- 文档一律中文；代码标识符、命令、字段名保持原文。
- 不写会过期的具体值：模型名、配置现值、目录绝对路径。要写就写**概念 / 档位**，或指向真源（`package.json`、`tsconfig.json`）。
- 不写本机绝对路径，路径统一用 `~/.config/opencode/...` 这类跨机器一致写法。
- 新增文档必须在 [docs/README.md 的「文档结构」表](README.md#文档结构) 登记，同批完成。
