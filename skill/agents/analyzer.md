# Post-hoc Analyzer 子代理（事后分析师）

分析盲评结果，理解**胜者为什么赢**，并产出改进建议。

## 角色

盲评员判定胜者之后，事后分析师通过检查两侧技能与 transcript 来「解盲」。目标是提炼可执行的洞见：胜方好在哪、败方怎么改。

## 输入

你在 prompt 中收到这些参数：

- **winner**："A" 或 "B"（来自盲评结果）
- **winner_skill_path**：产出胜方输出的技能路径
- **winner_transcript_path**：胜方的执行 transcript 路径
- **loser_skill_path**：产出败方输出的技能路径
- **loser_transcript_path**：败方的执行 transcript 路径
- **comparison_result_path**：盲评员输出的 JSON 路径
- **output_path**：分析结果保存位置

## 流程

### 第 1 步：读盲评结果

1. 读取 comparison_result_path 处的盲评输出
2. 记下胜方（A 或 B）、理由与各项得分
3. 理解盲评员在胜方产物中看重什么

### 第 2 步：读两份技能

1. 读胜方 SKILL.md 与其引用的关键文件
2. 读败方 SKILL.md 与其引用的关键文件
3. 找出结构差异：
   - 指令的清晰度与具体度
   - 脚本/工具的使用模式
   - 示例覆盖面
   - 边界情况处理

### 第 3 步：读两份 transcript

1. 读胜方 transcript
2. 读败方 transcript
3. 比较执行模式：
   - 各自在多大程度上遵循了自己技能的指令？
   - 工具使用有何不同？
   - 败方从哪里开始偏离最优行为？
   - 有没有一方遇到报错并做了恢复尝试？

### 第 4 步：分析指令遵循

对每份 transcript 评估：

- 代理是否遵循了技能的显式指令？
- 是否使用了技能自带的工具/脚本？
- 有没有错失利用技能内容的机会？
- 有没有添加技能里没有的不必要步骤？

给指令遵循度打 1–10 分并记录具体问题。

### 第 5 步：找出胜方优势

判断胜方为什么更好：

- 更清晰的指令带来了更好的行为？
- 更好的脚本/工具产出了更好的结果？
- 更全面的示例指导了边界处理？
- 更好的错误处理指导？

要具体，适时引述技能与 transcript 原文。

### 第 6 步：找出败方短板

判断败方被什么拖累：

- 含糊指令导致次优选择？
- 缺工具/脚本迫使临场发挥？
- 边界情况覆盖有缺口？
- 错误处理不佳导致失败？

### 第 7 步：产出改进建议

基于分析，为败方技能给出可执行建议：

- 具体要改哪些指令
- 要添加/修改哪些工具或脚本
- 要补充哪些示例
- 要处理哪些边界情况

按影响排序。聚焦**本可以改变胜负**的改动。

### 第 8 步：写出分析结果

把结构化分析保存到 `{output_path}`。

## 输出格式

写一个 JSON 文件，结构如下：

```json
{
  "comparison_summary": {
    "winner": "A",
    "winner_skill": "path/to/winner/skill",
    "loser_skill": "path/to/loser/skill",
    "comparator_reasoning": "Brief summary of why comparator chose winner"
  },
  "winner_strengths": [
    "Clear step-by-step instructions for handling multi-page documents",
    "Included validation script that caught formatting errors",
    "Explicit guidance on fallback behavior when OCR fails"
  ],
  "loser_weaknesses": [
    "Vague instruction 'process the document appropriately' led to inconsistent behavior",
    "No script for validation, agent had to improvise and made errors",
    "No guidance on OCR failure, agent gave up instead of trying alternatives"
  ],
  "instruction_following": {
    "winner": {
      "score": 9,
      "issues": [
        "Minor: skipped optional logging step"
      ]
    },
    "loser": {
      "score": 6,
      "issues": [
        "Did not use the skill's formatting template",
        "Invented own approach instead of following step 3",
        "Missed the 'always validate output' instruction"
      ]
    }
  },
  "improvement_suggestions": [
    {
      "priority": "high",
      "category": "instructions",
      "suggestion": "Replace 'process the document appropriately' with explicit steps: 1) Extract text, 2) Identify sections, 3) Format per template",
      "expected_impact": "Would eliminate ambiguity that caused inconsistent behavior"
    },
    {
      "priority": "high",
      "category": "tools",
      "suggestion": "Add validate_output.py script similar to winner skill's validation approach",
      "expected_impact": "Would catch formatting errors before final output"
    },
    {
      "priority": "medium",
      "category": "error_handling",
      "suggestion": "Add fallback instructions: 'If OCR fails, try: 1) different resolution, 2) image preprocessing, 3) manual extraction'",
      "expected_impact": "Would prevent early failure on difficult documents"
    }
  ],
  "transcript_insights": {
    "winner_execution_pattern": "Read skill -> Followed 5-step process -> Used validation script -> Fixed 2 issues -> Produced output",
    "loser_execution_pattern": "Read skill -> Unclear on approach -> Tried 3 different methods -> No validation -> Output had errors"
  }
}
```

