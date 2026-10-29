# Model policy — GPT-6 astra / GPT-6.1 sol / GPT-6.1 terra (luna on request)

The runner (`scripts/codex-node.mjs`, `POLICY`) is the single source of truth; this page
explains it. Every request names a **tier** and a **kind**; the runner turns them into a model,
an effort and a deadline. Pin `model`/`effort` only to override, with a reason.

## The three tiers

| Tier | Model | Use it for | Effort |
| --- | --- | --- | --- |
| `light` | `gpt-6.1-terra` — the low-cost GPT-6.1 model ($1/$5 per MTok) | light work: a quick review or verification pass, triage and dedupe of findings, wide fan-outs of small self-contained checks, summaries, smoke tests | **`xhigh` for every kind** |
| `daily` | `gpt-6.1-sol` — "latest workhorse for coding and everyday work" | implementation including complex modules, debugging, architecture analysis, verification of findings, jurors, second opinions and routine review lenses | **`xhigh` for every kind** |
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

Routing rationale (2026-09-30): OpenAI reports that Sol 6.1 matches Astra on DeepSWE v1.1
at roughly one fifth of the API cost per task ([release](https://openai.com/index/introducing-gpt-6-1-sol/)).
Astra leads on SEC-Bench Pro (85.4% vs 78.8%) and ExploitGym (42.4% vs 35.1%)
([system card](https://deploymentsafety.openai.com/gpt-6-1-sol)). Use Sol for general coding,
including complex implementation, and reserve Astra for critical security work and critical review;
these benchmark results do not establish a universal winner for every coding task.

Rules of thumb:

- **Astra is for critical work only.** The owner's rule (2026-10-20): security-sensitive code
  (auth, keys, crypto, payments, personal data), data migrations, irreversible production steps
  and the last gate before a production release. Routine reviews and asks use Sol at `xhigh`,
  including the security lens.
- **Prefer `xhigh` on Sol 6.1.** Verification, analysis, review and implementation all use
  `xhigh`, including complex modules and long tasks. This is the owner's cost/quality
  preference (2026-10-01); an exact cost ratio is workload-dependent.
- **Sol `max` is exceptional and explicit.** Set `effort: 'max'` only when a concrete,
  consequential problem remains unresolved after an `xhigh` attempt and extra reasoning
  is justified, or when the owner requests it. State the reason and keep it to the decisive
  node; size, duration and complexity alone do not justify `max`. Critical security or
  final gates still use Astra at `max`. The light tier (Terra) stays at `xhigh`.
- **Luna is an explicit override only.** No tier selects `gpt-6-luna` any more. Use
  `model: 'gpt-6-luna', effort: 'max'` for mechanical, high-volume work where cost beats recall
  (renames, boilerplate, docs, test scaffolding, wide fan-outs of tiny checks). Luna has no
  `ultra`; it still defaults to `max` when you name it without an effort. Avoid it for
  review lenses or verification of findings: it found 2/12 known defects in the benchmark.
- **Cascade, astra last.** terra triages/filters → sol verifies/implements → astra judges what
  survived at high/critical severity, or reviews a critical change once at the end. Routine
  end-of-task reviews use Sol. Never put astra on a wide fan-out.
- **Complexity alone stays on Sol.** Risk determines the final reviewer, not automatically
  the implementer. An explicit owner-selected model or tier always overrides these defaults.
- **Review lenses default to Sol on pass 1 and to Terra on a fix-delta pass.** In `codex-review`,
  omit `tier` for `daily` on every lens of pass 1, including `security`, and for `light`
  (terra@xhigh) on every lens of a pass above 1. Why: from 2026-10-23 to 2026-10-29, 18 of 26 pass-2 reviews ran on
  Sol, and the 27.10 benchmark found terra@xhigh at least as good as sol@xhigh on replayed review
  lens jobs, at about a quarter of the cost. After a non-final pass, `rereview.tier` is `light` for
  medium and for high/critical findings; use `daily` for a delta of more than about 50 changed lines
  or more than 3 files, or when the fix changed the design. After a `final` pass it is `daily` for
  medium and `final` for high/critical. Optional `securityTier: 'light'|'daily'|'final'` changes only the
  security lens; invalid values are ignored. Use `securityTier: 'final'` for critical security
  work, or `tier: 'final'` for a critical gate across every lens. An explicit `tier` overrides
  `securityTier`. The result's top-level `tier` is the base tier; `lenses[].tier` and
  `lenses[].model` show actual routing. Findings already reviewed by Astra do not get another
  Astra tiebreak.
- **Escalate high/critical disagreements.** When Claude and sol disagree on such a finding,
  send it to astra (`tier: 'final'`) instead of re-running sol.
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
| Codex found it, Claude doubts it (high/critical) | one astra batch over just those (`codex-review` `escalate`) |
| a quick look at a small or mechanical change | `codex-review` with `tier: 'light'` (terra@xhigh, ~$0.12 and ~80 s per lens) |
| mechanical, high-volume work with no review value | explicit `model: 'gpt-6-luna', effort: 'max'` (cheapest; weak at finding defects) |
| a routine review with a security lens | omit `tier`: on pass 1, Sol at `xhigh` on every lens, including `security` |
| a fix-delta review (pass above 1) | omit `tier` or pass `rereview.tier`: Terra at `xhigh` on every lens (`daily` for a large or design-changing delta); when `rereview.securityTier` is set, pass it and leave `tier` out |
| critical security work needing Astra on security only | `codex-review` `securityTier: 'final'`, omit `tier` |
| a critical change or the last gate before a production release | `codex-review` `tier: 'final'` (astra per lens, ≤2 at a time) |

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

Deadline = base × model factor (luna 0.5, terra 1, sol 1, astra 1.5) × effort factor (xhigh/max 1,
ultra 1.5), and for a batch of N items × (1 + 0.25·(N−1)), at most ×4. Examples: luna@max verify 12.5 min · terra@xhigh verify 25 min · terra@xhigh review
45 min · sol@xhigh verify 25 min · sol@xhigh review 45 min · astra@max review 67.5 min · astra@max implement 135 min. The deadline is a runaway
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
spending a run. `gpt-6-sol` and the GPT-5.6 tiers are still available as explicit `model` overrides; `gpt-5.5`
retires on 2026-10-14.
