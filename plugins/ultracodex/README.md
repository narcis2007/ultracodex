# ultracodex (plugin)

Codex (GPT-6 via `codex exec`) inside Claude Code.

- **Workflows**: `ultracodex:cross-review`, `ultracodex:codex-review`, `ultracodex:crosscheck`,
  `ultracodex:judge-panel` (`workflows/`).
- **Skills**: `codex-ask` (one question or claim, straight to the runner — no relay),
  `codex-workflow` (modes, cost levers, Codex nodes in custom Workflow scripts), `codex-review`
  (adversarial review with triage), `codex-implement` (delegate to Codex in a worktree, verify),
  `codex-steer` (talk to a running Codex session: steer, follow up, answer its questions, close).
- **Agents**: `codex-relay` — internal relay for Workflow nodes; `codex-key` — internal, fetches
  the runner key and a nonce and announces requests for the helper; `codex-reader` — the
  confined type for Claude stages that read reviewed code (Read, Grep, Glob, read-only git).
- **Runner**: `scripts/codex-node.mjs` (the session driver is `scripts/session.mjs`) — run
  `node scripts/codex-node.mjs help`. A direct run with `"session": true` is a steerable session on a
  private `codex app-server`: `send` / `interrupt` / `answer` / `events --follow` / `close` (README: "Sessions"). Workflow nodes are
  steerable by default (one turn of such a session; README: "Steering a workflow node").
- **MCP server**: `scripts/mcp-server.mjs` (declared in `plugin.json`) — Codex sessions as native tools,
  `mcp__plugin_ultracodex_ultracodex__codex_start|sessions|send|interrupt|answer|events|wait|result|close`, and a
  channel (research preview; `claude --dangerously-load-development-channels plugin:ultracodex@ultracodex`) that
  pushes "Codex asks …" / "finished turn N". `notify` (`scripts/notify.mjs`) is the same watcher for the Monitor
  tool; `experimental.monitors` in `plugin.json` starts it for the codex skills (README: "Sessions").
- **Hook**: `hooks/hooks.json` → `scripts/relay-guard.mjs` — confines the job relay to the runner's
  `part`/`wait`/`page` commands, the key agent to `key`/`expect` and the reader to read-only
  git; other subagents only lose the runner's `key`/`expect` (the main conversation is untouched).
  A `SessionStart` hook (`scripts/session-start.mjs`) exports the session id as `ULTRACODEX_OWNER`, so each run
  records which Claude session started it.

Tier policy: `light` → gpt-6-luna@max · `daily` → gpt-6.1-sol@xhigh (all workloads) ·
`final` → gpt-6-astra@max. See `skills/codex-workflow/references/model-policy.md`.

Sol 6.1 implements complex code and handles routine reviews and asks by default. Astra is for
critical work only: security-sensitive code (auth, keys, crypto, payments, personal data), data
migrations, irreversible production steps and the last gate before a production release.
Use Sol at `max` only as an explicit override for an exceptional unresolved problem or
an owner request, with a stated reason. Task complexity or duration alone does not justify it.
`codex-review` without `tier` routes every lens, including `security`, to Sol at `xhigh`.
For critical work, use `securityTier: 'final'` for Astra on security only, or `tier: 'final'`
for every lens. `securityTier` accepts `light`, `daily` or `final`; invalid values are ignored.
An explicit tier overrides it; results name each lens's actual tier and model.

Requires the Codex CLI (logged in) and Node.js 18+. Check with
`node scripts/codex-node.mjs preflight --pretty`.

Jobs retain thread history by default. After a ChatGPT quota failure, the runner
waits — up to `limitWaitSec`, 24 hours by default — for the usage limit to reset
(read from a cost-free rate-limit probe) or for PrimerSwitch to select another
account, and resumes the saved thread under the same job id and permissions.
Waiting does not use up the job's deadline; cancellation works; existing Claude
relays keep polling. A run nobody polls any more keeps going (`onOrphan: "finish"`;
`cancel --orphaned` cleans up). Active tool commands finish normally. Native `codex exec` cannot reload accounts
mid-request. Explicit `ephemeral: true` opts out of history and continuation;
external API-key authentication and missing thread history cannot be recovered.
If cross-account resumption rejects encrypted reasoning, the runner continues
from visible messages and completed tool records in a fresh thread, leaving the
original rollout intact. This fallback runs once per handoff and keeps permissions.

Fork of KingGyuSuh/ultracodex — Apache-2.0.
