# Codex headless — runner and CLI reference

Verified against `codex-cli 0.156.1` (Windows 11, Git Bash) on 2026-09-23. Confirm with
`codex exec --help` and the runner's `preflight` when behaviour differs.

## The runner (`scripts/codex-node.mjs`)

All Codex calls in this plugin go through the runner; nothing interpolates prompts into a
shell. Every command prints one JSON line tagged `{"ultracodex":1,...}`; exit codes: 0 done,
1 failed/rejected, 2 usage error, 3 still running.

| Command | Purpose |
| --- | --- |
| `start --request FILE\|-` | validate a JSON request, persist it, hand it to a detached supervisor; prints `runId` |
| `start --framed FILE\|-` | same, from a framed request (header line / schema / task) |
| `part INBOX K N` | relay upload: part K of N of an encoded frame on stdin; the last part starts the run |
| `wait RUN_ID [--max-wait SEC]` | poll up to 110 s (default); prints the final envelope or the running state; refreshes the heartbeat |
| `run --request FILE` | start + one wait |
| `status [RUN_ID] [--all]` · `result RUN_ID` | inspect runs (never refresh the heartbeat) |
| `cancel RUN_ID` | ask that run's supervisor to stop its own process tree |
| `preflight [--live]` | CLI, auth, catalog, policy models, home dir; `--live` = one tiny luna call |
| `dry-run --request FILE` | show the exact codex argv, model, effort, deadline — no model call |
| `policy` · `models` · `schema PRESET` · `schema-check --schema FILE` · `gc` | helpers |

Request fields (unknown fields are rejected): `task` or `taskFile`; `schema` / `schemaFile` /
`schemaPreset` (`verdict`, `score`, `review`, `implement`); `cwd`; `sandbox` (`read-only` default,
`workspace-write`); `tier` (`light`/`daily`/`final`); `kind` (`verify`/`ask`/`review`/`implement`);
`model`, `effort` (overrides); `hermetic` (default true); `network` (workspace-write only);
`timeoutSec`; `maxAttempts` (default 2); `attached` (default true — torn down when nobody polls
for `orphanAfterSec`, default 300); `ephemeral` (default: true except implement/resume);
`label`; `meta` (echoed back); `serviceTier` (`priority` = Fast); `addDirs`; `images`;
`profile`; `review: {base|commit|uncommitted, title}`; `resume: {sessionId}`.

Envelope: `ok: true` + `result` (schema) or `text`, and `provenance` {threadId, model, effort,
tier, mode, sandbox, hermetic, usage, durationMs, attempts, codexVersion, launcher, taskHash}.
Failures: `ok: false`, `state` (`failed`, `timeout`, `cancelled`, `abandoned`, `rejected`,
`lost`) and `error` {kind, retryable, message}.

Runs live in `~/.ultracodex/runs/<runId>/` (request, task, schema, state, per-attempt
`events.jsonl` / `stderr.log` / `last.txt`, `supervisor.log`, `result.json`). `gc` removes
finished runs after 7 days. `ULTRACODEX_HOME` moves the directory; `ULTRACODEX_CODEX_PATH`
points at a specific Codex binary; `ULTRACODEX_MAX_CONCURRENT` sets the machine-wide cap (0 =
unlimited).

### Why a supervisor

- The Bash tool's foreground timeout is 2 min by default (10 min max). A command that hits it is
  moved to the background; a command started by a foreground subagent is stopped when that
  subagent answers. Real Codex runs take 8–60+ minutes, so a relay must never block on `codex exec`.
- On Windows, the Codex process is a native `codex.exe` that Git Bash cannot signal or even see
  (`pgrep` and `ps -o` do not exist there). The supervisor spawns `codex.exe` directly (resolved
  behind the npm shim, with the same `CODEX_MANAGED_*` env the shim sets) and tears it down with
  `taskkill /T /F` on the PID it holds — on POSIX, via the process group. It only ever stops the
  tree it started.
- Detached, the run survives the relay's Bash call ending and even the relay dying; the
  heartbeat rule then cleans up attached runs.

## `codex exec` flags the runner uses

| Flag | Why |
| --- | --- |
| `-m <model>` · `-c model_reasoning_effort="<e>"` | always explicit (the user config defaults to astra@xhigh) |
| `-s read-only\|workspace-write` · `-C <cwd>` | exec only; `read-only` blocks writes, not reads |
| `--output-schema FILE` | strict JSON Schema for the final message |
| `-o FILE` | clean final message (stdout carries events/chrome) |
| `--json` | JSONL events → thread id, usage, structured errors |
| `--ephemeral` | no session files (verify/review) |
| `--ignore-user-config` (+ `-c windows.sandbox="…"`) | hermetic: no user MCP servers, profiles or defaults; the Windows sandbox setting is carried over |
| `-c sandbox_workspace_write.network_access=true` | implement with network |
| `--skip-git-repo-check` | exec/resume outside a repo |
| `-` | prompt from stdin (never as an argument) |

