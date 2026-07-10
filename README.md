# ultracodex

**English** · [한국어](./docs/README.ko.md) · [日本語](./docs/README.ja.md) · [简体中文](./docs/README.zh-CN.md)

> **Claude orchestrates. Codex cross-checks.**
> Blend Codex headless (`codex exec`) nodes into Claude Code's own Workflow
> (*ultracode*) orchestration — so a genuinely different model family verifies,
> judges, and second-guesses at the points where same-model agreement is least
> trustworthy.

`ultracodex` is an open-source Claude Code plugin — a single skill,
`codex-workflow` — that teaches Claude how to mix
[Codex](https://github.com/openai/codex) headless nodes into a **Workflow**:
Claude Code's `agent()` / `pipeline()` / `parallel()` orchestration tool, a.k.a.
*ultracode*. The orchestration logic stays in Claude's JavaScript; only *who does
the work* changes at chosen nodes. This is **"Pattern A"** — and it is additive,
not a model-switcher. Both families run in one Workflow.

```
Workflow (Claude JS orchestration)
 ├─ find / generate / synthesize .. Claude agent()  ← broad, fast, cache-warm
 └─ verify / judge / 2nd-opinion ... codex node     ← GPT, independent failure modes
```

> **GPT-5.6 ready.** Model-agnostic by design: the GPT-5.6 generation
> (**Sol / Terra / Luna**, Codex CLI ≥ 0.144.0) worked with ultracodex on day
> one, no changes needed. The docs now add per-node **tier & effort** guidance —
> cheap tiers for wide verify fan-outs, the flagship (up to `max`, or `ultra` on
> Sol/Terra) for load-bearing verdicts — with the choice left to the
> orchestrating model.

> **Requires ultracode mode.** Because the skill *authors and runs* Workflows, the
> **Workflow** orchestration tool must be available — which in Claude Code means
> **ultracode mode** (enable it with `/effort` → ultracode; it turns on dynamic
> workflow orchestration). Without it the plugin still loads and the skill is found,
> but there is no Workflow tool to drive. See [Prerequisites](#prerequisites).

## Why it exists — the philosophy

More verifiers from the *same* model tend to share that model's blind spots: they
re-confirm the same **correlated false positives**. A different model family fails
on different inputs, so it can refute what same-model reviewers would rubber-stamp.
That is the whole idea:

- **Diversity, not replacement.** The win comes from *disagreement between
  independent models*, so the goal is to keep both families in one run — never to
  swap Claude out. "Add a second opinion" is right; "use GPT instead" misses the
  point.
- **Independent failure modes beat more of the same.** Routing a verify/judge node
  to Codex reduces *correlated* error — the kind N more Claude verifiers cannot
  catch because they fail in the same places.
- **The orchestration stays in Claude.** Claude holds the context, schemas,
  fan-out, and synthesis. A codex node is just a normal `agent()` whose subagent
  relays a `codex exec` run. No Workflow primitive changes — a low-surface-area way
  to get cross-model value.
- **A second model is not a source of truth.** It is *another failure-mode
  distribution*, best combined with tests, evidence, strict schemas, and a final
  Claude synthesis. "Independent" is also relative: a shared prompt, shared
  evidence, or a loose schema can still correlate errors — so use Codex
  deliberately, where there is a verifiable artifact to check.

## What you gain

- **Catch false positives that survive same-model review** — a different model
  family *can* refute *some* correlated Claude errors before you act on a finding or
  claim (a reduction in correlated error, not a guarantee).
- **Higher-trust verdicts on risky conclusions** — cross-check a headline result
  with a model that didn't produce it, before you report or ship.
- **Genuinely diverse judge panels** — score candidates with a jury where no model
  only judges its own work, cutting self-preference bias in LLM-as-judge setups.
- **Real solution diversity in generation** — a Codex attempt in an N-way panel is
  a different family's answer, not a reworded Claude one.
- **Large-context, multi-file verification with no new machinery** — point Codex at
  a tree (`cwd` / `-C`; read-only blocks writes, not reads) so it reads big diffs
  and files itself instead of you pasting them into a prompt.
- **Per-node tier & effort routing** — every codex node takes an open `model` /
  `effort` choice: `gpt-5.6-luna` at `low` for wide verify fan-outs,
  `gpt-5.6-sol` at `xhigh`/`max` (or `ultra`) when one verdict is load-bearing.
  Nothing is hard-coded; the orchestrating model picks per node.
- **Copy-paste ready** — four complete Workflow templates (cross-model review,
  mixed judge panel, single-conclusion cross-check, loop-until-dry) plus the
  canonical `codexNode` helper. You start from working scripts, not a blank file.
- **Minimal surface change** — keep every Workflow primitive exactly as-is; only
  the chosen nodes change hands.

## The highest-ROI use: adversarial verification

Claude finds broadly; Codex tries to **refute** each finding (defaulting to
"refuted" when uncertain). Survivors are the findings a different model family
could not knock down — a pipeline, no barrier:

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

Mixed **judge panels** and single-conclusion **second opinions** are the next
tiers — full scripts in
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md).

## When to use it — and when not to

Cross-model is signal, not free signal. Reach for a codex node when a *second,
independent model* materially de-risks the result — verifying findings, judging
candidates, an independent attempt in a panel, sanity-checking a risky conclusion.

**Skip the blend when:**

- it's bulk throughput work (Claude subagents are cheaper, faster, cache-warm);
- it's a **correlated check** — Codex would only re-derive from the same evidence,
  an echo rather than a second opinion;
- it's a **blind check** — the node can't give Codex what it needs to verify
  independently;
- there's no verifiable/judgeable artifact (open-ended ideation) — diversity adds
  noise, not signal.

## Prerequisites

- **Ultracode mode — the Workflow tool.** The skill *authors and runs* Workflows,
  so the **Workflow** tool (`agent()`/`pipeline()`/`parallel()`) must be available.
  In Claude Code that means **ultracode mode**: enable it with `/effort` → ultracode
  (xhigh + dynamic workflow orchestration). The skill only provides the know-how for
  *authoring* Workflows; it does **not** add the tool itself, so without ultracode
  mode it has nothing to drive.
- **Codex CLI, installed and authenticated.** Verify, then log in (interactive —
  it cannot be done headlessly):
  ```bash
  command -v codex && codex --version
  codex login
  ```
- **A POSIX shell** (`bash`/`zsh`) for the relay nodes.

> The skill hard-codes **no** Codex version or default model — environments differ.
> It ships a cheap **preflight** (CLI present, auth live, structured-output path)
> to run once before trusting any node.

## Installation

`ultracodex` is its own single-plugin marketplace. Add it, install the plugin,
reload:

```text
/plugin marketplace add KingGyuSuh/ultracodex
/plugin install ultracodex@ultracodex
/reload-plugins
```

Non-interactive (CLI) equivalent:

```bash
claude plugin marketplace add KingGyuSuh/ultracodex
claude plugin install ultracodex@ultracodex
# then restart Claude Code, or run /reload-plugins in an existing session
```

> The `@ultracodex` suffix on install is the marketplace **name** (top-level `name`
> in `.claude-plugin/marketplace.json`), independent of the repo name — they happen
> to match here.

### Try it without installing

```bash
claude --plugin-dir ./plugins/ultracodex
```

## Usage

The skill triggers automatically when you ask Claude to run a task as a custom
Workflow with a second model in the loop. Phrasings that activate it include:

- "Run this as a custom workflow that mixes in codex."
- "Have codex adversarially verify the findings."
- "Use codex as a juror / second opinion in the workflow."
- "Cross-model verify this while you orchestrate."

Claude then authors a Workflow whose verify/judge nodes shell out to `codex exec`
while find/generate/synthesize stay on Claude — starting from a template.

## How it works — the codex node

A Workflow script's JS body has **no filesystem access**, so a codex node embeds
its JSON Schema as a string and lets the Bash-capable wrapper subagent write it to
a temp file. One `schema` object is the single source of truth: it feeds Codex's
`--output-schema` and, when `revalidate` is true, the `agent()` re-validation. With
the default `revalidate: true` the node returns a parsed object; with
`revalidate: false` it relays raw JSON text for the caller to `JSON.parse`. The
contract:

```
codexNode(taskText, { schema, sandbox='read-only', model, cwd, effort, revalidate=true, phase, label })
  → Promise<parsedObject>   // revalidate:true (default)
  → Promise<string>         // revalidate:false — you JSON.parse it
  → { _codex_error: true }  // on failure
```

Three rules are load-bearing:

1. **Relay, not solver.** The wrapping Claude subagent is smart and will be tempted
   to just answer the question — silently collapsing the cross-model node back into
   a Claude node. The prompt forbids this; keep it at full strength.
2. **Extract from the `-o` file, not stdout.** stdout carries session chrome;
   `-o` is the one clean-JSON path.
3. **Pass the prompt via stdin** (`- < "$TASK"`) so quotes, `$`, and backticks
   can't break or expand.

The full copy-paste helper lives canonically in
[`workflow-templates.md`](./plugins/ultracodex/skills/codex-workflow/references/workflow-templates.md);
the mechanics, flags, sandbox tiers, troubleshooting, and escalation patterns are
in [`codex-headless.md`](./plugins/ultracodex/skills/codex-workflow/references/codex-headless.md).

### Routing: Codex node vs Claude node

| Node's job | Run it on | Why |
| --- | --- | --- |
| Find / generate / explore breadth | **Claude** | fast, cache-warm, cheap fan-out |
| Adversarially verify a finding | **Codex** | different failure modes can reduce correlated false positives |
| Judge / score candidates | **Codex** (or mixed panel) | a juror that didn't write the candidate |
| One attempt in a diverse panel | **mix** | genuine solution diversity, not reworded Claude |
| Synthesize / decide / write-up | **Claude** | holds the orchestration context |

## Cost, concurrency & escalation

- **Two billing surfaces.** Every codex node pays the Anthropic wrapper turn *plus*
  the Codex/OpenAI run. The wrapper only relays, but it still has a subagent's fixed
  overhead — don't fan out hundreds casually; **batch** small items instead.
- **Keep codex nodes short.** Each holds a Workflow concurrency slot
  (`min(16, cores−2)`) for Codex's entire runtime while the wrapper idles on a
  blocking Bash call. Read-only verify/judge/small-gen only.
- **Escalate long work.** Minutes-to-hours, parallel, or resumable Codex jobs are
  **not** Pattern A — use a background worker pool or a single-shot handoff
  (described in the skill), never a long node inside a Workflow.

## What's in the box

A single skill, `codex-workflow`:

- **`SKILL.md`** — the mental model, the `codexNode` contract, the load-bearing
  rules, routing, cost/concurrency, and the preflight.
- **`references/codex-headless.md`** — `codex exec` flags, sandbox tiers, output
  extraction, gotchas, troubleshooting, the `_codex_error` discipline, and
  escalation patterns.
- **`references/workflow-templates.md`** — the canonical `codexNode` helper and four
  complete Workflow scripts, plus batch-node and large-payload variants.

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

Scope is deliberately **skill-only**: no commands, agents, hooks, or MCP servers.

## Development

```bash
claude plugin validate ./plugins/ultracodex   # plugin manifest + skill frontmatter
claude plugin validate .                       # marketplace manifest
claude plugin tag ./plugins/ultracodex         # cut a release tag (manifests must agree)
```

## Acknowledgements

The `codex-workflow` skill is the open-source generalization of a private in-repo
skill of the same name. This release removes environment-specific facts (it
preflights instead) and private path references, and was itself developed and
cross-checked using the plugin's own blended Claude+Codex workflows — including this
README, drafted and proofread cross-model.

## License

[Apache-2.0](./LICENSE) © 2026 KingGyuSuh
