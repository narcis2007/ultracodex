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
| `part new 1 N HASH` · `part UPLOAD K N HASH` | relay upload: part 1 opens an upload (the runner allocates its id), parts 2..N go to it; a part whose hash differs is refused (`part_rejected`); the last part starts the run |
| `wait RUN_ID [--max-wait SEC]` | poll up to 110 s (default); prints the final envelope or the running state; refreshes the heartbeat |
| `run --request FILE` | start + one wait |
| `status [RUN_ID] [--all]` · `result RUN_ID` | inspect runs (never refresh the heartbeat) |
| `page RUN_ID K` | slice K of a large result (see "Paged results") |
| `key` | the per-machine key, a fresh nonce and their `keyCheck` — for the Workflow helper's key agent only |
| `expect DIGEST` | announce one relayed request by its 64-hex digest before it is uploaded — for the key agent only (see "Signed requests and results") |
| `cancel RUN_ID` | ask that run's supervisor to stop its own process tree |
| `preflight [--live]` | CLI, auth, catalog, policy models, home dir; `--live` = one tiny luna call |
| `dry-run --request FILE` | show the exact codex argv, model, effort, deadline — no model call |
| `policy` · `models` · `schema PRESET` · `schema-check --schema FILE` · `gc` | helpers |

Request fields (unknown fields are rejected): `task` or `taskFile`; `schema` / `schemaFile` /
`schemaPreset` (`verdict`, `score`, `review`, `implement`); `cwd`; `sandbox` (`read-only` default,
`workspace-write`); `tier` (`light`/`daily`/`final`); `kind` (`verify`/`ask`/`review`/`implement`);
`model`, `effort` (overrides); `hermetic` (default true); `network` (workspace-write only);
`timeoutSec` (default from the policy; scaled ×(1 + 0.25·(N−1)), at most ×4, by `workItems: N`
for a batch); `maxAttempts` (default 2 for read-only work, **1 for writing tasks** — workspace-write
or resume — which may only retry with `replaySafe: true`, since a replay could apply effects
twice); `attached` (default true — torn down when nobody polls
for `orphanAfterSec`, default 300; the Workflow helper sends 900); `ephemeral` (default: true except implement/resume);
`label`; `meta` (echoed back); `serviceTier` (`priority` = Fast); `addDirs`; `images`;
`profile`; `review: {base|commit|uncommitted, title}`; `resume: {sessionId}`.