`codex exec review --base B | --commit SHA | --uncommitted [--title T]` reviews in the spawn cwd;
it takes no `-s`, `-C`, `-p`, `-i` or `--add-dir`. `codex exec resume <SESSION_ID>` takes `-m`,
`-o`, `--output-schema`, `--json`, `--ephemeral`, but **not** `-s` — the original sandbox stays.
Other 0.156 additions: `--worktree` (Codex-managed worktree), `-p <profile>` (layer
`$CODEX_HOME/<name>.config.toml`), `--ignore-rules`, `codex exec fork`.

## Hermetic by default

A normal `codex exec` loads every MCP server from `~/.codex/config.toml` — on this machine
eight of them, including production business APIs and a computer-use REPL. `-s read-only`
restricts shell commands, not MCP tools. Hermetic runs (`--ignore-user-config`) drop all of
them; measured: same result, clean stderr, ~1.8K fewer input tokens. Pass `hermetic: false`
only when a job genuinely needs the user's config.

## Model catalog (codex debug models)

| slug | efforts | note |
| --- | --- | --- |
| `gpt-6-astra` | low · medium · high · xhigh · max · ultra | frontier; Fast tier 2× |
| `gpt-6-sol` | low · medium · high · xhigh · max · ultra | workhorse |
| `gpt-6-luna` | low · medium · high · xhigh · max | easier tasks; `ultra` is silently accepted by the CLI — the runner refuses it |
| `gpt-5.6-sol/terra/luna` | as above | "older" |
| `gpt-5.5` | low…xhigh | retires 2026-10-14 |

Context window 272K (95% effective). Names must be fully qualified; an unknown model fails
with a 400 after the banner. Policy: `model-policy.md`.

## Error events (captured)

Codex reports API failures as `{"type":"error","message":"<json>"}` then
`{"type":"turn.failed","error":{"message":"<json>"}}`, where `<json>` is
`{"type":"error","status":400,"error":{"type":"invalid_request_error","code":…,"message":…,"param":…}}`.
Examples: `code: invalid_json_schema` (partial `required`), `code: unsupported_value` +
`param: reasoning.effort` (e.g. `minimal`), `model … is not supported when using Codex with a
ChatGPT account`. `item.completed` items of type `error` are warnings (e.g. unknown model
metadata), not failures. The runner classifies from these events; stderr is a fallback with
MCP OAuth refresh noise filtered out.

| kind | retried | meaning / fix |
| --- | --- | --- |
| `rate_limit` · `server` · `network` | yes, 20 s × attempt backoff | transient |
| `empty_output` | yes, once | clean exit, no final message |
| `timeout` | no | deadline hit; raise `timeoutSec` or shrink the task |
| `abandoned` · `cancelled` | no | nobody polled / cancel requested; tree stopped |
| `auth` | no | run `codex login` interactively |
| `usage_limit` | no | plan limit reached |
| `model` · `effort` | no | not in catalog / not supported — fix the request |
| `schema` | no | strict-mode violation (usually caught before the run) |
| `schema_mismatch` · `parse` | no | output did not match / was not JSON |
| `invalid_request` · `execution` · `spawn` | no | inspect `supervisor.log` and `attempt-*/stderr.log` |
| `relay_corruption` | helper retries once | relay altered the upload (hash mismatch) |
| `supervisor_lost` | no | supervisor died; Codex may still run — **not** stopped automatically, ask the owner |

## Windows/Git Bash traps (why the transport looks the way it does)

- The Bash tool halves backslash pairs in commands (`\\` → `\`) — never pass backslashes
  through a command; the relay payload is percent-encoded.
- Commands longer than ~7–8 KB break (`unexpected EOF while looking for matching '`): the
  Windows command-line limit. Payloads go in ≤2.4 KB parts.
- `pgrep`, `setsid` and `ps -o` do not exist; `/proc/<pid>/winpid` maps an MSYS PID to the
  Windows PID if you ever need it.
- `codex` in Git Bash is an sh shim → `node.exe` → native `codex.exe`; killing the shell or node
  leaves `codex.exe` running. Another reason the supervisor spawns `codex.exe` itself.