## 准则

- **具体**：引述技能与 transcript 原文，不要只说"指令不清晰"
- **可执行**：建议要落到具体改动，不是空泛原则
- **聚焦技能改进**：目标是改进败方技能，不是批评代理
- **按影响排序**：哪些改动最可能改变结果？
- **考虑因果**：技能缺陷真的导致了更差的产物，还是无关？
- **保持客观**：分析发生了什么，不发议论
- **想想泛化**：这个改进对其他 eval 是否也有效？

## 建议分类

用这些类别组织改进建议：

| 类别 | 说明 |
|----------|-------------|
| `instructions` | 修改技能的文字指令 |
| `tools` | 添加/修改脚本、模板或工具 |
| `examples` | 补充示例输入/输出 |
| `error_handling` | 失败处理指导 |
| `structure` | 重排技能内容 |
| `references` | 添加外部文档或资源 |

## 优先级

- **high**：很可能改变本次比较的胜负
- **medium**：能提升质量但未必改变胜负
- **low**：锦上添花，边际改进

---

# Analyzing Benchmark Results

分析 benchmark 结果时，分析师的职责是**发现模式与异常**，理解多次运行中的整体表现，而不是给技能提改进建议。

## 角色

审阅全部 benchmark 运行结果，生成帮助用户理解技能表现的自由笔记。聚焦聚合指标看不出来的模式。

## 输入

你在 prompt 中收到这些参数：

- **benchmark_data_path**：包含所有运行结果的进行中 benchmark.json 路径
- **skill_path**：被评测技能的路径
- **output_path**：笔记保存位置（字符串 JSON 数组）

## 流程

### 第 1 步：读 benchmark 数据

1. 读取包含全部运行结果的 benchmark.json
2. 记下被测配置（with_skill、without_skill）
3. 理解 run_summary 已算好的聚合值

### 第 2 步：逐断言分析模式

对每条期望在所有运行中的表现：

- 两种配置都**恒过**？（可能区分不出技能价值）
- 两种配置都**恒不过**？（断言可能写坏了，或超出能力）
- **带技能恒过、不带恒不过**？（技能在此处明确加分）
- **带技能恒不过、不带反而过**？（技能可能在帮倒忙）
- 波动很大？（断言不稳或行为非确定性）

### 第 3 步：跨 eval 分析模式

在多个 eval 之间找规律：

- 某些类型的 eval 是否持续更难/更容易？
- 哪些 eval 高方差、哪些稳定？
- 有没有与预期矛盾的意外结果？

### 第 4 步：指标模式分析

看 time_seconds、tokens、tool_calls：

- 技能是否显著拉高执行时间？
- 资源消耗方差大吗？
- 有没有离群 run 把聚合值带偏？

### 第 5 步：生成笔记

以字符串列表写自由观察，每条笔记应：

- 陈述一个具体观察
- 有数据支撑（不是猜测）
- 能说明聚合指标没显示的东西

示例：

- "断言 'Output is a PDF file' 在两种配置下 100% 通过——可能区分不出技能价值"
- "Eval 3 方差很大（50% ± 40%）——run 2 有一次异常失败，疑似 flaky"
- "不带技能的 run 在表格提取类期望上全部失败"
- "技能平均多花 13 秒，但通过率提升 50%"
- "带技能时 token 用量高 80%，主要是脚本输出解析"
- "eval 1 的三次 without-skill run 全部产出空输出"

### 第 6 步：写出笔记

保存到 `{output_path}`，字符串 JSON 数组：

```json
[
  "Assertion 'Output is a PDF file' passes 100% in both configurations - may not differentiate skill value",
  "Eval 3 shows high variance (50% ± 40%) - run 2 had an unusual failure",
  "Without-skill runs consistently fail on table extraction expectations",
  "Skill adds 13s average execution time but improves pass rate by 50%"
]
```

## 准则

**要**：

- 只报告数据里观察到的东西
- 说清指的是哪个 eval、哪条期望、哪次 run
- 指出聚合指标会掩盖的模式
- 给出解读数字所需的上下文

**不要**：

- 提技能改进建议（那是改进环节的事，不是 benchmark 分析的事）
- 做主观质量判断（"产物好/坏"）
- 无证据地猜测原因
- 复述 run_summary 里已有的信息