Envelope: `ok: true` + `result` (schema) or `text` — never both —, `resultHash` (FNV-1a of the
body, so a relay's transcription can be verified), `mac` (see "Signed requests and results"),
and `provenance` {threadId, model, effort, tier, mode, sandbox, hermetic, usage (last attempt),
usageTotal (all attempts), durationMs, attempts, codexVersion, launcher, taskHash, teardown,
slotLost}. Failures: `ok: false`, `state` (`failed`, `timeout`, `cancelled`, `abandoned`,
`rejected`, `lost`) and `error` {kind, retryable, message}.

### Signed requests and results

A per-machine secret, `~/.ultracodex/key` (created once, published atomically), is fetched
once per workflow — with a fresh nonce — by the helper's **key agent**, a separate agent type
whose prompt carries no task text. With it the helper:

- **signs every request it builds**: the frame header carries `nonce` (`<workflow nonce>.<n>`)
  and `rmac` = HMAC(key, `ucx-request` \n requestDigest), requestDigest being the SHA-256 of
  the exact signed header (model, effort, tier, cwd, schema preset, label, nonce, …), the
  schema and the task. The runner starts a relayed (`part`, `start --framed`) job only with a
  valid `rmac` (`unauthenticated_request` otherwise). A relay hijacked by reviewed content
  therefore cannot start a job of its own — say, one asking Codex to read the key and sign a
  forgery — nor swap the schema, model or directory of a real one. Each nonce starts one run:
  a second upload of the same signed request joins the first run;
- **announces every request before a relay sees it**: through the same key agent, whose
  prompt is just `ULTRACODEX EXPECT` and the digest, the helper runs `expect <requestDigest>`.
  The runner starts a relayed job only for an announced digest (`unregistered_request`
  otherwise), consumes the announcement when the run starts, and forgets unused ones after a
  day; nonce records are kept 7 days, so a replay finds its nonce's run or no announcement.
  The key alone therefore starts nothing: a Codex job can read it (read-only still reads the
  whole disk) and so can a reader agent's Read tool, but neither can announce — only the key
  agent may run `expect`, and a read-only sandbox cannot write the registry;
- **verifies every result**: `mac` = HMAC(key, `ucx-result` \n runId \n requestDigest \n kind
  \n body), kind being `result` or `text`. A result is thereby bound to the one request the
  helper made (an older run of the same task, from another workflow, does not pass) and to
  the payload type it returns (`unauthenticated_result` otherwise).

Requests from the conversation (`start --request`) are trusted as they are and signed over
`ucx-direct` \n task, which never matches a relayed request.

### Paged results

The Bash tool shows a model only a short preview of output over ~30 000 characters. Above
24 000, `wait`/`result` print a compact envelope — no `result`/`text`, plus
`paged: {pages, chars, enc: "pct", hashes, file}` — and `page RUN_ID K` prints slice K
(10 000 characters) of the page data: the body JSON percent-encoded like an upload, plus `"`
as `%22`, so a page line contains no quote and no backslash and its JSON needs no escaping.
(Measured on the doubly escaped form: Sonnet dropped characters from a 32 KB result twice in a
row.) Each page has its own hash, so the helper keeps the good pages of every reply and a
re-collect only has to bring the rest; `resultHash` and `mac` still cover the whole decoded
body. From the main conversation, simply read `paged.file` with the Read tool.

Runs live in `~/.ultracodex/runs/<runId>/` (request, task, schema, state, per-attempt
`events.jsonl` / `stderr.log` / `last.txt`, `supervisor.log`, `result.json`). `gc` removes
finished runs after 7 days. `ULTRACODEX_HOME` moves the directory; `ULTRACODEX_CODEX_PATH`
points at a specific Codex binary; `ULTRACODEX_MAX_CONCURRENT` sets the machine-wide cap (0 =
unlimited).

Relayed requests (`part`, `start --framed`) are read-only and hermetic by construction: the
runner refuses `workspace-write`, `hermetic: false`, `network`, `resume`, `taskFile`, `schemaFile`,
`addDirs`, `images` and `profile` from a relay, even with valid hashes. Suspend-aware: after a
sleep the supervisor extends the deadline by the time asleep and pauses abandonment for one
`orphanAfterSec`; `wait` declares `lost` only after watching the supervisor stay silent.

### The guard (plugin hook)

`hooks/hooks.json` registers `scripts/relay-guard.mjs` as a PreToolUse hook on Bash. It
judges a command by the agent type that runs it (hook input `agent_type`) — the type the
helper chose, never what the model asks for — and leaves the main conversation alone:

| Agent type | May run through Bash | Otherwise |
| --- | --- | --- |
| `ultracodex:codex-relay` — job relay | `node "<plugin>/scripts/codex-node.mjs" part (new\|ucx-…) K N HASH <<'UCX_P…' … UCX_P…` with a quote- and backslash-free body, `… wait <runId>`, `… page <runId> <k>` | denied, other tools too |
| `ultracodex:codex-key` — key agent | `… key`, `… expect <64 hex>` | denied, other tools too |
| `ultracodex:codex-reader` — Claude stages that read reviewed code | one read-only git command: `git [-C <repository root>] diff\|log\|show\|status\|blame\|ls-files\|ls-tree\|grep\|rev-parse\|merge-base\|cat-file\|describe\|shortlog\|diff-tree\|rev-list\|name-rev …` — no shell metacharacters or unquoted globs, no global options, no `--output`/`--ext-diff`/`--no-index`/`--contents`/`--open-files-in-pager`/`--exec` nor any abbreviation of them, no `-O` even bundled, no network paths, nothing under the ultracodex home; `-C` without `..`, and — with or without `-C` — only where git's upward discovery, walked as written and with links resolved, reaches a `.git` before a bare-looking directory (Read, Grep, Glob stay available) | denied |
| any other subagent | whatever its permissions allow, except the runner's `key` and `expect` | no opinion |

The allowed commands of the three confined types run without a permission prompt. A relay
prompt-injected by reviewed content therefore cannot run other commands, pick another
executable, compute hashes, read the key or announce a request; a reader can run nothing but
read-only git, so whatever the reviewed code tells it, it can neither sign nor announce.
Each reader rule closes a way, measured on git 2.55, to make "read-only" git run a program as
the owner: `git grep -nO<cmd>` and `git grep --open-files=<cmd>` start `<cmd>` as a pager, and
git run inside an embedded bare repository — `HEAD`, `objects/`, `refs/` and `config` are
ordinary files a repository can contain — loads that `config`, whose `core.fsmonitor` is a
program. A tree checked out by git never contains a `.git` of its own, so the guard mirrors
git's discovery and requires it to reach a real `.git` first. git walks up the physical path —
measured on Windows through a junction into a bare repository's `refs/` — so the walk is done
with links resolved too, and `..` is refused in `-C` (the kernel follows `hop` in `hop/..`
before it goes up; a text normalisation would not).

Residual risks: with hooks disabled (`disableAllHooks`) the confined agents keep their plain
tools. The guard sees Bash only, so a reader can still Read `~/.ultracodex/key` — which no
longer suffices for anything: a job needs an announcement only the key agent can make, and a
result MAC needs an HMAC computed, which no confined agent can do. The protection covers the
plugin's confined agent types, not an unconfined agent the owner lets run arbitrary Bash or
Write on this machine: such an agent could read the key, write an announcement or plant a run
file. Give custom stages that read reviewed code `agentType: UCX_READER`, and keep other
workflow agents on normal permission prompts when they read untrusted repositories. (Codex
jobs can read the key too, but cannot write the home, and each job's answer is bound to its
own request.) The reader's git uses the repository's own configuration: review a repository
you cloned, not an unpacked archive that ships its own `.git` directory — git would load
that `config` for any command, the owner's own included.

The runner never resolves executables through the current directory: PowerShell is called by
its System32 path, and no process of the runner works in the reviewed repository or in the
home (a supervisor works in Node's own directory). There is no command-line option to replace
the Codex binary (only the operator's `ULTRACODEX_CODEX_PATH`).

### Why a supervisor

- The Bash tool's foreground timeout is 2 min by default (10 min max). A command that hits it is
  moved to the background; a command started by a foreground subagent is stopped when that
  subagent answers. Real Codex runs take 8–60+ minutes, so a relay must never block on `codex exec`.
- On Windows, the Codex process is a native `codex.exe` that Git Bash cannot signal or even see
  (`pgrep` and `ps -o` do not exist there). The supervisor spawns `codex.exe` directly (resolved
  behind the npm shim, with the same `CODEX_MANAGED_*` env the shim sets). Before that, a small
  PowerShell helper puts the supervisor into a fresh **Job Object**, so every process of the run
  is born into the job — including ones whose parent has exited, which no PID bookkeeping could
  attribute. Stopping terminates exactly the job's members, each through a handle checked to
  belong to the job (a PID can be reused, a membership cannot), and sweeps again (up to 8
  rounds) until a round finds no member left: a process spawned during the sweep is not
  missed. Without a job (`preflight`
  reports `windowsJob`; `ULTRACODEX_NO_JOB=1` forces it) an identity-checked fallback kills
  only through handles pinned before their PID + creation time was verified (creation times
  are FILETIMEs, compared exactly as 64-bit integers — they exceed a double's precision),
  attributes children only through pinned parents (live snapshots every 20 s), and reports
  what it cannot prove as `possibleLeftovers` — never killing them. `taskkill /T`, which follows the parent
  PIDs of orphans and so can reach processes of other sessions, is never used. On POSIX: the
  child's process group, SIGTERM then SIGKILL. Only the run's own tree is ever stopped;
  survivors are reported.
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
| `upload_busy` | no | another caller is assembling that upload (rare; a scanner lock is retried first) |
| `unauthenticated_result` · `key_unavailable` | helper re-collects once / retryable | result not signed by this runner for this request / the key agent could not fetch the key — never trusted |
| `unauthenticated_request` | no | a relayed frame without the helper's valid signature (a relay composing its own job) |
| `unregistered_request` | no | a signed frame the helper never announced (or announced over a day ago): a replay, or a job composed by someone holding the key |
| `register_failed` | no | the helper's key agent could not announce the request; nothing was uploaded |
| `key_invalid` | no | `~/.ultracodex/key` exists but is not a key (an interrupted older runner): delete it and a new one is made — never replaced automatically |
| `nonce_reused` | no | a signed request was uploaded again while its first upload was still being registered |
| `result_too_large` | no | over 400 pages (4 MB): read the run's `result.json` from the conversation instead |
| `helper_error` | no | an unexpected error inside the helper — reported as a failed node, never a crash |
| `supervisor_lost` | no | supervisor died; Codex may still run — **not** stopped automatically, ask the owner |

## Headless (`claude -p`) sessions

`claude -p` waits for background tasks — a running Workflow included — for at most 600 s,
then terminates them ("Background tasks still running after 600s; terminating"). The relays
die with it, the heartbeat stops, and attached Codex runs are torn down as `abandoned`. For
headless automation that runs Codex workflows, set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.
A run whose relay died can be rescued within `orphanAfterSec` by polling it
(`wait <runId>`), which is exactly what the helper's COLLECT relay does.

## Windows/Git Bash traps (why the transport looks the way it does)

- The Bash tool halves backslash pairs in commands (`\\` → `\`) — never pass backslashes
  through a command; the relay payload is percent-encoded.
- Commands longer than ~7–8 KB break (`unexpected EOF while looking for matching '`): the
  Windows command-line limit. Payloads go in ≤1.6 KB parts.
- A directory (or file) written a moment ago can refuse a rename with `EPERM` while Defender
  or the indexer holds a handle — measured at ~1 % of directory renames. The runner retries
  those renames (slot leases, upload claims) for up to a second instead of failing the run.
- `pgrep`, `setsid` and `ps -o` do not exist; `/proc/<pid>/winpid` maps an MSYS PID to the
  Windows PID if you ever need it.
- `codex` in Git Bash is an sh shim → `node.exe` → native `codex.exe`; killing the shell or node
  leaves `codex.exe` running. Another reason the supervisor spawns `codex.exe` itself.
