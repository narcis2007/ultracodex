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
| `part new 1 N HASH` · `part UPLOAD K N HASH` | relay upload: part 1 opens an upload (the runner allocates its id), parts 2..N go to it; a part whose hash differs is refused (`part_rejected`), but a copy that runs on into the next part's lines keeps the prefix that matches (`trimmedLines`); the last part starts the run |
| `wait RUN_ID [--max-wait SEC]` | poll up to 110 s (default; the workflow relay asks for `--max-wait 570`); prints the final envelope or the running state; refreshes the heartbeat on every poll while it blocks |
| `run --request FILE` | start + one wait |
| `status [RUN_ID] [--all]` · `result RUN_ID` | inspect runs (never refresh the heartbeat) |
| `page RUN_ID K` | slice K of a large result (see "Paged results") |
| `key` | the per-machine key, a fresh nonce and their `keyCheck` — for the Workflow helper's key agent only |
| `expect DIGEST` | announce one relayed request by its 64-hex digest before it is uploaded — for the key agent only (see "Signed requests and results") |
| `cancel RUN_ID` | ask that run's supervisor to stop its own process tree |
| `cancel --orphaned` | the same for every unfinished attached run whose caller stopped polling for its `orphanAfterSec` (the cleanup after stopping a workflow on purpose — it reaches every unpolled run on this machine, other sessions' too, so only when the owner asks); prints one line listing the run ids and labels |
| `preflight [--live]` | CLI, auth, catalog, policy models, home dir; `--live` = one tiny luna call |
| `dry-run --request FILE` | show the exact codex argv, model, effort, deadline — no model call |
| `policy` · `models` · `schema PRESET` · `schema-check --schema FILE` · `gc` | helpers (`gc` also removes dormant sessions older than `--older-than-days`) |
| `send` · `interrupt` · `answer` · `events` · `close` · `result RUN --turn N` | steerable sessions and steerable Workflow nodes — see "Sessions" and "Steerable nodes" below; never for relays or readers |

Request fields (unknown fields are rejected): `task` or `taskFile`; `schema` / `schemaFile` /
`schemaPreset` (`verdict`, `score`, `review`, `implement`); `cwd`; `sandbox` (`read-only` default,
`workspace-write`); `tier` (`light`/`daily`/`final`); `kind` (`verify`/`ask`/`review`/`implement`);
`model`, `effort` (overrides); `hermetic` (default true); `network` (workspace-write only);
`timeoutSec` (default from the policy; scaled ×(1 + 0.25·(N−1)), at most ×4, by `workItems: N`
for a batch); `maxAttempts` (default 2 for read-only work, **1 for writing tasks** — workspace-write
or resume — which may only retry with `replaySafe: true`, since a replay could apply effects
twice); `attached` (default true — a run nobody polls for
`orphanAfterSec`, default 1800 so a stopped background `wait` can be restarted, is `orphaned`; the Workflow helper sends 900); `onOrphan`
(`finish` default: an orphaned run keeps going to its result or deadline and a later upload of the same signed request joins it;
`stop`: it is torn down as `abandoned`); `limitWaitSec` (0–691200, default 86400: how long a usage-limited run waits for the limit to
reset before failing with `usage_limit`; 0 = only the 15-minute account wait); `ephemeral` (default false to retain resumable thread history);
`label`; `meta` (echoed back); `serviceTier` (`priority` = Fast); `addDirs`; `images`;
`profile`; `review: {base|commit|uncommitted, title}`; `resume: {sessionId}`; for a session (direct runs only):
`session` (default false), `idleTtlSec` (0–86400, default 1200), `askOrchestrator` (default true), `askTimeoutSec` (60–86400,
default 1800) — see "Sessions"; `steerable` (default false; allowed in relayed requests, where it is signed — the Workflow
helper sends it for every node) — see "Steerable nodes".

Envelope: `ok: true` + `result` (schema) or `text` — never both —, `resultHash` (FNV-1a of the
body, so a relay's transcription can be verified), `mac` (see "Signed requests and results"),
and `provenance` {threadId, model, effort, tier, mode, sandbox, hermetic, usage (last attempt),
usageTotal (all attempts), durationMs, attempts, codexVersion, launcher, taskHash, teardown,
slotLost, accountHandoffs, limitResumes, limitWaitedSec, backend (`exec` | `session`: where it ran), steers (steering
messages a steerable node accepted; absent when none)}. Failures: `ok: false`, `state` (`failed`, `timeout`, `cancelled`, `abandoned`,
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

Known limit: a relay copies every page back verbatim, and very large results (measured at
60 000 characters, 10 pages) failed to come back through every relay model — Haiku 5.5
miscopied pages, Sonnet 5.5 declined to repeat the output, and the Opus 5.5 recollect was
stopped by the API's `reasoning_extraction` safeguard. Such a node fails closed; the run's
result stays in `~/.ultracodex/runs/<runId>/result.json`. Keep workflow results compact
(structured fields, not transcripts) and read large ones from the main conversation.

Runs live in `~/.ultracodex/runs/<runId>/` (request, task, schema, state, per-attempt
`events.jsonl` / `stderr.log` / `last.txt`, `supervisor.log`, `result.json`). `gc` removes
finished runs after 7 days. `ULTRACODEX_HOME` moves the directory; `ULTRACODEX_CODEX_PATH`
points at a specific Codex binary; `ULTRACODEX_MAX_CONCURRENT` sets the machine-wide cap (0 =
unlimited); `ULTRACODEX_LIMIT_WAIT_SEC` is the default `limitWaitSec` for requests that do not set it;
`ULTRACODEX_LIMIT_PROBE_MS` the rate-limit probe cadence during a limit wait (default 5 min).

Relayed requests (`part`, `start --framed`) are read-only and hermetic by construction: the
runner refuses `workspace-write`, `hermetic: false`, `network`, `resume`, `taskFile`, `schemaFile`,
`addDirs`, `images` and `profile` from a relay, even with valid hashes. Suspend-aware: after a
sleep the supervisor extends the deadline by the time asleep and pauses the orphan check for one
`orphanAfterSec`; `wait` declares `lost` only after watching the supervisor stay silent.

### The guard (plugin hook)

`hooks/hooks.json` registers `scripts/relay-guard.mjs` as a PreToolUse hook on Bash. It
judges a command by the agent type that runs it (hook input `agent_type`) — the type the
helper chose, never what the model asks for — and leaves the main conversation alone:

| Agent type | May run through Bash | Otherwise |
| --- | --- | --- |
| `ultracodex:codex-relay` — job relay | `node "<plugin>/scripts/codex-node.mjs" part (new\|ucx-…) K N HASH <<'UCX_P…' … UCX_P…` with a quote- and backslash-free body, `… wait <runId>`, `… page <runId> <k>` | denied, other tools too |
| `ultracodex:codex-key` — key agent | `… key`, `… expect <64 hex>` | denied, other tools too |
| `ultracodex:codex-reader` — Claude stages that read reviewed code | one read-only git command: `git -c safe.bareRepository=explicit [-C <repository>] diff\|log\|show\|status\|blame\|ls-files\|ls-tree\|grep\|rev-parse\|merge-base\|cat-file\|describe\|shortlog\|diff-tree\|rev-list\|name-rev …` (the setting is required: git itself then refuses any repository it would only have found by looking around) — no shell metacharacters or unquoted globs, no global options, no `--output`/`--ext-diff`/`--no-index`/`--contents`/`--open-files-in-pager`/`--exec` nor any abbreviation of them, no `-O` even bundled, no network paths, nothing under the ultracodex home; `-C` without `..`, and — with or without `-C` — only where git's upward discovery, walked as written and with links resolved, reaches a `.git` before a bare-looking directory (Read, Grep, Glob stay available) | denied |
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
| `--ephemeral` | explicit opt-out of session files and account continuation |
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

### Account continuation

When a persistent ChatGPT job fails with a usage limit, the runner enters a *limit wait* of
at most `limitWaitSec` (default 24 h; internal state `limit_wait`) that ends when the
selected account changes **or** usage is allowed again on the same account, then resumes
the exact saved thread using a fixed continuation instruction, not the original task
prompt. The same run id, request digest, final schema, sandbox, network permissions and
working directory are preserved (every `exec resume` restates `sandbox_mode` — without it
the resumed turn is read-only, even for a thread that was writable — and, for
workspace-write, `network_access` and `writable_roots`). `wait` and `status` report
`backoff` with `waitingForAccount: true`, `waitingForLimit: true`, `resumesAt` (ISO; the
latest reset among the used-up windows of the `codex` limit, else the earliest known; null
until a probe learned it) and `limitWaitUntil` (ISO; when the wait gives up), so
already-loaded Claude relays keep polling. Cancellation stays active while waiting; an
orphaned run keeps waiting unless `onOrphan` is `stop`.

"Usage is allowed again" comes from a rate-limit probe: a short-lived `codex app-server
--listen stdio://` (same launcher; inside the supervisor's Job Object) that gets
`initialize`, `initialized` and `account/rateLimits/read` — no model turn, no MCP servers,
no usage, nothing mutating — and is closed through its stdin. It runs once on entering the
wait, then at most every 5 minutes (`ULTRACODEX_LIMIT_PROBE_MS`) and once 30 s after the
expected reset. `ordinaryUsageAllowed: true` resumes, `false` keeps waiting; with no
verdict (`null`, or a failed probe) the latest known reset time plus 60 s resumes. Only
allowed/percent/reset times are kept or logged — never account or credit ids. From a run's second limit wait on, a resume (verdict or reset time) is honoured only `ULTRACODEX_LIMIT_PROBE_MS` × 2^(k−1) after the wait began, k = the limit resumes so far (never beyond the cap; `resumesAt` shows it; account changes are not deferred). Hitting the
cap ends the run as `usage_limit`; `limitWaitSec: 0` keeps only the 15-minute account
wait of 0.3.7 (what `auth` and `rate_limit` errors always get — a single check for an
account that already changed). Time spent waiting does not count against the job's
deadline: the continuation gets the work time the interrupted attempt had left.

Native `codex exec` cannot reload accounts during an active request; an account
change alone never interrupts a tool command. Continuation — after a reset or an account
change, sharing one budget — is bounded to eight handoffs and requires a thread id,
managed ChatGPT authentication and verified cleanup. Auth/rate-limit errors continue only
if the account already changed. Explicit ephemeral jobs and external authentication are
never continued. The result's provenance reports `accountHandoffs`, `limitResumes` and
`limitWaitedSec` separately. A waiting run keeps its machine-wide slot.

If the resumed thread fails with `invalid_encrypted_content`, continue once per
handoff in a fresh thread using the exact thread's visible rollout messages and
tool records (or this job's completed event records). Hidden reasoning, encrypted
compaction and config are excluded, the source rollout is left intact, and the
checkpoint is bounded to about 192 KB. This retains work context, but may omit
older history; the fixed instruction requires inspecting current files and asking
for missing essential context. Provenance records `contextRestarts` separately.


A normal `codex exec` loads every MCP server from `~/.codex/config.toml` — on this machine
eight of them, including production business APIs and a computer-use REPL. `-s read-only`
restricts shell commands, not MCP tools. Hermetic runs (`--ignore-user-config`) drop all of
them; measured: same result, clean stderr, ~1.8K fewer input tokens. Pass `hermetic: false`
only when a job genuinely needs the user's config.

## Sessions (steerable runs)

`"session": true` (direct requests only: a framed request that carries `session`, `idleTtlSec`, `askOrchestrator` or
`askTimeoutSec` is refused; `review` and `profile` are refused with it; `exec` and `resume` modes work; the three
other fields need `session: true`) makes the supervisor drive a private
`codex app-server --listen stdio://` (JSON-RPC 2.0, one object per line; codex-cli 0.163.0-alpha.2) instead of
`codex exec`. `scripts/session.mjs` holds the driver (the runner imports it back; the runner stays the one CLI entry).

**Wire.** Spawn `<launcher> app-server --listen stdio://` (+ flags below) in the Job Object like `exec`; `initialize`
`{clientInfo, capabilities: {experimentalApi: true}}` (required for `dynamicTools`) then `initialized`;
`config/read` (hermetic only, see "Verified isolation"), then
`thread/start` `{model, cwd, sandbox, approvalPolicy: "never", approvalsReviewer: "user" (hermetic), ephemeral, dynamicTools?, serviceTier?}` or
`thread/resume` `{threadId, sandbox, approvalPolicy: "never", approvalsReviewer: "user" (hermetic), model, excludeTurns: true}` (every revive, every account-change
restart, and the first start of `resume` mode — the resumed sandbox is honoured, dynamic tools registered at `thread/start`
are restored; a resumed external thread cannot gain `ask_orchestrator`); `turn/start` `{threadId, input, effort,
outputSchema?}` (`localImage` items for `images`); `turn/steer` `{threadId, expectedTurnId, input}`; `turn/interrupt`;
`mcpServerStatus/list` (hermetic check); `thread/archive` (`close --archive`); `account/rateLimits/read` stays the probe's.
`turn/start` on an active turn steers (it does not queue), so the supervisor queues follow-ups itself and starts them after
`turn/completed`. Closing the app-server's stdin ends it in under a second; one that lingers past `killGraceMs` is stopped
with the Job Object like any run's tree, and whatever it left behind goes too. Hermetic spawn (no `--ignore-user-config` on
`app-server`): `--disable plugins --disable apps -c notify=[]`, `-c mcp_servers.<name>.enabled=false` for every
`[mcp_servers.<name>]` table (bare or quoted; also `name = {…}` under `[mcp_servers]` and dotted top-level keys) in
`$CODEX_HOME/config.toml`, the Windows sandbox `-c`; workspace-write adds `sandbox_workspace_write.network_access` and
`writable_roots` (= `addDirs`); `-c service_tier="<serviceTier>"` (a hermetic run always states it, `"default"` unless the request
names one; a non-hermetic one only when named). After every `thread/start|resume` a hermetic run calls
`mcpServerStatus/list` (following `nextCursor`): any server with tools — or a list that cannot be read — stops the app-server
and ends the run as `hermetic_violation` before a turn starts.

**Verified isolation (0.6.0).** The flags above only switch things off; what else the user's `config.toml` (or a project's
`.codex/config.toml`) contributes is *verified*, not assumed: right after `initialize` and before any thread, a hermetic
app-server is asked `config/read {cwd, includeLayers: false}` (60 s; `ULTRACODEX_CONFIG_READ_TIMEOUT_MS`) and
`isolationViolations()` judges the answer — the effective `config` and, for every effective dotted key, the layer it came from
(`origins[key].name.type`: `packagedDefaults`, `mdm`, `system`, `enterpriseManaged`, `user`, `project`, `sessionFlags`,
`legacyManagedConfigToml…`). Only keys whose origin is `user` or `project` are judged (defaults, managed layers and our own flags
apply to `codex exec --ignore-user-config` too). Allowed: **inert** client / UI / bookkeeping keys (`tui.*`, `desktop.*`,
`notice.*`, `marketplaces.*`, `projects.*`, `profiles.*` — definitions only, a top-level `profile` is a violation —, `history.*`,
`analytics.*`, `feedback.*`, `file_opener`, `check_for_update_on_startup`, `disable_paste_burst`, `hide_agent_reasoning`,
`suppress_unstable_features_warning`); **neutralized** keys, judged by the *effective* value (the origins of array elements go
stale after `-c`): `plugins.*` iff `features.plugins` is false, `apps.*` iff `features.apps` is false, `mcp_servers.<n>.*` iff
that server's effective `enabled` is false, `notify` / `notify.*` iff the effective `notify` is empty; **driver-owned** keys (set
on every thread / turn): `model`, `model_reasoning_effort`, `approval_policy`, `approvals_reviewer`, `sandbox_mode`,
`service_tier`, and `sandbox_workspace_write.*` for a read-only request (for workspace-write only the two keys passed with `-c`);
and `windows.sandbox` (exec carries it too). Anything else from those layers — `developer_instructions`, `instructions`,
`model_instructions_file`, `model_provider(s)`, `profile`, `shell_environment_policy.*`, `hooks.*`, other `features.*`, `tools.*`,
`web_search`, `model_verbosity`, `model_reasoning_summary`, `otel.*`, `skills.*`, an MCP server that is not disabled, … — is a
violation. A violation, an error (an older Codex without `config/read`), an unreadable answer or a timeout is
`hermetic_violation` (fail closed): event `hermetic_violation {keys}` (names only, never values; `<unverifiable>` when it could not
be judged), the app-server is stopped, no thread is started. The MCP check above stays as the second check.

**State machine.** `queued` (starting, waiting for a slot) → `running` (turn active; `steerable` false after
`activeTurnNotSteerable`) → `idle` (`idleUntil`; events `idle`) → `dormant` (stdin closed, process gone, lock released, the
supervisor exits; event `dormant`) → a message revives it (`resumed {reason: "revive"}`) → … → `closed` | `cancelled` | `failed`
(`result.json`, the last turn's envelope with the final state). `backoff` while a turn's usage-limit/account wait runs. An
app-server that exits outside a close fails the active turn (`execution`) and leaves the session dormant (no restart loop); an
ephemeral session ends (`closed`) instead of sleeping. A turn's deadline (`timeoutSec`; moved by suspended time) interrupts it
(kind `timeout`); an app-server that does not end the turn within `killGraceMs` is killed and the session goes dormant.
`onOrphan` applies while a turn runs; an idle session is never abandoned (`cancel --orphaned` skips idle ones).

**Run directory** (beside `request.json`, `state.json`, `supervisor.log`): `events.jsonl`; `inbox/` (`<id>.json`
`{id, kind: send|interrupt|answer|close, text?, mode?, questionId?, force?, archive?, createdAt}`, moved to `inbox/done/` once
handled, in order, polled every `ULTRACODEX_POLL_MS`); `outbox/<id>.json` `{id, outcome, reason?, turn?, at}`; `turns/<n>.json`;
`queue/` (accepted follow-ups not yet started); `supervisor.lock` (`{pid, startedAt}`, created with `wx`; stale when its pid is
gone, or — pid reuse after a reboot — when `alive` and the lock are both older than `lostAfterMs`; a supervisor whose lock
was taken over stops without writing); `app-server.log` (the app-server's stderr). `state.json` adds `session`, `threadId`,
`turn`, `turnActive`, `steerable`, `idleUntil`, `question` `{id, question, since}`, `queued`, `usageTotal`. Order of effects: an
event is appended before the state that announces it; an inbox message is applied, then moved, then acknowledged — which is
what lets `wait` / `events --follow` read "state, then events" and miss nothing. A `send` to a dormant session (or one whose
supervisor is gone) writes its message, starts a detached supervisor the way `start` does and waits for the acknowledgement
(`ULTRACODEX_ACK_WAIT_MS`, 15 s, then `pending`, exit 3); a supervisor that wound down just after a message arrived hands it on.

**Turn envelope** = the one-shot envelope (same `mac`, `resultHash`, failure kinds) plus `session: {turn}`; provenance has
`usage` (this turn), `usageTotal` (the session), `threadId`, `previousThreadIds` (after a checkpoint thread), and the chain's
`accountHandoffs` / `limitResumes` / `limitWaitedSec` / `contextRestarts`. `codexErrorInfo` maps to `usage_limit`
(`usageLimitExceeded`), `rate_limit`, `auth` (`unauthorized`), `context` (`contextWindowExceeded`), `server`, `network`
(stream / connection failures), `invalid_request` (`badRequest`), `encrypted_history` (told by its text), else the text classifier;
an interrupt is `interrupted` (`ok: false`, not retryable). Limits inside a session: a failed `usage_limit` / `auth` /
`rate_limit` turn goes through the same preconditions, `waitForLimitReset` / `waitForAccountChange` (the deadline moves by the
time waited, the eight-continuation budget and the spacing apply); a reset continues on the same app-server, an account
change restarts it (`thread/resume`, hermetic check) and continues, and a rejected encrypted reasoning continues from
`visibleAccountCheckpoint` in a fresh thread that becomes the session's. `close`, `interrupt`, `cancel` and new messages are
handled while it waits.

**Security.** Inbox writes come from unsandboxed callers only — a read-only Codex sandbox cannot write the runner's home
(measured), and a writable request whose `cwd` or any `addDirs` entry contains, or lies inside, the home (links resolved) is
refused (every writable request, session or not). The relay guard is unchanged and allows relays and readers none of the
session commands. Nothing from `auth.json`, no account or credit id and no reasoning content is logged, returned or put in the
feed.

Timing and test knobs: `ULTRACODEX_ACK_WAIT_MS`, `ULTRACODEX_ACK_GRACE_MS` (how long a command keeps looking for its ack once `result.json`
exists: the supervisor writes `result.json` first and acknowledges after it, so a `close` whose ack is late still reports `closed`),
`ULTRACODEX_CLOSE_WAIT_MS`, `ULTRACODEX_LOCK_WAIT_MS`, `ULTRACODEX_MIN_ASK_TIMEOUT_SEC`, `ULTRACODEX_EVENT_CAP_BYTES`,
`ULTRACODEX_TEST_FINAL_ACK_DELAY_MS` (tests only: delays the acks a session ends with), `ULTRACODEX_ACCOUNT_CHECK_MS` (how often running
or idle work looks at the managed account, default 2000), `ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE` (**test only**: when set and the file holds text,
that text, trimmed, is the managed account (an empty or unreadable file falls back to the real login), so the follow-the-switch mechanics can be
checked live — "switching" is writing other text into it — without ever touching the real `auth.json`; Codex itself keeps using its real login),
`ULTRACODEX_TEST_FAULT=unclean-teardown` (tests only: an account-switch stop reports an unverifiable teardown), `ULTRACODEX_MCP_OUTPUT_CAP` (the MCP server's collection cap for one runner call, default 360000 characters; a test lowers it).

## Steerable nodes (0.6.0)

`"steerable": true` makes a plain one-shot job — exec mode, any `kind`, not a review / resume / session, no `images`, no `profile` —
run as **one turn of a session** (the same driver, `single: true`) so it can be steered while it runs, and end with its turn. The
Workflow helper sends it for every node (`codexNode(task, { steerable: false })` leaves it out); it is part of the signed header, so
a relay can neither add nor drop it, and it is allowed in relayed requests, which stay read-only and hermetic (`session`,
`idleTtlSec`, `askOrchestrator`, `askTimeoutSec` stay refused). The request, the signed digest, the envelope and the result `mac` are
exactly a one-shot run's; a runner that does not know the field rejects the request (`unknown request fields`), loudly.

**Backend and fallback.** The supervisor runs a steerable job on the session driver unless `ULTRACODEX_NODE_BACKEND=exec` (the kill
switch, read by `start` and the supervisor) says exec. If the driver fails **before the first turn starts** — `hermetic_violation`
(including an isolation check that cannot be judged), `spawn`, an app-server or protocol start failure (initialize, `config/read`,
`thread/start`) — the supervisor logs it, appends the event `backend_fallback {reason, kind}`, takes the session fields out of
`state.json` (`backendFallback` records why; messages still in the inbox are rejected `backend_fallback`) and runs **the same job on
`codex exec`** as if it had never been steerable: same run id, same signed digest, the attempts budget untouched, the deadline it was
given (`timeoutSec` less the time the failed start took, counted from when the job first held a slot — never a renewed budget: a start that used it all ends the job as `timeout`, and exec never runs). A failure after a turn started is never a fallback reason, and neither are
`usage_limit` / `auth` (they have their own waits). `provenance.backend` is `session` or `exec` (fallbacks and the kill switch: `exec`).

**Single-turn semantics.** Turn 1 is the task, with the job's schema and effort. The driver's continuation chain applies inside the
job exactly as for a session: usage-limit wait, account handoffs and follow-the-switch, the checkpoint fallback. Additionally a
**retry**: a retryable turn failure (`rate_limit`, `server`, `network`, `empty_output` — what exec retries) with attempts left (`maxAttempts`
counts the turns of this job; a system continuation starts the count again, as a resume does for exec) backs off `ULTRACODEX_BACKOFF_MS × turn`
(stoppable by cancel, an interrupt and the orphan rules), then runs a continuation turn on the same thread whose input is
`continuationPrompt("retry", task)` ("a transient error interrupted your turn" + the request); a thread that cannot be resumed gets a
fresh thread with the original task, once. The deadline (`timeoutSec`, scaled by `workItems`) bounds the **whole** job, retries included
(a retry that would start with less than `ULTRACODEX_MIN_TIMEOUT_SEC` left is not started); limit waits extend it as they do for exec.
When the chain ends the driver writes `result.json` (state `done` / `failed` / `timeout` / `cancelled` / `abandoned` / `interrupted`),
stops the app-server and ends: no idle period, no dormancy, no revive (a second supervisor for it leaves at once). Orphan rules,
cancel (`cancel RUN`, `cancel --orphaned`) and slots (held while a turn runs) are exec's.

**Envelope.** The result is a one-shot run's field for field (`wait`, `result`, `status` print it as they print an exec run's: no
`session` field), plus `provenance.backend: "session"`, `provenance.attempts` (the turns taken) and `provenance.steers` (steering
messages accepted; absent when none). `turns/<n>.json` keeps each turn's own envelope.

**Control while it runs** (`state.json` has `session: true` and `singleTurn: true`; `status` shows `steerable: true`): `send --mode
steer` (and `auto`) steers the running turn (counted in `steers`, an event `steer`); `send --mode queue` is rejected
(`{outcome: "rejected", reason: "single_turn"}`) and so is a message with no running turn (`no_active_turn`: between a failed turn
and its retry, or while waiting for a slot); `interrupt` interrupts the turn and the job ends `interrupted` (never retried); `answer` is
rejected (`single_turn`: no `ask_orchestrator`); `close` is a cancel (acknowledged `closed` once the job ended); `events` works.
`status --sessions` / `codex_sessions` list running and ended nodes with their `label` and `steerable: true` (a node that fell back to
exec is no longer a session and is not listed). `notify` and the channel never report a node's `turn_done`, `error` or `ended`; its
`limit_wait` and `resumed` stay.

Knobs: `ULTRACODEX_NODE_BACKEND` (`exec` = kill switch), `ULTRACODEX_CONFIG_READ_TIMEOUT_MS` (the isolation check, default 60000),
`ULTRACODEX_BACKOFF_MS` (the retry backoff, default 20000 × turn). `preflight` shows `nodeBackend`; `dry-run` shows `backend`.

## Model catalog (codex debug models)

| slug | efforts | note |
| --- | --- | --- |
| `gpt-6-astra` | low · medium · high · xhigh · max · ultra | frontier; Fast tier 2× |
| `gpt-6.1-sol` | low · medium · high · xhigh · max · ultra | workhorse |
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
| `abandoned` · `cancelled` | no | nobody polled (only with `onOrphan: "stop"`) / cancel requested; tree stopped |
| `auth` | no | run `codex login` interactively |
| `usage_limit` | no | plan limit reached, and it did not reset within `limitWaitSec` (or the job cannot be continued) |
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
die with it and the heartbeat stops: the runs are `orphaned` but, by default (`onOrphan: "finish"`), keep
going to their result — `wait <runId>` collects it (what the helper's COLLECT relay does), and
`cancel --orphaned` ends the ones nobody wants. With `onOrphan: "stop"` they are torn down as
`abandoned` after `orphanAfterSec`. For headless automation that runs Codex workflows, set
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.

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
