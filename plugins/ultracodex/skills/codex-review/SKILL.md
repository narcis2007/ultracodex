---
name: codex-review
description: >-
  Adversarial code review by Codex (GPT-6) of a branch, commit or uncommitted change —
  read-only and hermetic, through lenses (code, domain, security, tests, performance), with
  every finding then verified by Claude in the code before it is reported. Use when the user
  asks for a Codex review, a second-model / cross-model / adversarial review, "have codex
  review this", "review with astra / sol / terra", a final review gate before merge or deploy,
  or a specific review lens. Choose the review by risk: no Codex review for a small, low-risk
  change; lenses code + domain for a normal change; add security when the change touches
  authentication, permissions, personal data, money, secrets or outside input; critical work
  gets code + domain + security, then astra at max as the last gate. With no tier, pass 1 runs
  every lens, including security, on gpt-6.1-terra at max effort, and a fix-delta pass (pass
  above 1) runs on gpt-6.1-terra at xhigh. At most 2 passes per change. The astra tiebreak is
  opt-in (escalate: true). It also says whether a re-review is worth it and how narrow it should be.
---

# Codex adversarial review

Runner: `${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs` · lens texts: `references/lenses.md` ·
tier policy: `${CLAUDE_PLUGIN_ROOT}/skills/codex-workflow/references/model-policy.md`

## 1. Preflight and scope

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" preflight
```

First decide whether a Codex review is needed, and how big. Choose by risk. Measure the change
first with `git -C "<repo>" diff --shortstat <scope>` (and `--name-only`). `diff` does not show
untracked files: for the `uncommitted` scope also run `git -C "<repo>" status --short --untracked-files=all`.
New files count as changed files, and their lines as changed lines.

- **Small and low-risk change → no Codex review.** About 50 changed lines or fewer in at most
  3 files, or a mechanical change (docs, comments, renames, formatting, config values), that
  touches no money or payments, authentication or login, permissions or tenant isolation,
  personal data, secrets, input from outside (uploads, webhooks, URLs, third-party payloads),
  migrations or external effects. These risk categories win over the size shortcut: a one-line
  change in any of them gets a review. Verify the diff and the tests yourself. If the owner asks
  for a review anyway, run one with `tier: 'light'` (gpt-6.1-terra@xhigh).
- **Normal change → lenses `code` + `domain`**, with the defaults: pass 1 runs every lens on
  gpt-6.1-terra at `max`.
- **Add the `security` lens** when the change touches login or authentication, permissions or
  tenant isolation, personal data, money or payments, secrets, or input from outside (uploads,
  webhooks, URLs, third-party payloads).
- **Critical work → `code` + `domain` + `security`, then astra at max as the last gate.**
  Critical work is: security-sensitive code (auth, keys, crypto, payments, personal data), data
  migrations, irreversible production steps, or the last gate before a production release.
  The Terra passes come first (pass 1, and at most one fix delta). Then one astra@max gate runs
  on the revision that is meant to ship: `tier: 'final'` for every lens, or `lenses: ['security']`
  with `securityTier: 'final'` for security only, with `priorFindings` from the earlier passes.
  The gate is one extra run on top of the cap of 2. It takes the next pass number: pass 2 when
  pass 1 needed no delta pass, pass 3 (with `ownerApproved: true`) after a delta pass. It needs
  the owner's OK anyway, because Astra uses much more of the Codex usage limit than Terra or
  Sol: tell the owner, and ask first when the owner's rules say so. After the gate, a medium finding is fixed and verified with the tests and the diff
  (a `daily` delta only if the owner wants one); a high/critical finding goes to the owner.
- The `tests` lens stays available, but it is not a default: measured, it finds almost nothing
  the other lenses miss. Add it only when the owner asks.

The tiers:

- no `tier` (the default) → pass 1: gpt-6.1-terra@**max** on every lens, including `security`;
  a fix-delta pass (pass above 1): gpt-6.1-terra@xhigh. Why: on replayed review jobs, Terra at
  max found more must-find defects than Sol at xhigh, at the same cost;
- `light` → gpt-6.1-terra@xhigh — an explicit quick pass on a small change the owner wants
  reviewed, and the default for a fix-delta pass. An explicit tier keeps its own default effort;
- `daily` → gpt-6.1-sol@xhigh — only when the owner asks for Sol. Sol stays the model for plan
  checks, second opinions and implementation; code review moved to Terra;
- `final` → gpt-6-astra@max — critical work only (see above).

Optional `effort` (`low|medium|high|xhigh|max`) sets the effort of every lens that is not on
`final`. Astra always runs at its own default (`max`).

Say which pass this is: `1` is the first review of the change. When possible, commit the work
under review first. Record `git -C "<repo>" rev-parse HEAD` as the reviewed commit before each
pass — it is the base of a later fix delta.

For pass 2, use `rereview.tier` and, when it is set, `rereview.securityTier` (see section 6),
or omit `tier`: the workflow then uses `light` at its default effort (xhigh).

An explicit owner-selected `tier` sets every lens, including security, unless you also pass
`securityTier`: an explicit `securityTier` always sets the security lens, and keeps that tier's
own default effort. When the owner names one tier for every lens ("use sol"), do not pass
`securityTier`. For a critical final gate, pass `tier: 'final'` so Astra reviews every requested
lens.

Keep Sol at `xhigh` when you use it, including large diffs. Use Sol at `max` only as an explicit
override for an exceptional unresolved problem after an `xhigh` attempt, or at the owner's
request; state the reason.

Say which review you picked and why in one line, so the owner can override it ("use sol",
"use astra", "no review").

Ask for (or infer) a line of **context**: what the change is for and the domain rules it must
keep. If the project keeps a recurring-defects checklist (e.g. `REVIEW_LESSONS.md`), pass it as
`lessons` — reviewers check every item.

## 2. Run it — preferred: the shipped workflow

```
Workflow({ name: 'ultracodex:codex-review', args: {
  cwd: '<abs repo path>', base: 'main', lenses: ['code', 'domain'], pass: 1,
  context: '<what the change is for>', lessons: '<abs path or omit>' } })
