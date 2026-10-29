---
name: codex-review
description: >-
  Adversarial code review by Codex (GPT-6) of a branch, commit or uncommitted change —
  read-only and hermetic, through lenses (code, domain, security, tests, performance), with
  every finding then verified by Claude in the code before it is reported. Use when the user
  asks for a Codex review, a second-model / cross-model / adversarial review, "have codex
  review this", "review with astra / sol / terra", a final review gate before merge or deploy,
  or a specific review lens. With no tier, pass 1 runs every lens, including security, on
  gpt-6.1-sol@xhigh, and a fix-delta pass (pass above 1) runs on gpt-6.1-terra@xhigh. Astra at
  max is for critical work only; quick sanity passes use gpt-6.1-terra@xhigh.
  It also says whether a re-review is worth it and how narrow it should be.
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

- `daily` → gpt-6.1-sol@xhigh — the normal review of a change;
- `final` → gpt-6-astra@max — critical work only: security-sensitive code (auth, keys, crypto,
  payments, personal data), data migrations, irreversible production steps, or the last gate
  before a production release;
- `light` → gpt-6.1-terra@xhigh — a quick pass on a small or mechanical change, and the default
  for a fix-delta pass (pass above 1).

Say which pass this is: `1` is the first review of the change. When possible, commit the work
under review first. Record `git -C "<repo>" rev-parse HEAD` as the reviewed commit before each
pass — it is the base of a later fix delta.

For pass 2 and later, use `rereview.tier` and, when it is set, `rereview.securityTier` (see section 6),
or omit `tier`: the workflow then uses `light`. For pass 1, when the owner named no tier, pick it from the change itself — measure it first with
`git -C "<repo>" diff --shortstat <scope>` (and `--name-only`):

- **`final`** for the critical categories above — whatever the change's size. Use
  `securityTier: 'final'` when only the security lens needs Astra, or `tier: 'final'` for every lens;
- else **`light`** if no security lens was requested and the change is either small (about
  50 changed lines or fewer, in at most 3 files) or mechanical (docs, comments, renames,
  formatting, config values, test scaffolding only);
- else **omit `tier`**: on pass 1 the workflow uses `daily` on every lens, including `security`.

An explicit owner-selected `tier` sets every lens, including security, unless you also pass
`securityTier`: an explicit `securityTier` always sets the security lens. When the owner names one
tier for every lens ("use sol"), do not pass `securityTier`. For a critical final gate, pass
`tier: 'final'` so Astra reviews every requested lens.

Keep routine Sol reviews at `xhigh`, including large diffs. Use Sol at `max` only as an
explicit request-field override in a direct run or `codexNode` call for an exceptional
unresolved problem after an `xhigh` attempt, or at the owner's request; state the reason.

Say which tier you picked and why in one line, so the owner can override it ("use sol",
"use astra").

Ask for (or infer) a line of **context**: what the change is for and the domain rules it must
keep. If the project keeps a recurring-defects checklist (e.g. `REVIEW_LESSONS.md`), pass it as
`lessons` — reviewers check every item.

## 2. Run it — preferred: the shipped workflow

```
Workflow({ name: 'ultracodex:codex-review', args: {
  cwd: '<abs repo path>', base: 'main', lenses: ['code', 'domain'], pass: 1,
  context: '<what the change is for>', lessons: '<abs path or omit>' } })
```

Add `tier` when selected above or explicitly requested by the owner. With no tier, pass 1 uses
Sol 6.1 at `xhigh` on every lens, and a pass above 1 uses Terra 6.1 at `xhigh` (`light`) on every
lens. Optional `securityTier: 'light'|'daily'|'final'` always sets the security lens, also when
`tier` is given; `tier` sets every other lens, and the security lens only when no valid
`securityTier` is given. Use `securityTier: 'final'` for critical security work, and pass the same
`securityTier` on every pass of a change. Invalid values are ignored. If the owner names one tier for
every lens ("use sol"), do not pass `securityTier`. `lenses[].tier` and `lenses[].model` record the
model used, including failed lenses.

`pass` is a positive integer. Missing or invalid values default to `2` when `priorFindings`
is given, otherwise `1`. `priorFindings` holds the previous findings and what was done about each;
pass a string, or an array/object (serialized as JSON). For `pass > 1`, each lens checks those
findings and only the fix delta. `ownerApproved` is a boolean; a pass above `3` is refused
unless the owner gave OK and you pass `ownerApproved: true`.

