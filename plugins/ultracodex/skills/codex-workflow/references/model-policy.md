# Model policy — GPT-6 astra / sol / luna

The runner (`scripts/codex-node.mjs`, `POLICY`) is the single source of truth; this page
explains it. Every request names a **tier** and a **kind**; the runner turns them into a model,
an effort and a deadline. Pin `model`/`effort` only to override, with a reason.

## The three tiers

| Tier | Model | Use it for | Effort |
| --- | --- | --- | --- |
| `light` | `gpt-6-luna` — "fast and affordable, for easier tasks" | light work: triage and dedupe of findings, wide fan-outs of small self-contained checks, mechanical edits (renames, boilerplate, docs, test scaffolding), summaries, smoke tests | **always `max`** |
| `daily` | `gpt-6-sol` — "workhorse for coding and everyday work" | day-to-day work: adversarial verification of findings, jurors, second opinions, one lens of a review, normal feature/fix implementation from a brief | `xhigh` for `verify` fan-outs, `max` for everything else |
| `final` | `gpt-6-astra` — "frontier intelligence for the most demanding work" | very advanced work and the **last word**: the final review gate before merge/deploy, a load-bearing single verdict, security / money / concurrency / data-migration code, hard debugging, architecture decisions, critical implementations | `max` |

Rules of thumb:

- **Cascade, astra last.** luna triages/filters → sol verifies/implements → astra judges what
  survived, or reviews the whole diff once at the end. Never put astra on a wide fan-out.
- **Escalate disagreements.** When Claude and sol disagree on a finding that matters, send that
  one item to astra (`tier: 'final'`) instead of re-running sol.
- **`ultra` is opt-in, once.** `effort: 'ultra'` (astra/sol only — luna has none; the runner
  refuses it) adds automatic sub-agent delegation and runs long. Use it for at most one decisive
  node per run.
- **Never leave a node unpinned to the CLI default.** The owner's `~/.codex/config.toml` defaults to
  astra@xhigh; the runner always passes model and effort explicitly, and hermetic runs ignore the
  user config anyway.

## kinds

| kind | Meaning | Default deadline base |
| --- | --- | --- |
| `verify` | refute/confirm a claim or finding, score a candidate | 25 min |
| `ask` | a second opinion, a candidate design, an analysis | 30 min |
| `review` | one lens of a code review (reads the diff and the code) | 45 min |
| `implement` | writes code in a worktree (`sandbox: workspace-write`) — skills only, never a workflow node | 90 min |

Deadline = base × model factor (luna 0.5, sol 1, astra 1.5) × effort factor (xhigh/max 1,
ultra 1.5). Examples: luna@max verify 12.5 min · sol@xhigh verify 25 min · sol@max review
45 min · astra@max review 67.5 min · astra@max implement 135 min. The deadline is a runaway
guard, not an estimate: measured on this machine, astra@max review lenses take 25–35 min and
implementations 30–60 min. Override with `timeoutSec` when a job legitimately needs more.

## Concurrency

- Per workflow: at most 4 Codex jobs in flight; an astra job counts as 2 (so ≤2 astra at once).
- Machine-wide (all Claude sessions): `ULTRACODEX_MAX_CONCURRENT` slots, default 4, same
  weights. Extra jobs wait in state `queued`.
- What throttles is several long, large-context, high-effort runs at once (RPM/TPM), not a
  wide fan-out of tiny checks. Keep each node's task small; let Codex read files itself (`cwd`).

## Speed tier

The catalog offers a "Fast" service tier (astra 2× speed with more usage consumed, sol/luna
1.5×). Pass `serviceTier: 'priority'` only for an urgent final gate; it is off by default.

## Checking the catalog

`node <runner> preflight` refreshes `~/.ultracodex/models.json` from `codex debug models` and
reports `missingPolicyModels` if a policy model disappeared (e.g. after a Codex update). The
runner rejects models that are not in the catalog and efforts a model does not list — before
spending a run. The GPT-5.6 tiers are still available as explicit `model` overrides; `gpt-5.5`
retires on 2026-10-14.