```

Add `tier` when the owner asked for one. With no tier, pass 1 uses Terra 6.1 at `max` on every
lens, and a pass above 1 uses Terra 6.1 at `xhigh` (`light`) on every lens. Optional
`securityTier: 'light'|'daily'|'final'` always sets the security lens, also when `tier` is given;
`tier` sets every other lens, and the security lens only when no valid `securityTier` is given.
With no `securityTier`, the security lens follows the other lenses (Terra at `max` on pass 1).
Use `securityTier: 'final'` for the security lens of the astra gate (see section 1). Once you
pass a `securityTier` on a pass, pass the same one on every later pass of the change. Invalid
values are ignored. If the owner names one tier for every lens ("use
sol"), do not pass `securityTier`. `lenses[].tier`, `lenses[].model` and `lenses[].effort` record
what ran, including failed lenses.

`pass` is a positive integer. Missing or invalid values default to `2` when `priorFindings`
is given, otherwise `1`. `priorFindings` holds the previous findings and what was done about each;
pass a string, or an array/object (serialized as JSON). For `pass > 1`, each lens checks those
findings and only the fix delta. At most **2 passes** per change: `ownerApproved` is a boolean,
and a pass above `2` is refused unless the owner gave OK and you pass `ownerApproved: true`.

It runs one Codex review per lens (hermetic, read-only, astra ≤2 at a time) and has Claude check
every finding in the code (confirmed / refuted / needs-info) and rate its severity itself —
Codex tends to rate findings above their real impact, so the ranking and the verdict follow
Claude's rating, with every change listed (`severityChanges`). Then it writes the report.

The **astra tiebreak is opt-in**. With `escalate: true`, the workflow sends the high/critical
findings (by Codex's rating) that Claude refuted or could not settle to gpt-6-astra in one run,
for findings from non-Astra lenses; Astra findings are not sent to Astra again. Nothing is dropped
silently: a high/critical finding that Claude doubted and no tiebreak looked at is listed as
**not cross-checked**, in `notCrossChecked` (with Codex's evidence and failure scenario, and a
`reason`), in the report and in a `Not cross-checked:` line before the `Re-review:` line. That is
every such finding when `escalate` is off (`reason: 'escalate_off'`), and the ones from an astra
lens also when it is on (`reason: 'astra_lens'`). Check each one yourself in the code. For
`escalate_off` ones you can also ask the owner for an astra run on just those findings (`codex-ask`
with `tier: 'final'`, or `ultracodex:crosscheck`); an `astra_lens` finding was written by astra, so
no astra run applies. A needs-info finding rated high/critical still counts as unresolved in the
verdict and in `rereview`. Re-running the whole review with `escalate: true` costs all lenses
again: do it only when the owner wants that.

A lens that failed makes the result `incomplete` — say which lens and why. **Disputed** findings
(Claude doubted them, astra upheld them; only with `escalate: true`) go to the owner with both
reasonings. Mention `codexUsage` (runs and tokens per model) in the summary.

## 3. Or by hand (no Workflow)

For each lens, write a request file with the **Write tool** (never a heredoc — large text and
backslashes break Bash commands on Windows):

```json
{
  "taskFile": "<abs path of the lens brief you wrote>",
  "cwd": "<abs repo path>",
  "tier": "light",
  "effort": "max",
  "kind": "review",
  "schemaPreset": "review",
  "label": "review:code"
}
```

The brief = the lens text from `references/lenses.md` + the scope sentence ("Review the changes
on the current branch against main: `git diff main...HEAD`, plus uncommitted changes") + context
+ lessons. Use `"tier": "light", "effort": "max"` (Terra at max) for every lens on pass 1,
including security, and `"tier": "light"` without `effort` (Terra at xhigh) on a fix-delta pass
(pass above 1) or for a quick pass. For critical work, use `final` on the security lens or on
every lens for a final critical gate. An explicit owner-selected tier overrides that choice.
Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" start --request "<request.json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" wait <runId> --max-wait 7200   # run_in_background: true
```

