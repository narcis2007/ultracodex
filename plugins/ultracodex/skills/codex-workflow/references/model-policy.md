# Model policy — GPT-6 astra / GPT-6.2 sol / GPT-6.1 terra (luna and 6.1 sol on request)

The runner (`scripts/codex-node.mjs`, `POLICY`) is the single source of truth; this page
explains it. Every request names a **tier** and a **kind**; the runner turns them into a model,
an effort and a deadline. Pin `model`/`effort` only to override, with a reason.

## The three tiers

| Tier | Model | Use it for | Effort |
| --- | --- | --- | --- |
| `light` | `gpt-6.1-terra` — the low-cost GPT-6.1 model ($1/$5 per MTok) | code review lenses (`codex-review` pass 1 runs them at `max`), a quick review or verification pass, triage and dedupe of findings, wide fan-outs of small self-contained checks, summaries, smoke tests | **`xhigh` for every kind** (`codex-review` pass 1 passes `effort: 'max'`) |
| `daily` | `gpt-6.2-sol` — the workhorse for coding and everyday work (before 0.6.8: `gpt-6.1-sol`) | implementation including complex modules, debugging, architecture analysis, verification of findings, jurors, plan checks and second opinions | **`xhigh` for every kind** |
| `final` | `gpt-6-astra` — "frontier intelligence for the most demanding work" | critical security work, data migrations, irreversible production steps, the last gate before a production release, or high/critical issues escalated from Sol | `max` |

Light tier rationale (2026-10-27): the light tier moved from `gpt-6-luna@max` to `gpt-6.1-terra@xhigh`.
Benchmark: 10 past `codex-review` lens jobs replayed at the reviewed commit, 12 Claude-confirmed
medium-or-worse defects as ground truth, one run per config. Defects found: luna@max 2/12,
terra@xhigh 5/12, terra@max 10/12, sol@xhigh (reference) 4/12. API cost per run: luna $0.03,
terra@xhigh $0.12, terra@max $0.49, sol@xhigh $0.48. Median time: luna ~275 s, terra@xhigh ~79 s,
terra@max ~453 s. terra@xhigh found at least as much as luna on 8/8 comparable cases. The sample
is small and run-to-run noise is large. Terra at `max` costs as much as Sol, so the light tier uses
`xhigh`. OpenAI list price per MTok (input/output): terra $1/$5, sol $2/$10, luna $0.10/$0.50.
The live catalog lists `gpt-6.1-terra` with efforts low, medium, high, xhigh, max and ultra
(context 500000).

Daily tier rationale (2026-11-18, 0.6.8): the daily tier moved from `gpt-6.1-sol` to `gpt-6.2-sol`. Owner's benchmark
on 9 replayed review cases with 11 known medium-or-worse bugs: gpt-6.2-sol@xhigh found 9 of 11,
gpt-6.1-sol@xhigh 2 of 11, gpt-6.1-terra@max 9 of 11 at about 20 % lower cost. 6.2 Sol has the same list
price as 6.1 Sol. A 4-case probe found 6.2 Sol@max catching bugs that Terra@max missed, so the last
gate for critical work is one `codex-review` pass with `tier: 'daily', effort: 'max'` (6.2 Sol at `max`).
Review pass 1 stays on terra@max (unchanged), and astra stays opt-in. `gpt-6.1-sol` is no tier model
any more: named explicitly as `model`, it counts as a daily-tier model and defaults to `xhigh`.

Review rationale (2026-11-12): `codex-review` pass 1 moved from sol@xhigh (then 6.1) to terra@max on every lens.
On the replayed jobs above, terra@max found 10 of 12 must-find defects and sol@xhigh 4 of 12, at the
same cost per run. A pass after a low-only pass found nothing medium or worse (0 of 12). Codex usage is
scarce, and astra uses 5 to 7 times more of the weekly quota than sol. So: pass 1 = terra@max, a
fix-delta pass = terra@xhigh, at most 2 passes per change, and the astra tiebreak is opt-in
(`escalate: true`). The `light` tier default stays at `xhigh`; the workflow asks for `max` as an
explicit effort. Sol stays the model for plan checks, second opinions and implementation; only code
review moved to Terra.

