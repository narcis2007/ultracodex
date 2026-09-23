---
name: codex-implement
description: >-
  Delegate an implementation task to Codex (GPT-6) running in an isolated git worktree,
  then verify its work in Claude (build, tests, diff, claimed-vs-real) before anything is
  merged — optionally followed by a Codex or cross-model review and Codex follow-up fixes in
  the same session. Use when the user asks to have Codex implement / build / fix / refactor /
  migrate something, "give this to codex", "let codex write it", "use codex as the
  implementer or subagent", or any implement-then-review combination. Tiers: gpt-6-sol@max by
  default, gpt-6-astra@max for hard or critical modules, gpt-6-luna@max for mechanical changes.
---

# Delegate implementation to Codex

Runner: `${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs` · brief template: `references/brief-template.md` ·
tier policy: `${CLAUDE_PLUGIN_ROOT}/skills/codex-workflow/references/model-policy.md`

Codex writes the draft; **Claude owns the result**. Nothing Codex reports counts until you
have checked it yourself, and nothing is merged without the owner's OK.

## 1. Preflight and tier

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" preflight
```

- `daily` → gpt-6-sol@max: normal features, fixes, refactors from a clear brief;
- `final` → gpt-6-astra@max: hard or critical code (concurrency, money, security, migrations,
  cross-module designs) — the expensive, slow, strongest option;
- `light` → gpt-6-luna@max: mechanical work (renames, boilerplate, docs, test scaffolding).

## 2. Isolate — a worktree outside the repo

```bash
git -C "<repo>" worktree add "<repo>/../<repo-name>.codex-<slug>" -b codex/<slug> <base-branch>
```

A sibling directory, never inside the repo (tools that walk up the tree, like dotenv, would
pick up the owner's `.env`) and never the owner's own working tree. One worktree per run; with
Rust, give it its own `CARGO_TARGET_DIR` in the brief.

## 3. Write the brief (Write tool, never a heredoc)

Fill `references/brief-template.md`: goal, context, scope and non-goals, the house rules
(point at AGENTS.md/CLAUDE.md), acceptance criteria, the **exact** verification commands (with
resource limits for this machine: e.g. `cargo … -j 1`, one test binary at a time), and git
rules (Codex does not commit or push unless the brief says otherwise). Save it next to the
request, e.g. in the session scratchpad.

## 4. Start it

Request file (Write tool):

```json
{
  "taskFile": "<abs path of the brief>",
  "cwd": "<abs path of the worktree>",
  "sandbox": "workspace-write",
  "network": true,
  "kind": "implement",
  "tier": "daily",
  "schemaPreset": "implement",
  "attached": false,
  "label": "implement:<slug>"
}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" start --request "<request.json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" wait <runId> --max-wait 9000   # run_in_background: true
```

`attached: false` lets the run continue while you do other work; the deadline (sol@max ≈ 90 min,
astra@max ≈ 135 min) still applies. The background `wait` notifies you when it finishes;
`status <runId>` shows progress at any time. Keep at most one or two implementation runs at once
on this machine, and do not run heavy builds in parallel with them.

## 5. Verify — trust nothing unverified

1. Read the `implement` report (status, tasks, files, commands, tests, open questions, risks).
2. `git -C <worktree> status` and `git -C <worktree> diff` — read the actual change.
3. Run the verification commands yourself. "Tests passed" in the report is a claim, not evidence.
4. Check every task marked `done` against the diff; list anything missing or partial.
5. If the run ended in `timeout`, `abandoned`, `cancelled` or `usage_limit`, the tree may hold a
   half-written change: inspect it before building on it.

## 6. Iterate or review (combinations)

- **Follow-up in the same Codex session** (keeps its context; the sandbox stays the original):
  `{ "resume": { "sessionId": "<provenance.threadId>" }, "taskFile": "<fix brief>", "cwd": "<worktree>", "kind": "implement", "tier": "daily", "schemaPreset": "implement", "attached": false }`
- **Adversarial review of the result**: the `codex-review` skill (or the
  `ultracodex:codex-review` workflow) on the worktree branch — typically on a *different* tier
  than the implementer (sol implements → astra reviews at the end), or
  `ultracodex:cross-review` so Claude finds and Codex verifies.
- Fix confirmed findings (yourself or via a resume brief), then re-verify.

## 7. Hand over

Summarize what was built, what you verified and how, the open items, and where the branch is.
**Do not merge or push to shared branches without the owner's explicit OK** — they review
locally first.

## Rules

- Never stop Codex processes this plugin did not start (the owner runs parallel Codex
  sessions). `cancel <runId>` only for your own run and only when the owner asks. A
  `supervisor_lost` run is reported with its PID, never killed.
- Hermetic by default (the owner's MCP servers are not loaded). Pass `"hermetic": false` only if
  the task truly needs the user's Codex config.
- A strict schema is required for structured reports; the `implement` preset already is.