You are notified when the background `wait` exits. One Terra at max lens took about 8 minutes
in the benchmark and takes longer on a large diff; the runner stops it after 45 minutes. One
Astra lens takes 25–35 minutes. Start the lenses together (the runner queues beyond its
machine-wide cap).

## 4. Triage — never forward Codex findings unverified

For every finding: open the file and the callers, and decide **confirmed** (defect real,
failure scenario reachable), **refuted** (say why), or **needs-info** (what must be checked).
Codex is evidence, not authority — also on severity: it tends to rate findings higher than
their real impact. Rate each one yourself (impact × likelihood under the threat model): lower
it when the failure needs conditions that practically never occur, is caught or harmless, or
an existing control covers it; keep it when someone the threat model includes can trigger it
at will. Note every change as "Codex: high → medium — <the precondition or control>". When you
and a Codex review disagree on something important (high/critical), do not drop the finding
quietly. Check it again yourself, or re-check those findings on the final tier in **one**
request (`tier: 'final'`, `kind: 'verify'`, the multi-claim schema from the `codex-ask` skill,
`workItems: N`) — but only when the owner agrees to an astra run. The workflow does this itself
when you pass `escalate: true`. A finding from an astra lens that Claude doubted gets no astra
run (astra wrote it): the workflow lists it as not cross-checked, and you check it in the code.
If your check confirms such a finding, it is a confirmed finding at your severity (section 5).

## 5. Report