Routing rationale (2026-09-30): OpenAI reports that Sol 6.1 matches Astra on DeepSWE v1.1
at roughly one fifth of the API cost per task ([release](https://openai.com/index/introducing-gpt-6-1-sol/)).
Astra leads on SEC-Bench Pro (85.4% vs 78.8%) and ExploitGym (42.4% vs 35.1%)
([system card](https://deploymentsafety.openai.com/gpt-6-1-sol)). Use Sol for general coding,
including complex implementation, and reserve Astra for critical security work and critical review;
these benchmark results do not establish a universal winner for every coding task.

Rules of thumb:

- **Astra is for critical work only.** The owner's rule (2026-10-20): security-sensitive code
  (auth, keys, crypto, payments, personal data), data migrations, irreversible production steps
  and the last gate before a production release. Routine asks use Sol at `xhigh`. Routine reviews
  use Terra (pass 1 at `max`), including the security lens.
- **Prefer `xhigh` on Sol 6.2.** Verification, analysis and implementation all use
  `xhigh`, including complex modules and long tasks. Code review runs on Terra. This is the owner's cost/quality
  preference (2026-10-01); an exact cost ratio is workload-dependent.
- **Sol `max` is exceptional and explicit.** Set `effort: 'max'` only when a concrete,
  consequential problem remains unresolved after an `xhigh` attempt and extra reasoning
  is justified, or when the owner requests it. State the reason and keep it to the decisive
  node; size, duration and complexity alone do not justify `max`. One decided exception: the last gate
  for critical work is one `codex-review` pass with `tier: 'daily', effort: 'max'` (6.2 Sol at `max`),
  only when really necessary and with the owner's OK. Astra at `max` stays opt-in for critical security work. The light tier (Terra) defaults to `xhigh`; `codex-review`
  pass 1 asks for Terra at `max` itself.
- **`gpt-6.1-sol` is an explicit override only.** No tier selects it since 0.6.8. Named as `model`, it
  counts as a daily-tier model and defaults to `xhigh` (deadline factor 1, `ultra` accepted).
- **Luna is an explicit override only.** No tier selects `gpt-6-luna` any more. Use
  `model: 'gpt-6-luna', effort: 'max'` for mechanical, high-volume work where cost beats recall
  (renames, boilerplate, docs, test scaffolding, wide fan-outs of tiny checks). Luna has no
  `ultra`; it still defaults to `max` when you name it without an effort. Avoid it for
  review lenses or verification of findings: it found 2/12 known defects in the benchmark.
- **Cascade, astra last.** terra triages/filters → sol verifies/implements → astra judges what
  survived at high/critical severity, or reviews a critical change once at the end. Routine
  end-of-task reviews use Terra at `max`. Never put astra on a wide fan-out.
- **Complexity alone stays on Sol.** Risk determines the final reviewer, not automatically
  the implementer. An explicit owner-selected model or tier always overrides these defaults.
- **Review lenses default to Terra at `max` on pass 1 and to Terra at `xhigh` on a fix-delta pass.**
  In `codex-review`, omit `tier` for `light` at effort `max` on every lens of pass 1, including
  `security`, and for `light` at its default effort (xhigh) on every lens of a pass above 1. An
  explicit `tier` keeps its own default effort: `light` is terra@xhigh (a quick pass), `daily` is
  sol@xhigh (6.2), `final` is astra@max. Optional `effort` (`low|medium|high|xhigh|max`) sets the effort of
  every lens that is not on `final`; it never changes Astra. Why: see the review rationale above. At
  most 2 passes per change; a pass above 2 needs `ownerApproved: true`. After pass 1 with a medium or
  high/critical finding, the delta pass uses `rereview.tier`: `light` after a non-final pass (add
  `effort: 'max'`, tier stays `light`, for a delta of more than about 50 changed lines or more than 3
  files, or when the fix changed the design), `daily` for medium and `final` for high/critical after a
  `final` pass. After pass 2 a medium finding ends the passes (fix and verify, or document it) and a
  high/critical one goes to the owner.
  Optional `securityTier: 'light'|'daily'|'final'` always sets the security lens, also when `tier` is
  given, with that tier's own default effort; `tier` sets every other lens. Invalid values are ignored.
  Use `securityTier: 'final'` for critical security work, or `tier: 'final'` for a critical gate across
  every lens. Pass the same `securityTier` on every pass of a change; `rereview.securityTier` echoes
  it. When the owner names one tier for every lens, do not pass `securityTier`. The result's top-level
  `tier` and `effort` are the base ones; `lenses[].tier`, `lenses[].model` and `lenses[].effort` show
  actual routing. Findings already reviewed by Astra do not get another Astra tiebreak.
- **Escalate high/critical disagreements only on request.** When Claude and a Codex reviewer disagree on
  such a finding, `codex-review` can send it to astra in one run (`escalate: true`, off by default:
  astra costs much more quota). A doubted high/critical finding that no tiebreak gave a verdict on is
  listed as "not cross-checked" (`notCrossChecked`, with a `reason`): all of them without `escalate`, and
  with it the ones from an astra lens and the ones whose tiebreak failed. The caller checks them in the
  code; for the ones the tiebreak skipped or failed on, the owner can also ask for an astra run. Do not re-run the lens instead.
- **`ultra` is opt-in, once.** `effort: 'ultra'` (astra/sol/terra — luna has none; the runner
  refuses it) adds automatic sub-agent delegation and runs long. Use it for at most one decisive
  node per run.
- **Never leave a node unpinned to the CLI default.** The owner's `~/.codex/config.toml` defaults to
  astra@xhigh; the runner always passes model and effort explicitly, and hermetic runs ignore the
  user config anyway.

## Cost playbook — maximum signal per token

| situation | cheapest setup that still works |
| --- | --- |
| one question / one claim, from the conversation | direct runner call (`codex-ask`), no relay; tier by role and risk |
| N findings to verify | one batch run (`codexBatchNode`), sol@xhigh; never N astra runs |
| findings that would block a merge | the batch above, then **one** astra@max batch over the confirmed high/critical ones (`cross-review` `finalGate`) |
| Codex found it, Claude doubts it (high/critical) | listed as "not cross-checked" by default; with the owner's OK, one astra batch over just those (`codex-review` `escalate: true`) |
| a small, low-risk change (about 50 lines or fewer in at most 3 files, or mechanical, no money, auth, permissions, personal data, migrations or external effects) | no Codex review: verify the diff and the tests; if the owner asks, `codex-review` with `tier: 'light'` (terra@xhigh, ~$0.12 and ~80 s per lens) |
| mechanical, high-volume work with no review value | explicit `model: 'gpt-6-luna', effort: 'max'` (cheapest; weak at finding defects) |
| a normal review (code + domain), with a security lens when the change needs one | omit `tier`: on pass 1, Terra at `max` on every lens, including `security` (~$0.49 and ~7.5 min per lens) |
| a fix-delta review (pass 2, the last pass) | omit `tier` or pass `rereview.tier`: Terra at `xhigh` on every lens (Terra at `max`, `effort: 'max'`, for a large or design-changing delta); when `rereview.securityTier` is set, pass it again |
| critical security work needing Astra on security only | `codex-review` `securityTier: 'final'`, omit `tier` (or add `tier` for the other lenses) |
| the last gate for critical work (owner's rule, only when really necessary and with the owner's OK) | `codex-review` `tier: 'daily', effort: 'max'` (6.2 Sol at `max` on every lens, one pass; no `securityTier`) |
| a critical change or the last gate before a production release, when the owner asks for astra | `codex-review` `tier: 'final'` (astra per lens, ≤2 at a time) |

When astra disagrees with sol or Claude, the item is **disputed**: report both reasonings and
let the owner decide — do not re-run until the answer you want appears. Every shipped workflow
returns `codexUsage` (runs, failed runs and tokens per model); use it to see what a run cost.

## kinds

| kind | Meaning | Default deadline base |
| --- | --- | --- |
| `verify` | refute/confirm a claim or finding, score a candidate | 25 min |
| `ask` | a second opinion, a candidate design, an analysis | 30 min |
| `review` | one lens of a code review (reads the diff and the code) | 45 min |
| `implement` | writes code in a worktree (`sandbox: workspace-write`) — skills only, never a workflow node | 90 min |

Deadline = base × model factor (luna 0.5, terra 1, sol (6.1 and 6.2) 1, astra 1.5) × effort factor (xhigh/max 1,
ultra 1.5), and for a batch of N items × (1 + 0.25·(N−1)), at most ×4. Examples: luna@max verify 12.5 min · terra@xhigh verify 25 min · terra@xhigh review
45 min · terra@max review 45 min (same as xhigh; the `codex-review` pass-1 default) · sol@xhigh verify 25 min · sol@xhigh review 45 min · astra@max review 67.5 min · astra@max implement 135 min. The deadline is a runaway
guard, not an estimate: measured on this machine, terra@xhigh review lenses take about 80 s
(median; terra@max ~7.5 min), astra@max review lenses 25–35 min and implementations 30–60 min. Override with `timeoutSec` when a job legitimately needs more.

## Concurrency

- Per workflow: at most 4 Codex jobs in flight; an astra job counts as 2 (so ≤2 astra at once).
- Machine-wide (all Claude sessions): `ULTRACODEX_MAX_CONCURRENT` slots, default 4, same
  weights. Extra jobs wait in state `queued`.
- What throttles is several long, large-context, high-effort runs at once (RPM/TPM), not a
  wide fan-out of tiny checks. Keep each node's task small; let Codex read files itself (`cwd`).

## Speed tier

The catalog offers a "Fast" service tier (astra 2× speed with more usage consumed, sol/luna
1.5×). Pass `serviceTier: 'priority'` (a request field, or a `codexNode` option) only for an
urgent final gate; it is off by default. The shipped workflows take `fast: true`, which puts
only their astra nodes on it.

## Checking the catalog

`node <runner> preflight` refreshes `~/.ultracodex/models.json` from `codex debug models` and
reports `missingPolicyModels` if a policy model disappeared (e.g. after a Codex update). The
runner rejects models that are not in the catalog and efforts a model does not list — before
spending a run. `gpt-6.1-sol`, `gpt-6-sol` and the GPT-5.6 tiers are still available as explicit `model` overrides; `gpt-5.5`
retires on 2026-10-14.
