---
name: codex-workflow
description: >-
  Blend Codex (GPT-6 via `codex exec`) nodes into a Claude Code Workflow (the Workflow tool's
  agent()/pipeline()/parallel() orchestration, a.k.a. "ultracode") — cross-model adversarial
  verification, judge panels with a Codex juror, a Codex cross-check of a risky conclusion,
  loop-until-dry audits with a Codex gate. Ships ready workflows (ultracodex:cross-review,
  ultracodex:codex-review, ultracodex:crosscheck, ultracodex:judge-panel) and the codexNode
  helper for custom scripts. Use whenever the user wants a workflow AND a second model family
  in the loop: "custom workflow using codex", "blend codex into the workflow", "have codex
  verify/double-check the findings", "codex as verifier/juror/second opinion", "cross-model
  verify while orchestrating", "Claude and codex in one workflow". For a standalone Codex
  review use the codex-review skill; to have Codex write code use codex-implement.
---

# Codex nodes inside Workflows

A Workflow's `agent()` normally runs a Claude subagent. A **codex node** routes one node to a
different model family (Codex / GPT-6) while the orchestration stays in Claude's script.
The value is **diversity**: a Codex verifier catches Claude's correlated false positives in a
way N more Claude verifiers cannot. Highest-ROI use: Claude finds, Codex refutes.

Runner (absolute path, substituted by Claude Code):
`${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs`

## Before the first node — preflight (no model call)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" preflight --pretty
```

It checks the Codex CLI, `codex login status`, refreshes the model catalog and reports any
policy model missing from it. `ok: false` → stop and tell the user (auth needs an interactive
`codex login`). `--live` adds one tiny luna call to prove the whole path.

## Step 0 — does this task need Codex?

Route a node to Codex only when a second, independent model materially de-risks the result:
verifying findings/claims, judging candidates, one attempt in a diverse panel, cross-checking a
risky conclusion. Not for bulk throughput (Claude subagents are cheaper and cache-warm), not for
an echo check with no independent angle, not for open-ended ideation with nothing to judge.

## Pick the tier (see references/model-policy.md)

| tier | model @ effort | for |
| --- | --- | --- |
| `light` | gpt-6-luna @ max | light work: triage, dedupe, wide fan-outs of small checks, summaries |
| `daily` | gpt-6-sol @ xhigh (verify) / max (ask, review) | day-to-day verification, jurors, second opinions, review lenses |
| `final` | gpt-6-astra @ max | very advanced work and the last word: final gate, load-bearing verdicts, security/money/concurrency |

Cascade with astra last; never fan astra out wide; `ultra` only by explicit request, once.

## Use a shipped workflow first

Run by name with `args` (JSON values, not strings):

- **`ultracodex:cross-review`** — Claude finders per dimension → Codex refutes each finding
  against the code → Claude report. `args: { target, cwd, dimensions, verifyTier: 'daily'|'final', context, lessons, batch }`
- **`ultracodex:codex-review`** — Codex reviews through lenses (`code`, `domain`, `security`,
  `tests`, `performance`) → Claude checks every finding in the code → report.
  `args: { cwd, base | commit | uncommitted, lenses, tier: 'daily'|'final', context, lessons, triage }`
- **`ultracodex:crosscheck`** — one Codex attempt (astra@max) to refute one claim.
  `args: { claim, evidence, cwd, tier }`
- **`ultracodex:judge-panel`** — Claude angles + a Codex candidate, Claude+Codex jury,
  cross-family ranking, synthesis. `args: { problem, angles, cwd, codexCandidate }`

Always pass `cwd` as the absolute repo path when Codex must read code. Relay the returned
`status`: `incomplete` means some Codex node failed and its items are unverified — say so.

## Custom scripts

Read `references/workflow-templates.md`, paste its helper block once near the top of the
script, and call:

```js
const v = await codexNode(taskText, { schemaPreset: 'verdict', tier: 'daily', kind: 'verify', cwd: 'C:/repo', label: 'codex:x', phase: 'Verify' })
if (isCodexError(v)) { /* unverified — never a pass */ }
```

`schema` must be strict (every object `additionalProperties: false` and every property listed
in `required`, at every level — the runner rejects anything else before a run is spent).
Presets: `verdict`, `score`, `review`, `implement`.

What the helper guarantees (keep it intact):

1. **Relay, not solver.** Each node runs through the `ultracodex:codex-relay` agent (Bash only).
   Results without a Codex thread id + token usage are rejected as `no_provenance`.
2. **Byte-exact transport.** Requests are normalized, percent-encoded (no quote, backslash or
   control character reaches a Bash command), sent in ≤2.4 KB parts (the Windows command line
   breaks near 8 KB) and hash-verified by the runner; a corrupted copy is retried once.
3. **Nothing blocks.** Codex runs detached under the runner's supervisor, which owns the
   deadline (model × effort × kind) and tears down only the process tree it started. Every
   `wait` returns within two minutes. A relay that stops polling for 5 min gets its run torn
   down (`abandoned`).
4. **Capped.** 4 Codex jobs per workflow (astra counts 2) and 4 machine-wide by default.
5. **Fail closed.** Partition with `ucxPartition`; a dead node is `unverified`; return
   `status: 'incomplete'` when a required node failed.

## Not a workflow node

- Codex **writing code** (minutes to hours, workspace-write) → the `codex-implement` skill.
- A **standalone review** of a branch/commit → `codex-review` (or the `ultracodex:codex-review` workflow).
- Anything interactive → plain `codex` in a terminal.

## Runner commands you may need

`status [RUN_ID]` · `result RUN_ID` · `wait RUN_ID` · `cancel RUN_ID` (only runs this plugin
started, and only when the owner asks) · `gc` · `policy` · `models` · `schema PRESET` ·
`schema-check --schema FILE` · `dry-run --request FILE`. Full reference, error kinds and
troubleshooting: `references/codex-headless.md`.

**Never stop Codex processes this plugin did not start** (the owner runs parallel Codex
sessions). A `supervisor_lost` run is reported, not killed: show `status` and ask.