Confirmed findings ranked by your severity (file:line, failure scenario, fix; Codex's rating
beside it where you changed it), then disputed (if any), then the high/critical findings that
were **not cross-checked**, then needs-info, then a one-line list of refuted ones;
per-lens verdicts, models and efforts used; an overall line that follows your ratings: do not
ship for a confirmed critical/high (or one still unresolved), ship after fixes when the worst is
medium, ship when only low ones remain. If any lens failed, the review is **incomplete** —
say so first. Do not merge anything on the strength of the review alone; the owner decides.
Merge duplicate findings about the same root cause into one item and list all their ids.
When your own check of a not-cross-checked finding changes nothing, keep the overall verdict and
end with the workflow's `Not cross-checked:` line (when there is one) and `Re-review:` line
verbatim. When your check confirms such a finding, it is a confirmed finding at your severity:
the overall verdict follows it (confirmed critical/high → do not ship), and so does the
re-review decision (medium or worse on pass 1 → a delta pass with it in `priorFindings`; on
pass 2 → the pass 2 rules in section 6). Say plainly that this overrides the workflow's
`Re-review:` line, and amend that line and the `Not cross-checked:` entry you settled.

## 6. After the review — fixes and re-review

Follow `rereview` in the workflow result, also shown in the report's last `Re-review:` line.
If lenses failed, re-run only `rereview.rerunLenses` first, on the same scope and with the SAME
arguments as the first call (same `pass`, same `tier` or no `tier`, same `securityTier`, same
`effort`). Do not pass the returned `tier: 'light'` explicitly: on a default pass 1 that would run
terra@xhigh instead of terra@max. That is not a new pass.
Each result covers only its lenses: keep the first result and merge both runs' findings and
`rereview.carry` after the retry. Follow the stricter `rereview`: worse `worst`, recommendation
`owner > delta > none`, tier `final > daily > light`.

Measured: a pass after a low-only pass found nothing medium or worse. There are at most 2 passes
per change:

- **`none`** → no new pass. Low findings are optional: fix now only those that take a few
  lines and are obviously correct. Put the rest in the PR as follow-ups or known limits.
  After pass 2 with a medium finding as the worst: fix it and verify with the tests and the
  diff, or document it as a known limit. Do not start a third pass.
- **`delta`** (only after pass 1) → fix, verify (build, tests, diff), and commit. Run the
  workflow with `base: '<reviewed commit>'`, `pass: 2`, and `tier: rereview.tier` (plus
  `effort: 'max'` for a large delta, see below). When `rereview.securityTier` is set, also pass
  `securityTier: rereview.securityTier`: it sets the security lens even when `tier` is given, so
  one call can run the other lenses on `light` and the security lens on `final`.
  Build `priorFindings` from `rereview.carry` (id, status, severity, title, file:line).
  For each, add what was done: fixed (how), still open (why), or left as a follow-up / known limit.
  After a non-final pass, medium and high/critical deltas use `light` (Terra at xhigh by default).
  After a `final` pass, medium deltas use `daily` and high/critical deltas use `final`.
  When the tier is `light` and the delta is more than about 50 changed lines or more than 3 files,
  or the fix changed the design, keep `light` and pass `effort: 'max'` (Terra at max). Do not move
  to `daily`. A full re-review (`base: 'main'`) is only for a large or design-changing fix.
  When Codex implemented the change, send the fix brief to its open implement session as a
  follow-up (`codex_send` / `send <runId>`), not as a new run (see `codex-implement`).
- **`owner`** → stop and report; do not ship with a high or critical finding open. After pass 2
  the owner decides about a third pass: it needs the owner's OK (`ownerApproved: true`).

New feature work added later, rather than fixes, is a new change. Review its own delta as pass 1.

## Rules

- Read-only: review runs never get `workspace-write`.
- Never stop Codex processes this plugin did not start. `cancel <runId>` only for runs you
  started, when the owner asks. A `supervisor_lost` run is reported, not killed.
- Failures are "no data", never a clean review: `timeout`, `abandoned`, `usage_limit`, `auth`,
  `schema` … → report the lens as not reviewed.
