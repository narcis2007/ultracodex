# ultracodex (plugin)

Codex (GPT-6 via `codex exec`) inside Claude Code.

- **Workflows**: `ultracodex:cross-review`, `ultracodex:codex-review`, `ultracodex:crosscheck`,
  `ultracodex:judge-panel` (`workflows/`).
- **Skills**: `codex-ask` (one question or claim, straight to the runner — no relay),
  `codex-workflow` (modes, cost levers, Codex nodes in custom Workflow scripts), `codex-review`
  (adversarial review with triage), `codex-implement` (delegate to Codex in a worktree, verify).
- **Agents**: `codex-relay` — internal relay for Workflow nodes; `codex-key` — internal, fetches
  the runner key and a nonce and announces requests for the helper; `codex-reader` — the
  confined type for Claude stages that read reviewed code (Read, Grep, Glob, read-only git).
- **Runner**: `scripts/codex-node.mjs` — run `node scripts/codex-node.mjs help`.
- **Hook**: `hooks/hooks.json` → `scripts/relay-guard.mjs` — confines the job relay to the runner's
  `part`/`wait`/`page` commands, the key agent to `key`/`expect` and the reader to read-only
  git; other subagents only lose the runner's `key`/`expect` (the main conversation is untouched).

Tier policy: `light` → gpt-6-luna@max · `daily` → gpt-6-sol (xhigh verify / max) ·
`final` → gpt-6-astra@max. See `skills/codex-workflow/references/model-policy.md`.

Requires the Codex CLI (logged in) and Node.js 18+. Check with
`node scripts/codex-node.mjs preflight --pretty`.

Fork of KingGyuSuh/ultracodex — Apache-2.0.
