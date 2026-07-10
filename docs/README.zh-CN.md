[English](../README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md) · **简体中文**

# ultracodex

> **Claude 负责编排，Codex 负责交叉核验。**
> 把 Codex headless（无界面）节点（`codex exec`）融入 Claude Code 自带的 Workflow
> （*ultracode*）编排——这样，一个真正不同的模型家族就能在同模型一致性最不可信的环节去
> 验证、评判，并提出质疑。

`ultracodex` 是一个开源的 Claude Code 插件——只包含一个 skill，即
`codex-workflow`——它教 Claude 如何把
[Codex](https://github.com/openai/codex) headless 节点混入一个 **Workflow**：
也就是 Claude Code 的 `agent()` / `pipeline()` / `parallel()` 编排工具，又称
*ultracode*。编排逻辑始终保留在 Claude 的 JavaScript 里；变化的只是在选定节点上
*由谁来干活*。这就是 **“Pattern A”**——它是一种叠加（additive）方式，而非模型切换器。
两个家族在同一个 Workflow 中一起运行。

```
Workflow (Claude JS orchestration)
 ├─ find / generate / synthesize .. Claude agent()  ← broad, fast, cache-warm
 └─ verify / judge / 2nd-opinion ... codex node     ← GPT, independent failure modes
```

> **已支持 GPT-5.6。** 由于设计上与具体模型无关，GPT-5.6 一代
> （**Sol / Terra / Luna**，Codex CLI ≥ 0.144.0）发布当天即可在 ultracodex 上
> 无改动运行。文档新增了按节点选择**层级与 effort**的指引——宽扇出的 verify 用
> 低价层级，裁决起决定性作用的节点用旗舰（最高 `max`，Sol/Terra 上还有
> `ultra`）——选择权留给负责编排的模型。

> **需要 ultracode 模式。** 由于该 skill 会*编写并运行* Workflow，所以
> **Workflow** 编排工具必须可用——在 Claude Code 中，这意味着
> **ultracode 模式**（用 `/effort` → ultracode 启用它；它会开启动态
> workflow 编排）。没有它，插件仍能加载、skill 也能被找到，
> 但就没有可驱动的 Workflow 工具了。参见[前置条件](#prerequisites)。

## 它为何存在——设计理念

来自*同一个*模型的更多验证者往往会共享该模型的盲区：它们会重新确认同样的**相关性误报（correlated false positives）**。不同的模型家族在不同的输入上失败，因此它能驳倒同模型审查者会盲目放行的结论。这正是核心思路：

- **多样性，而非替换。** 收益来自*独立模型之间的分歧*，所以目标是让两个家族都留在
  同一次运行里——绝不是把 Claude 换掉。“加一个第二意见”是对的；“改用 GPT”则错失了
  要点。
- **独立的失败模式胜过更多同质的检查。** 把一个 verify/judge 节点路由给 Codex 可以
  降低*相关性*误差——这正是再加 N 个 Claude 验证者也抓不到的那类错误，因为它们都在
  同样的地方失败。
- **编排始终留在 Claude。** Claude 掌握上下文、schema、扇出（fan-out）与综合
  （synthesis）。一个 codex 节点不过是一个普通的 `agent()`，它的 subagent 负责转发一次
  `codex exec` 运行。没有任何 Workflow 原语发生改变——这是一种低侵入面
  （low-surface-area）的方式来获取 cross-model（跨模型）价值。
- **第二个模型不是事实来源（source of truth）。** 它只是*另一种失败模式分布*，最好与
  测试、证据、严格的 schema 以及最终的 Claude 综合结合使用。“独立”也是相对的：共享的
  prompt、共享的证据，或一个宽松的 schema，仍可能让错误产生相关性——所以请有针对性地
  使用 Codex，用在有可核验产物（verifiable artifact）可供检查的地方。

## 你能获得什么

- **抓出能通过同模型审查的误报**——一个不同的模型家族*有可能*在你据某个发现或论断采取
  行动之前，驳倒*某些*相关性 Claude 误差（这是对相关性误差的削减，而非保证）。
- **对高风险结论给出更可信的裁决**——在你汇报或发布之前，用一个并非产出该结论的模型去
  交叉核验一个关键结果。
- **真正多样的评判团**——用一个评审团（jury）为候选项打分，让没有任何模型只评判自己的
  作品，从而削减 LLM-as-judge 场景中的自我偏好偏差。
- **生成阶段真正的解法多样性**——在一个 N 路（N-way）面板里，一次 Codex 尝试是另一个
  家族给出的答案，而不是换种说法的 Claude 答案。
- **无需新机制的大上下文、多文件验证**——让 Codex 直接指向一个目录树
  （`cwd` / `-C`；read-only 只阻止写，不阻止读），这样它会自己去读大块 diff 和文件，而
  不是靠你把它们粘进 prompt。
- **按节点的层级与 effort 路由**——每个 codex 节点的 `model` / `effort` 都是开放
  选项：宽扇出 verify 用 `gpt-5.6-luna` + `low`；当单个裁决至关重要时用
  `gpt-5.6-sol` + `xhigh`/`max`（或 `ultra`）。没有任何硬编码；由负责编排的模型
  逐节点选择。
- **开箱即用、可直接复制粘贴**——四个完整的 Workflow 模板（cross-model 审查、混合评判团、
  单结论交叉核验、loop-until-dry）外加标准的 `codexNode` helper。你从可运行的脚本起步，
  而不是从一张白纸。
- **改动面最小**——保留每一个 Workflow 原语原样不变；只有选定的节点会换手。

## 投入产出比最高的用法：对抗式验证

Claude 广泛地寻找问题；Codex 则尝试**驳倒**每一个发现（不确定时默认判为“refuted”）。
存活下来的就是另一个模型家族也无法推翻的发现——这是一条流水线，而不是一道关卡：

```js
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.findPrompt, { phase: 'Find', schema: FINDINGS }),         // Claude finds
  review => parallel((review?.findings ?? []).map(f => () =>
    codexNode(`Adversarially verify, defaulting to refuted=true if uncertain:\n${f.title}\n${f.detail}`,
      { schema: VERDICT, phase: 'Verify', label: `codex:${f.id}` })       // Codex refutes
      .then(v => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean)
  .filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false)
```

混合**评判团**与单结论**第二意见**是接下来的两个层级——完整脚本见
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md)。

## 何时使用——以及何时不用

Cross-model 是信号，但不是免费的信号。当一个*第二、独立的模型*能实质性地为结果降低风险时
——比如验证发现、评判候选项、面板中的一次独立尝试、对高风险结论做合理性核查——就该动用一个
codex 节点。

**在以下情况跳过混合：**

- 这是大批量吞吐工作（Claude subagent 更便宜、更快、cache-warm）；
- 这是一个**相关性检查（correlated check）**——Codex 只会从同样的证据中重新推导一遍，
  是回声而非第二意见；
- 这是一个**盲检（blind check）**——该节点无法把 Codex 独立验证所需的东西交给它；
- 没有可核验/可评判的产物（开放式发散）——多样性带来的是噪声，而非信号。

## 前置条件

- **Ultracode 模式——即 Workflow 工具。** 该 skill 会*编写并运行* Workflow，
  所以 **Workflow** 工具（`agent()`/`pipeline()`/`parallel()`）必须可用。
  在 Claude Code 中这意味着 **ultracode 模式**：用 `/effort` → ultracode 启用它
  （xhigh + 动态 workflow 编排）。该 skill 只提供*编写* Workflow 的诀窍；它
  **不会**自己添加该工具，所以没有 ultracode 模式时，它就没有可驱动的 Workflow 工具。
- **已安装并完成认证的 Codex CLI。** 先验证，再登录（交互式——无法以 headless 方式完成）：
  ```bash
  command -v codex && codex --version
  codex login
  ```
- **一个 POSIX shell**（`bash`/`zsh`），供 relay（转发）节点使用。

> 该 skill **不会**硬编码任何 Codex 版本或默认模型——各环境不尽相同。
> 它内置了一个轻量的 **preflight（预检）**（确认 CLI 存在、认证有效、结构化输出路径可用），
> 在信任任何节点之前先跑一次。

## 安装

`ultracodex` 本身就是一个单插件 marketplace（插件市场）。添加它、安装插件、重新加载：

```text
/plugin marketplace add KingGyuSuh/ultracodex
/plugin install ultracodex@ultracodex
/reload-plugins
```

非交互式（CLI）的等价方式：

```bash
claude plugin marketplace add KingGyuSuh/ultracodex
claude plugin install ultracodex@ultracodex
# then restart Claude Code, or run /reload-plugins in an existing session
```

> 安装时的 `@ultracodex` 后缀指的是 marketplace 的**名称**（顶层 `name` 位于 `.claude-plugin/marketplace.json` 中），与仓库名无关——只是这里恰好相同。

### 不安装直接试用

```bash
claude --plugin-dir ./plugins/ultracodex
```

## 用法

当你让 Claude 把某个任务作为一个带第二模型参与的自定义 Workflow 来运行时，这个 skill 会自动
触发。能激活它的说法包括：

- "Run this as a custom workflow that mixes in codex."
- "Have codex adversarially verify the findings."
- "Use codex as a juror / second opinion in the workflow."
- "Cross-model verify this while you orchestrate."

随后 Claude 会编写一个 Workflow，其中 verify/judge 节点通过 shell 调出 `codex exec`，而
find/generate/synthesize 仍留在 Claude 上——并从一个模板起步。

## 工作原理——codex 节点

Workflow 脚本的 JS 主体**没有文件系统访问权限**，所以一个 codex 节点会把它的 JSON Schema
作为字符串嵌入，并交给具备 Bash 能力的包装（wrapper）subagent 把它写到一个临时文件。一个
`schema` 对象就是单一事实来源：它既用于 Codex 的 `--output-schema`，也在 `revalidate` 为
true 时用于 `agent()` 的二次校验。在默认的 `revalidate: true` 下，节点返回一个已解析的对象；
在 `revalidate: false` 下，它转发原始 JSON 文本，由调用方自行 `JSON.parse`。契约如下：

```
codexNode(taskText, { schema, sandbox='read-only', model, cwd, effort, revalidate=true, phase, label })
  → Promise<parsedObject>   // revalidate:true (default)
  → Promise<string>         // revalidate:false — you JSON.parse it
  → { _codex_error: true }  // on failure
```

有三条规则起着承重作用：

1. **转发者，而非求解者。** 作为包装的 Claude subagent 很聪明，会忍不住直接回答问题——
   悄悄地把这个跨模型节点塌缩回一个 Claude 节点。prompt 明确禁止这样做；不要削弱这条约束。
2. **从 `-o` 文件里提取，而不是从 stdout。** stdout 夹带着会话外壳（session chrome）；
   `-o` 才是那条干净 JSON 的路径。
3. **通过 stdin 传入 prompt**（`- < "$TASK"`），这样引号、`$` 和反引号都不会破坏或被展开。

可完整复制粘贴的 helper 标准版收录在
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md)；
其机制、flags、sandbox 分级、故障排查以及升级（escalation）模式则在
[`codex-headless.md`](./plugins/ultracodex/skills/codex-workflow/references/codex-headless.md)。