It runs one Codex review per lens (hermetic, read-only, astra ≤2 at a time), has Claude check
every finding in the code (confirmed / refuted / needs-info) and rate its severity itself —
Codex tends to rate findings above their real impact, so the ranking and the verdict follow
Claude's rating, with every change listed (`severityChanges`) — sends the high/critical findings
Claude refuted or could not settle to gpt-6-astra in one run (`escalate`, default on for findings
from non-Astra lenses) and writes the report. Astra findings are not sent to Astra again.
A lens that failed makes the result `incomplete` — say
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
+ lessons. Use `daily` for every routine lens on pass 1, including security, `light` on a fix-delta
pass (pass above 1), or `light` when selected above. For critical work, use `final` on the security lens or on every lens for a final critical
gate. An explicit owner-selected tier overrides that choice. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" start --request "<request.json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" wait <runId> --max-wait 7200   # run_in_background: true
```

You are notified when the background `wait` exits; one lens takes ~10–35 min. Start the lenses
together (the runner queues beyond its machine-wide cap).

## 4. Triage — never forward Codex findings unverified

For every finding: open the file and the callers, and decide **confirmed** (defect real,
failure scenario reachable), **refuted** (say why), or **needs-info** (what must be checked).
Codex is evidence, not authority — also on severity: it tends to rate findings higher than
their real impact. Rate each one yourself (impact × likelihood under the threat model): lower
it when the failure needs conditions that practically never occur, is caught or harmless, or
an existing control covers it; keep it when someone the threat model includes can trigger it
at will. Note every change as "Codex: high → medium — <the precondition or control>". When you and a sol review disagree on something important,
re-check those findings on the final tier in **one** request (`tier: 'final'`, `kind: 'verify'`,
the multi-claim schema from the `codex-ask` skill, `workItems: N`) — the workflow does this
itself (`escalate`).

## 5. Report

Confirmed findings ranked by your severity (file:line, failure scenario, fix; Codex's rating
beside it where you changed it), then needs-info, then a one-line list of refuted ones;
per-lens verdicts and models used; an overall line that follows your ratings: do not ship for a
confirmed critical/high (or one still unresolved), ship after fixes when the worst is medium,
ship when only low ones remain. If any lens failed, the review is **incomplete** —
say so first. Do not merge anything on the strength of the review alone; the owner decides.
Merge duplicate findings about the same root cause into one item and list all their ids.
Keep the overall verdict, then end with the workflow's `Re-review:` line verbatim.

## 6. After the review — fixes and re-review

Follow `rereview` in the workflow result, also shown in the report's last `Re-review:` line.
If lenses failed, re-run only `rereview.rerunLenses` first, on the same scope and with the same
pass number. That is not a new pass.
Each result covers only its lenses: keep the first result and merge both runs' findings and
`rereview.carry` after the retry. Follow the stricter `rereview`: worse `worst`, recommendation
`owner > delta > none`, tier `final > daily > light`.

- **`none`** → no new pass. Low findings are optional: fix now only those that take a few
  lines and are obviously correct. Put the rest in the PR as follow-ups or known limits.
  At the cap with medium findings, fix and verify without another pass, or document known limits.
- **`delta`** → fix, verify (build, tests, diff), and commit. Run the workflow with
  `base: '<reviewed commit>'`, `pass: N + 1`, and `tier: rereview.tier` (or `daily` for a large delta,
  see below). When `rereview.securityTier` is set, also pass `securityTier: rereview.securityTier`:
  it sets the security lens even when `tier` is given, so one call can run the other lenses on
  `daily` and the security lens on `final`.
  Build `priorFindings` from `rereview.carry` (id, status, severity, title, file:line).
  For each, add what was done: fixed (how), still open (why), or left as a follow-up / known limit.
  After a non-final pass, medium and high/critical deltas use `light`. After a `final` pass,
  medium deltas use `daily` and high/critical deltas use `final`.
  When the tier is `light`, use `daily` instead if the delta is more than about 50 changed lines
  or more than 3 files, or if the fix changed the design. A full re-review (`base: 'main'`) is only
  for a large or design-changing fix.
  When Codex implemented the change, send the fix brief to its open implement session as a
  follow-up (`codex_send` / `send <runId>`), not as a new run (see `codex-implement`).
- **`owner`** → stop and report; do not ship with a high or critical finding open. At most
  3 passes per change. A fourth pass needs the owner's OK (`ownerApproved: true`).

New feature work added later, rather than fixes, is a new change. Review its own delta as pass 1.

## Rules

- Read-only: review runs never get `workspace-write`.
- Never stop Codex processes this plugin did not start. `cancel <runId>` only for runs you
  started, when the owner asks. A `supervisor_lost` run is reported, not killed.
- Failures are "no data", never a clean review: `timeout`, `abandoned`, `usage_limit`, `auth`,
  `schema` … → report the lens as not reviewed.
