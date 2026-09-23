---
name: codex-review
description: >-
  Adversarial code review by Codex (GPT-6) of a branch, commit or uncommitted change —
  read-only and hermetic, through lenses (code, domain, security, tests, performance), with
  every finding then verified by Claude in the code before it is reported. Use when the user
  asks for a Codex review, a second-model / cross-model / adversarial review, "have codex
  review this", "review with astra / sol / luna", a final review gate before merge or deploy,
  or a specific review lens. Day-to-day reviews run on gpt-6-sol@max, the final gate on
  gpt-6-astra@max, a quick sanity pass on gpt-6-luna@max.
---

# Codex adversarial review

Runner: `${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs` · lens texts: `references/lenses.md` ·
tier policy: `${CLAUDE_PLUGIN_ROOT}/skills/codex-workflow/references/model-policy.md`

## 1. Preflight and scope

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" preflight
```

Settle before starting: the repo (absolute path), the scope (`base` branch, one `commit`, or
`uncommitted`), the lenses (default `code` + `domain`), and the tier:

- `daily` → gpt-6-sol@max — the normal review of a change;
- `final` → gpt-6-astra@max — "at the end": the last gate before merge/deploy, and any change
  touching security, money, concurrency, data migrations or irreversible external effects;
- `light` → gpt-6-luna@max — a quick pass on a small or mechanical change.

Ask for (or infer) a line of **context**: what the change is for and the domain rules it must
keep. If the project keeps a recurring-defects checklist (e.g. `REVIEW_LESSONS.md`), pass it as
`lessons` — reviewers check every item.

## 2. Run it — preferred: the shipped workflow

```
Workflow({ name: 'ultracodex:codex-review', args: {
  cwd: '<abs repo path>', base: 'main', lenses: ['code', 'domain'], tier: 'daily',
  context: '<what the change is for>', lessons: '<abs path or omit>' } })
```

It runs one Codex review per lens (hermetic, read-only, astra ≤2 at a time), has Claude check
every finding in the code (confirmed / refuted / needs-info), sends the high/critical findings
Claude refuted or could not settle to gpt-6-astra in one run (`escalate`, default on below the
final tier) and writes the report. A lens that failed makes the result `incomplete` — say
which lens and why. **Disputed** findings (Claude doubted them, astra upheld them) go to the
owner with both reasonings. Mention `codexUsage` (runs and tokens per model) in the summary.

## 3. Or by hand (no Workflow)

For each lens, write a request file with the **Write tool** (never a heredoc — large text and
backslashes break Bash commands on Windows):

```json
{
  "taskFile": "<abs path of the lens brief you wrote>",
  "cwd": "<abs repo path>",
  "tier": "daily",
  "kind": "review",
  "schemaPreset": "review",
  "label": "review:code"
}
```

The brief = the lens text from `references/lenses.md` + the scope sentence ("Review the changes
on the current branch against main: `git diff main...HEAD`, plus uncommitted changes") + context
+ lessons. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" start --request "<request.json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" wait <runId> --max-wait 7200   # run_in_background: true
```

You are notified when the background `wait` exits; one lens takes ~10–35 min. Start the lenses
together (the runner queues beyond its machine-wide cap).

## 4. Triage — never forward Codex findings unverified

For every finding: open the file and the callers, and decide **confirmed** (defect real,
failure scenario reachable), **refuted** (say why), or **needs-info** (what must be checked).
Codex is evidence, not authority. When you and a sol review disagree on something important,
re-check those findings on the final tier in **one** request (`tier: 'final'`, `kind: 'verify'`,
the multi-claim schema from the `codex-ask` skill, `workItems: N`) — the workflow does this
itself (`escalate`).

## 5. Report

Confirmed findings ranked by severity (file:line, failure scenario, fix), then needs-info, then
a one-line list of refuted ones; per-lens verdicts; the tier used; an overall line
(ship / ship after fixes / do not ship). If any lens failed, the review is **incomplete** —
say so first. Do not merge anything on the strength of the review alone; the owner decides.

## Rules

- Read-only: review runs never get `workspace-write`.
- Never stop Codex processes this plugin did not start. `cancel <runId>` only for runs you
  started, when the owner asks. A `supervisor_lost` run is reported, not killed.
- Failures are "no data", never a clean review: `timeout`, `abandoned`, `usage_limit`, `auth`,
  `schema` … → report the lens as not reviewed.
