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

Tier policy: `light` → gpt-6.1-terra@xhigh · `daily` → gpt-6.2-sol@xhigh (all workloads) ·
`final` → gpt-6-astra@max. `gpt-6-luna` is an explicit `model` override only (default effort `max`); so is
`gpt-6.1-sol` (a daily-tier model at `xhigh`).
See `skills/codex-workflow/references/model-policy.md`.

Sol 6.2 implements complex code and handles plan checks and asks by default; code review runs on
Terra. Astra is for critical work only: security-sensitive code (auth, keys, crypto, payments, personal data), data
migrations, irreversible production steps and the last gate before a production release.
Use Sol at `max` only as an explicit override for an exceptional unresolved problem or
an owner request, with a stated reason. Task complexity or duration alone does not justify it.
The last gate for critical work is one `codex-review` pass with `tier: 'daily', effort: 'max'` (6.2 Sol at `max`).
`codex-review` without `tier` routes every lens of pass 1, including `security`, to Terra at `max`,
and every lens of a fix-delta pass (pass above 1) to Terra at `xhigh` (`light`). At most 2 passes
per change (`ownerApproved: true` for more). An explicit `tier` keeps its own default effort; optional
`effort` sets the effort of every lens that is not on `final`. The astra tiebreak is opt-in
(`escalate: true`); without it, high/critical findings that Claude doubted are listed as "not
cross-checked".
For critical work, use `securityTier: 'final'` for Astra on security only, or `tier: 'final'`
for every lens. `securityTier` accepts `light`, `daily` or `final`; invalid values are ignored.
An explicit `securityTier` always sets the security lens, also when `tier` is given; `tier` sets every
other lens. Results name each lens's actual tier and model.

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

## Where worktrees go

`codex-implement` uses `node scripts/codex-node.mjs worktree add --repo "<repo>" --slug "<slug>"`.
Use `worktree path` with the same location flags, without `--base` or `--branch`, to preview the
JSON `path`, `source`, `root`, `repo`, `volume` and `hints`.
`add` accepts `--base` (main checkout's `HEAD` by default) and `--branch`
(`codex/<slug>` by default).

`--dir` sets the exact path; `--root` sets a container. They are mutually exclusive. Otherwise,
`git config ultracodex.worktreeRoot "<family>/wt"` wins over `ULTRACODEX_WORKTREE_ROOT`, the
machine-wide fallback. Relative config roots resolve from the main checkout; `~` expands to
home. Auto-detection then checks the main checkout's parent and grandparent for `wt`, then
`.worktrees`. It skips containers inside Git working trees and levels at or above home or the
filesystem root. Disable it with `git config ultracodex.worktreeAuto false` or
`ULTRACODEX_WORKTREE_AUTO=0`. With no match, the runner uses a sibling `<repo-name>.codex-<slug>`.

On Windows, set an existing Dev Drive container such as `D:\wt` to keep worktree I/O there.
The runner reports the filesystem and suggests available ReFS paths. ReFS alone does not prove
a Dev Drive. The probe is advisory; `--no-volume-check` skips it. Config hints use PowerShell
syntax with forward slashes and target the main checkout. `volume.mountPath` reports the mount
path used to reach the destination.
Observed with Docker Desktop on Windows: bind mounts from a folder-mounted volume fail.
If this task's Docker tests bind-mount files from the worktree, put the worktree on a
drive-letter path for this task (`--dir` / `--root`).
Bare-backed repos, separate git dirs and submodules are not supported yet.
A failed post-checkout hook can return `ok: false, created: true`; inspect the retained worktree.

Fork of KingGyuSuh/ultracodex — Apache-2.0.
