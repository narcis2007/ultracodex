# ultracodex (plugin)

Codex (GPT-6 via `codex exec`) inside Claude Code.

- **Workflows**: `ultracodex:cross-review`, `ultracodex:codex-review`, `ultracodex:crosscheck`,
  `ultracodex:judge-panel` (`workflows/`).
- **Skills**: `codex-workflow` (Codex nodes in custom Workflow scripts), `codex-review`
  (adversarial review with triage), `codex-implement` (delegate to Codex in a worktree, verify).
- **Agent**: `codex-relay` — internal relay for Workflow nodes.
- **Runner**: `scripts/codex-node.mjs` — run `node scripts/codex-node.mjs help`.

Tier policy: `light` → gpt-6-luna@max · `daily` → gpt-6-sol (xhigh verify / max) ·
`final` → gpt-6-astra@max. See `skills/codex-workflow/references/model-policy.md`.

Requires the Codex CLI (logged in) and Node.js 18+. Check with
`node scripts/codex-node.mjs preflight --pretty`.

Fork of KingGyuSuh/ultracodex — Apache-2.0.
