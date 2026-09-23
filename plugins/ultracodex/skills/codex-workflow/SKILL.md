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
  review use the codex-review skill; to have Codex write code use codex-implement; for a single
  question or claim use codex-ask.
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

## Pick the mode — the cheapest one that does the job

| mode | how | Claude-side cost | use for |
| --- | --- | --- | --- |
| **direct** | the main conversation writes a request file and runs the runner (`start` + background `wait`); skills `codex-ask`, `codex-review` by hand, `codex-implement` | none beyond reading the answer | one question, one claim, one review, any implementation |
| **shipped workflow** | `Workflow({ name: 'ultracodex:…', args })` | a relay agent (Sonnet, low effort) per Codex call + Claude finders/triage | reviews and panels that need several Codex calls plus Claude checking them |
| **custom workflow** | a script with the helper block (`references/workflow-templates.md`) | as above | orchestration the shipped workflows do not cover |

Cost levers, in order of effect:

1. **Batch small items** (`codexBatchNode`, or the shipped workflows' default `batch`): one run
   reads the shared context once instead of N times.
2. **Cascade, astra last and narrow**: sol@xhigh verifies everything, astra@max re-checks only
   what would block a merge — `cross-review` does it by default (`finalGate`), `codex-review`
   sends only high/critical Claude-vs-Codex disagreements to astra (`escalate`). Both report
   an astra disagreement as **disputed** for the owner, never as silently dropped.
3. **luna@max** for triage, dedupe and quick sanity passes; **sol** for day-to-day; **astra**
   once, at the end. `ultra` and `serviceTier: 'priority'` only on explicit request.
4. **Read `codexUsage`** in every shipped workflow's result (runs and tokens per model, failed
   runs included) and mention it when reporting.

## Use a shipped workflow first

Run by name with `args` (JSON values, not strings):

- **`ultracodex:cross-review`** — Claude finders per dimension → Codex (sol@xhigh, batched)
  refutes each finding against the code → one astra@max run re-checks the confirmed
  high/critical findings → Claude report (confirmed / disputed / refuted / unverified).
  `args: { target, cwd, dimensions, verifyTier: 'daily'|'final', finalGate, context, lessons, batch }`
- **`ultracodex:codex-review`** — Codex reviews through lenses (`code`, `domain`, `security`,
  `tests`, `performance`) → Claude checks every finding in the code → high/critical findings
  Claude refuted or could not settle go to astra in one run → report.
  `args: { cwd, base | commit | uncommitted, lenses, tier: 'light'|'daily'|'final', escalate, context, lessons, triage }`
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

1. **Relay, not solver — and signed.** Each node runs through the `ultracodex:codex-relay`
   agent (Bash only, confined by the plugin's relay guard to the runner's own commands).
   Every result is signed by the runner (HMAC under a per-machine key, bound to the task);
   unsigned or foreign results are refused (`unauthenticated_result`, `relay_mismatch`,
   `no_provenance`), so a relay prompt-injected by reviewed content cannot fake a verdict.
2. **Byte-exact transport, both ways.** Requests are normalized, percent-encoded (no quote,
   backslash or control character reaches a Bash command), sent in ≤1.6 KB parts with per-part
   hashes (the Windows command line breaks near 8 KB) and verified by the runner; results come
   back with a `resultHash` (large ones in pages). Corrupted copies are resent or re-collected;
   a rejected relay call is a failed node, never a vanished one.
3. **Nothing blocks.** Codex runs detached under the runner's supervisor, which owns the
   deadline (model × effort × kind, scaled for batches) and tears down only the process tree
   it started. Every `wait` returns within two minutes. A workflow node nobody polls for
   15 min gets its run torn down (`abandoned`).
4. **Capped.** 4 Codex jobs per workflow (astra counts 2) and 4 machine-wide by default.
5. **Fail closed.** Partition with `ucxPartition`; a dead node is `unverified`; return
   `status: 'incomplete'` when a required node failed.

## Not a workflow node

- **One question or one claim** from the conversation → the `codex-ask` skill (direct, no relay).
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