### 路由：Codex 节点 vs Claude 节点

| 节点的职责 | 在哪运行 | 原因 |
| --- | --- | --- |
| 寻找 / 生成 / 探索广度 | **Claude** | 快、cache-warm、扇出便宜 |
| 对抗式验证一个发现 | **Codex** | 不同的失败模式可降低相关性误报 |
| 评判 / 给候选项打分 | **Codex**（或混合面板） | 一个并未撰写该候选项的评审 |
| 多样面板中的一次尝试 | **混合** | 真正的解法多样性，而非换种说法的 Claude |
| 综合 / 决策 / 撰写汇总 | **Claude** | 掌握着编排上下文 |

## 成本、并发与升级

- **两个计费面。** 每个 codex 节点都要支付 Anthropic 这一侧包装回合的费用，*外加* Codex/OpenAI
  这次运行的费用。包装只做转发，但它仍背负着一个 subagent 的固定开销——不要随意扇出数百个；应当把小项**批处理（batch）**。
- **让 codex 节点保持简短。** 在 Codex 整个运行期间，每个节点都占用一个 Workflow 并发槽
  （`min(16, cores−2)`），与此同时包装则在一次阻塞式 Bash 调用上空转。只用于 read-only 的
  verify/judge/小规模生成。
- **把长任务升级出去。** 耗时数分钟到数小时、需要并行或可恢复的 Codex 作业**不属于** Pattern A
  ——请使用一个后台 worker 池，或一次性的交接（handoff）（在 skill 中有说明），切勿在 Workflow
  内部放一个长节点。

## 包里有什么

一个 skill，`codex-workflow`：

- **`SKILL.md`**——心智模型、`codexNode` 契约、那些承重规则、路由、成本/并发，以及 preflight。
- **`references/codex-headless.md`**——`codex exec` 的 flags、sandbox 分级、输出提取、坑点、
  故障排查、`_codex_error` 处理规范，以及升级模式。
- **`references/workflow-templates.md`**——标准的 `codexNode` helper 和四个完整的 Workflow 脚本，
  外加批处理节点（batch-node）与大负载（large-payload）变体。

```
ultracodex/                              # repo root = marketplace root
├── .claude-plugin/
│   └── marketplace.json                 # single-plugin marketplace catalog
├── plugins/
│   └── ultracodex/                      # the plugin
│       ├── .claude-plugin/
│       │   └── plugin.json              # plugin manifest
│       ├── README.md
│       └── skills/
│           └── codex-workflow/
│               ├── SKILL.md
│               └── references/
│                   ├── codex-headless.md
│                   └── workflow-templates.md
├── docs/                                # README translations (ko / ja / zh-CN)
├── LICENSE                              # Apache-2.0
├── NOTICE
└── README.md
```

范围有意限定为**仅 skill**：没有 commands、agents、hooks 或 MCP servers。

## 开发

```bash
claude plugin validate ./plugins/ultracodex   # plugin manifest + skill frontmatter
claude plugin validate .                       # marketplace manifest
claude plugin tag ./plugins/ultracodex         # cut a release tag (manifests must agree)
```

## 致谢

`codex-workflow` skill 是一个同名私有 in-repo（仓库内）skill 的开源泛化版本。本次发布移除了
特定环境相关的事实（改为通过 preflight 处理）以及私有路径引用，并且它本身就是用该插件自带的
混合 Claude+Codex workflow 开发并交叉核验出来的——包括这份 README，也是经过 cross-model
起草与校对的。

## 许可证

[Apache-2.0](./LICENSE) © 2026 KingGyuSuh
