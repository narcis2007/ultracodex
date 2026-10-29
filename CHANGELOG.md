# Changelog

## 0.6.5 — 2026-10-29 (fix-delta reviews on light; implement sessions stay open)

- `codex-review`: with no `tier`, a pass above 1 (a fix-delta review) runs every lens on `light`
  (`gpt-6.1-terra@xhigh`). Pass 1 is unchanged: `daily` (`gpt-6.1-sol@xhigh`) on every lens. An
  explicit `tier` keeps its meaning for every lens that has no `securityTier`. `priorFindings` without
  `pass` makes pass 2, so it also defaults to `light`.
- Precedence change: an explicit `securityTier` now sets the security lens even when `tier` is given
  (before: an explicit `tier` overrode it). `rereview.securityTier` echoes the caller's `securityTier`
  so the next pass can pass it again.
- `rereview.tier` after a non-final pass is `light` for medium and for high/critical findings
  (it was `daily` for high/critical). After a `final` pass it is unchanged: `daily` for medium,
  `final` for high/critical. The `reason` text is the same for both severities and says to use
  `daily` instead of `light` for a delta of more than about 50 changed lines or more than 3 files,
  or when the fix changed the design. A full re-review is only for a large or design-changing fix.
- `codex-implement`: keep the implementation session open until the change is merged or abandoned,
  and send review fixes to it as one complete follow-up (`send` / `codex_send`). A dormant session
  wakes on `send`. A new run is only for a closed or failed session, and then through the one-shot
  resume fallback with `provenance.threadId`, so Codex keeps its context. Close with `--archive`
  after the merge. `codex-review` and `codex-steer` skills say the same.
- Why, from the owner's runs of 2026-10-23 to 2026-10-29: 18 of 26 pass-2 reviews ran on Sol,
  although the policy says a small delta uses Terra. 13 implementation fix runs started a new
  session instead of a follow-up. The 2026-10-27 benchmark found terra@xhigh at least as good as
  sol@xhigh on replayed review lens jobs, at about a quarter of the cost per run ($0.12 against
  $0.48). Small sample.
- Align the skills, READMEs and model policy, and add offline tests for the new defaults and the
  re-review table. The runner's tier-to-model policy is unchanged.

## 0.6.4 — 2026-10-27 (light tier on GPT-6.1 Terra @xhigh)

- The `light` tier moves from `gpt-6-luna@max` to `gpt-6.1-terra@xhigh` for every kind. Luna is no
  tier model any more; it stays usable as an explicit `model: 'gpt-6-luna', effort: 'max'` for
  mechanical, high-volume work (named without an effort it still defaults to `max`, and counts as
  `light` in provenance). `gpt-6.1-terra` takes `ultra`; luna still does not.
- Benchmark 2026-10-27: 10 past `codex-review` lens jobs replayed at the reviewed commit, 12
  Claude-confirmed medium-or-worse defects as ground truth, one run per config. Found: luna@max
  2/12, terra@xhigh 5/12, terra@max 10/12, sol@xhigh (reference) 4/12. API cost per run: luna
  $0.03, terra@xhigh $0.12, terra@max $0.49, sol@xhigh $0.48. Median time: luna ~275 s,
  terra@xhigh ~79 s, terra@max ~453 s. terra@xhigh found at least as much as luna on 8/8 cases.
  Small sample; run-to-run noise is large. Terra at `max` costs as much as Sol, so `light` uses
  `xhigh`. OpenAI price per MTok: terra $1/$5, sol $2/$10, luna $0.10/$0.50.
- Deadlines: model factor 1 for terra (luna keeps 0.5); a deadline is a runaway guard. Concurrency
  weight 1. The re-review policy of 0.6.3 is unchanged (only the model behind `light` changes).
- Runner `POLICY` gets `explicitModels` (luna → tier `light`, default effort `max`). The helper's
  relay label shows the real effort. Align skills, references and READMEs; tests pin the new routing.

## 0.6.3 — 2026-10-23 (re-review policy)

- `codex-review` returns a deterministic `rereview` policy and ends the report with its
  `Re-review:` line. Low-only or clean reviews stop; medium/high findings get fixes, verification
  and a review of only the fix delta with the prior findings. Medium deltas use `daily` after
  a `final` pass, otherwise `light` (or `daily` above about 50 changed lines or 3 files).
  High/critical deltas use `daily`, or keep `final` when selected. Full re-reviews are only
  for large or design-changing fixes.
- This follows the owner's last 30 days: 219 reviews on 104 changes used about 47% of all
  Codex credits (implementation: 44%); passes 2+ used about half the review credits. After a
  complete low-only or clean pass, later passes found medium-or-worse defects in 0 of 12 cases;
  low findings kept appearing without converging. After medium findings, the next pass found
  a high in 5 of 52 cases (about 10%). Claude lowered severity in 77% of confirmed findings;
  about 23% were duplicates from two lenses reporting the same defect at the same file:line.
- Add `pass`, `priorFindings` and `ownerApproved`. Later passes check that prior findings are
  fixed and look only at the fix delta and its callers, except for high/critical defects.
  Cap reviews at 3 passes; a further pass needs the owner's OK. Failed lenses re-run on the
  same scope and pass number. Reports merge duplicate defects and make low findings optional.
  Align the review and implementation skills, add offline policy tests and rebuild workflows.
- Return active findings as `rereview.carry` for later briefs and append the `Re-review:` footer in code.

## 0.6.2 — 2026-10-20 (Astra opt-in for routine reviews)

- `codex-review` now defaults every lens, including `security`, to `daily` (gpt-6.1-sol@xhigh).
  The owner's 20.10 usage rule reserves Astra for critical work: security-sensitive code (auth,
  keys, crypto, payments, personal data), data migrations, irreversible production steps and
  the last gate before a production release. Routine reviews and asks stay on Sol.
- This follows the owner's run measurements: Astra used about 52% of all Codex credits over
  the last 14 days. The 54 `codex:security` runs at astra@max accounted for about 45% of Astra
  credits. Astra's share rose from 9% in the week of 05.10 to 44% in the week of 12.10 and 68%
  from 19.10.
- For a critical change, pass `securityTier: 'final'` to use Astra only on the security lens,
  or `tier: 'final'` for every lens. `securityTier` accepts `light`, `daily` or `final`; invalid
  values are ignored. An explicit `tier` wins over `securityTier`. Per-lens routing is reported
  as before. High/critical escalation, cross-review's final gate and crosscheck defaults stay
  the same; `fast` still applies only to Astra nodes. Rebuild workflows and align skill guidance.

## 0.6.1 — 2026-10-19 (plumbing agents skip CLAUDE.md)

- `codex-relay` and `codex-key` set `omitClaudeMd: true`. They only carry a runner job or a key; the owner's
  global `~/.claude/CLAUDE.md` and a repo's CLAUDE.md are not loaded into them any more (fewer tokens, nothing that
  could compete with "reply with the runner's JSON verbatim"). `codex-reader` keeps CLAUDE.md: it judges findings and
  needs the repo's own conventions.

## 0.6.0 — 2026-10-10 (steerable workflow nodes, verified isolation)

Workflow nodes (`codexNode`, relayed by `codex-relay`, signed with the machine key) can now be steered while they run:
the owner, or the main Claude session through the `codex_*` tools, can send a steer to one review lens, interrupt a node
cleanly and watch its live events — without changing the relay protocol and without weakening isolation. Phase 4 had been
skipped because `codex app-server` has no `--ignore-user-config`; it became possible once the app-server's own `config/read`
turned out to say, for every effective setting, which layer it came from — so isolation is **verified** for every hermetic
app-server (sessions included) instead of assumed, and a node falls back to the old exec path whenever it cannot be proven.

- **Verified isolation (every hermetic app-server, sessions too).** Right after `initialize` and before any `thread/start|resume`,
  the driver calls `config/read {cwd, includeLayers: false}` (60 s; `ULTRACODEX_CONFIG_READ_TIMEOUT_MS`) and the pure function
  `isolationViolations(configRead, {request})` judges it: per effective key in `origins`, a key whose origin is not `user` or
  `project` is fine (defaults, managed / system / MDM / enterprise layers apply to exec too; `sessionFlags` are ours); a `user` or
  `project` key is allowed only if it is **inert** (`tui.*`, `desktop.*`, `notice.*`, `marketplaces.*`, `projects.*`, `profiles.*`
  — a top-level `profile` is a violation —, `history.*`, `analytics.*`, `feedback.*`, `file_opener`, `check_for_update_on_startup`,
  `disable_paste_burst`, `hide_agent_reasoning`, `suppress_unstable_features_warning`), **neutralized** — judged by the *effective*
  value, because the origins of array elements go stale after `-c` (`plugins.*` iff `features.plugins` is false, `apps.*` iff
  `features.apps` is false, `mcp_servers.<n>.*` iff that server's effective `enabled` is false, `notify` iff the effective hook list is
  empty), **driver-owned** (`model`, `model_reasoning_effort`, `approval_policy`, `approvals_reviewer`, `sandbox_mode`,
  `service_tier`; `sandbox_workspace_write.*` for a read-only request, and for workspace-write only the two keys passed with `-c`) or
  **carried on purpose** (`windows.sandbox`, as exec carries it). Everything else (`developer_instructions`, `instructions`,
  `model_provider(s)`, `profile`, `shell_environment_policy.*`, `hooks.*`, other `features.*`, `tools.*`, `web_search`, `otel.*`,
  `skills.*`, an MCP server that is not disabled, …) is a violation. A violation, a `config/read` error (an older Codex), an
  unreadable answer or a timeout stops the app-server before any thread and ends the run `hermetic_violation` (fail closed); the
  event `hermetic_violation {keys}` names keys, never values (`<unverifiable>` when it could not judge). The `mcpServerStatus/list`
  check stays as the second check after the thread starts.
- **Driver-owned settings are explicit.** `thread/start` and `thread/resume` of a hermetic run pass `approvalsReviewer: "user"` (the
  owner's own `auto_review` subagent never applies), and the app-server is always started with `-c service_tier="<tier>"` (`"default"`
  unless the request names one), as `--ignore-user-config` never sees the user's. `dry-run` shows the flags; `preflight` reports
  `nodeBackend`.
- **Request field `steerable`** (boolean, default false): run this one-shot job as a single-turn session on a private app-server so it
  can be steered while it runs; it ends with its turn. Plain exec-mode jobs only (any `kind` and, for direct requests, any sandbox):
  not a review, a resume, a session, with images or a profile. It is part of the signed header (so a relay can neither add nor drop it —
  tested), allowed in relayed requests, which stay read-only and hermetic; `session`, `idleTtlSec`, `askOrchestrator`,
  `askTimeoutSec` stay refused for relays. A runner that does not know the field rejects the request (`unknown request fields`).
- **`codexNode(task, { steerable = true })`**: the helper puts `steerable: true` in the signed header (and leaves it out with
  `steerable: false`, so an old runner still accepts the request); `codexBatchNode` passes it through; the `_codex` provenance now
  carries `backend` and `steers`. The generated workflows and `workflow-templates.md` are rebuilt.
- **Single-turn semantics** (the session driver with `single: true`). Turn 1 is the job's task with its schema and effort. The
  continuation chain applies as for a session — usage-limit wait, account handoffs and follow-the-switch, the checkpoint fallback —
  plus **retries**: a retryable failure (what exec retries: `rate_limit`, `server`, `network`, `empty_output`) with attempts left
  (`maxAttempts`) backs off `ULTRACODEX_BACKOFF_MS × turn` (stoppable by cancel, interrupt and the orphan rules) and continues the
  same thread with a notice that "a transient error interrupted your turn" (`continuationPrompt("retry", task)`); a thread that cannot
  be resumed gets a fresh thread with the original task, once. `timeoutSec` bounds the whole job, retries included; orphans, cancel and
  slots behave like exec's. When the chain ends the driver writes `result.json` and stops the app-server: no idle period, no
  dormancy, no revive. **`wait` / `result` / `status` print exactly what they print for an exec run** — the same envelope fields
  (`ok`, `state`, `text` / `result`, `resultHash`, `mac` signed with the request digest, `provenance`), no `session` field — plus
  `provenance.backend` (`session`, or `exec` for exec runs and fallbacks) and `provenance.steers` (steering messages accepted).
- **Control while it runs.** `send --mode steer` / `auto` (and `codex_send`) steers the running turn; `send --mode queue` is
  rejected (`{outcome: "rejected", reason: "single_turn"}`); `interrupt` ends the job `interrupted` (never retried); `answer` is
  rejected; `close` is a cancel; `events` works. `status --sessions` / `codex_sessions` list running and ended nodes with their
  `label` and `steerable: true`.
- **Quiet notifications.** `notify` and the channel never emit `turn_done`, `ended` or `error` for a node (a review workflow would
  post one line per lens); `limit_wait` and `resumed` stay.
- **Fallback to exec.** If the driver fails before the first turn starts — `hermetic_violation`, `spawn`, an app-server or protocol
  start failure (initialize, `config/read`, `thread/start`) — the supervisor appends `backend_fallback {reason, kind}`, takes the
  session fields out of `state.json` (`backendFallback` records why), rejects what is in the inbox and runs the same job on
  `codex exec`: same run id, same signed digest, the attempts budget untouched and what is left of the deadline it was given (never a renewed budget: a start that used it all ends the job as `timeout`, and exec never runs). A failure after a turn
  started, a usage limit or a login problem is never a fallback reason.
- **Races and budgets** (found in review). A cancel, close or abandonment that arrives while the backend starts is looked at again before `turn/start` and before a result is accepted, so a cancelled job ends `cancelled`, never `done`, and is not handed to exec; a suspension of the machine during the retry backoff (or a slot wait) moves the job's deadline as it does in every other wait; the `limitWaitedSec` of a usage-limit wait that ended without another turn is in the final `provenance`. Test-only knobs: `ULTRACODEX_SUSPEND_GAP_MS`, `ULTRACODEX_TEST_FAULT=suspend-in-backoff:<ms>`.
- **Kill switch.** `ULTRACODEX_NODE_BACKEND=exec` (read by `start` and the supervisor) makes every steerable job run on exec as before.
- Skills: `codex-steer` has "Steering a Workflow node"; `codex-workflow` documents `steerable` and the fallback and kill switch in
  `references/codex-headless.md` ("Verified isolation", "Steerable nodes"); README: "Steering a workflow node".
- Test fixtures: the fake Codex answers `config/read` (`FAKE_CODEX_CONFIG_READ`: clean, owner, leak, missing, error, hang, a file) and
  can fail turns (`FAKE_FAIL_FIRST`, `FAKE_CODEX_FAIL_TURNS`, `FAKE_FAIL_EXIT`).

## 0.5.0 — 2026-10-10 (native tools + notifications)

Codex sessions feel like Claude Code's own agent messaging: native tools instead of Bash commands, and a
notification when Codex asks or finishes instead of polling. Everything is additive; the runner commands,
the one-shot behaviour and the Workflow path are unchanged.

- **MCP server `scripts/mcp-server.mjs`** (hand-written JSON-RPC over stdio, no dependency; declared in
  `plugin.json` as `mcpServers.ultracodex`, one process per Claude session). Nine tools, each running the runner
  CLI and returning its JSON line: `codex_start` (always a session, never attached), `codex_sessions`,
  `codex_send`, `codex_interrupt`, `codex_answer`, `codex_events` (at most 200 events per call, `since` / `lastSeq`
  paging, `waitSec` ≤ 300), `codex_wait` (≤ 600 s), `codex_result`, `codex_close`. Full names are
  `mcp__plugin_ultracodex_ultracodex__<tool>`. A refusal is an answer; only a bad argument or a dead runner is a
  tool error. It asks for MCP revision 2025-06-18 whatever the client prefers (a channel server that negotiates
  2026-07-28 cannot deliver channel messages). The relay, key and reader agents keep their Bash/Read/Grep/Glob
  `tools:` list and never get these tools (tested). The runner's output is decoded as UTF-8 across chunk boundaries, and
  `codex_sessions` asks the runner for sessions only (`status --sessions [--mine | --owner ID | --all] [--limit N]`: session runs, newest
  first, default 50, `truncated` counts the rest) instead of reading the whole history; output that was cut off is an error, never parsed.
- **Ownership.** Each run records the Claude session that started it (`owner`, `ownerSource` in `state.json`; shown
  by `status`; `status --mine` filters by it): `ULTRACODEX_OWNER` — exported into the session's Bash commands by the
  new `SessionStart` hook (`scripts/session-start.mjs`, from the `session_id` and `CLAUDE_ENV_FILE` Claude Code gives
  it; prints nothing, never fails the session) — else `CLAUDE_CODE_SESSION_ID` (present today, not documented), else
  none. Metadata only: never in a request, a signature or a digest, and a relayed request cannot set it.
- **`notify`** (`scripts/notify.mjs`): `notify [--owner ID | --all] [--max-wait SEC | --forever] [--from now|cursor]`
  watches the event feeds of the owner's sessions and prints one compact JSON line per actionable event —
  `question`, `turn_done` (with a ≤ 400-character summary), `limit_wait` (once per wait: with the reset time when a probe knows it, else `null` after ~10 s), `resumed` (limit reset / account change),
  `error`, `ended` (cancelled, or a session that failed) — and nothing for messages, commands, file changes, steers,
  idle and the like. A per-owner cursor (`~/.ultracodex/notify/<hash>.json`) lets a re-armed watcher continue without
  missing or repeating anything (also not the same usage-limit wait: the cursor remembers which event reported it); a question still
  waiting is printed again at startup. Default `--max-wait` 1740 s
  (fits the Monitor tool's 30-minute cap); `--forever` takes a per-owner singleton lock; no owner and no `--all` →
  `{"codex":"notify_unavailable",…}`, exit 1. It writes no heartbeat. `gc` prunes cursor and lock files older than a week.
- **Plugin monitors** (`experimental.monitors` in `plugin.json`): `notify --forever` starts when `codex-implement`,
  `codex-steer` or `codex-ask` is used (interactive sessions).
- **Channel** (Claude Code research preview): the MCP server declares `experimental["claude/channel"]` and, after
  `notifications/initialized`, pushes the same events as `notifications/claude/channel` ("Codex session … asks: …",
  "… finished turn 2 (ok): …") with identifier-only `meta` (`run_id`, `event`, `turn`, `question_id`, `label_slug`). Its
  own cursor namespace; `ULTRACODEX_CHANNEL=0` turns it off. Registered only when Claude Code is started with
  `--dangerously-load-development-channels plugin:ultracodex@ultracodex`; otherwise the notifications are dropped
  silently and the tools work as before.
- **Continuations say what happened.** The input of every continuation — after an account switch, after a usage limit and an account change,
  after a limit reset; sessions and one-shot runs alike — is no longer the bare "continue the unfinished task" (live, a model with an output
  schema took the handoff at a step boundary for the end and skipped the last command of its request). It is a factual "SYSTEM NOTICE (from
  the ultracodex runner, not the user)": the previous turn was stopped by the system before it was finished, why (the ChatGPT account was
  switched / the usage limit was reached and has now reset / …), that nothing in the request has changed and it is NOT complete, the request
  it was working on (the interrupted turn's input: the original task, or the follow-up message; clipped to 8000 characters), and the
  instructions to look at what is done, not repeat completed commands, edits or external actions, do the remaining steps and give the final
  answer the request asks for. The checkpoint fallback's own prompt carries the same notice.
- **PrimerSwitch: running work follows an account switch within seconds** (at the next step boundary; running commands are never stopped;
  `followAccountSwitch: false` to opt out). Until now a turn or an attempt that was running when the owner switched ChatGPT accounts
  went on, on the old account, until it finished or failed. Now, while it runs, the supervisor compares the managed account with the
  one it started on every `ULTRACODEX_ACCOUNT_CHECK_MS` (2 s). On a change it waits for a step boundary — no command, file change, MCP or
  dynamic tool call or web search in flight (a pending `ask_orchestrator` question counts), never interrupting one — then interrupts
  the turn (a session: `turn/interrupt`, then a new app-server, `thread/resume`, the hermetic check and the continuation prompt, announced
  as `resumed {reason: "account_change"}`; the interrupted part is turn n's `turns/<n>.json` with kind `account_switch`, not a result and
  not a `turn_done` line) or stops the attempt (a one-shot `codex exec`: the normal teardown, then `exec resume` of the same thread with the
  sandbox restated, no wait). It counts in the 8-handoff budget and the job's deadline, and rejected encrypted reasoning takes the
  checkpoint fallback. A message sent during a session's handoff is held back and steers the continuation. Not followed (and the run
  finishes on the old account, with a log line saying why): `followAccountSwitch: false` (request field, allowed in relayed requests;
  default true, `ULTRACODEX_FOLLOW_ACCOUNT_SWITCH=0` flips the default), an ephemeral run, no thread id yet, a review run (resuming an
  `exec review` thread is not supported), the budget used up, too little work time left; a stop whose teardown cannot be verified is not
  resumed and ends with an `account_switch` failure that says so. A missing or unreadable login and a token refresh on the same account are
  not switches. The decision is judged when the switch is seen and again at the boundary itself (the step may have used up the work time; a
  pending handoff whose account is back, A -> B -> A, is cancelled), the stream of a one-shot attempt is read completely before a boundary is
  declared (never with a line unread), and a session turn's pending handoff keeps watching the account. New session event
  `account_switch {status: pending | cancelled | interrupting | not_followed}`; `notify` prints nothing for the
  handed-over part. Test-only: `ULTRACODEX_TEST_ACCOUNT_IDENTITY_FILE` makes the text of a file the managed account, so the mechanics can be
  checked live without touching the real `auth.json`.
- **Safety: an idle session sleeps as soon as the account changes.** An idle session kept its `codex app-server` for `idleTtlSec` (20 min) and never
  looked at the managed account again; a Codex process that refreshes its tokens after the owner switched ChatGPT accounts merges the old
  account's tokens into the new `auth.json` and corrupts the login. Now an idle session (no turn, nothing queued) compares the managed account
  with the one its app-server started with every ~2 s (`ULTRACODEX_ACCOUNT_CHECK_MS`) — and right after a turn, before it would idle — and on a
  change goes dormant at once (`dormant {reason:"account_change"}`, nothing left running); the next `send` resumes the thread on the new
  account as usual. A missing or unreadable login is not a switch, a token refresh on the same account is not one, a running turn is never
  stopped for one, and an ephemeral session ends as it does when its idle time is up.
- **Fix: two supervisors for one revived session.** Two senders reviving a dormant session start two supervisors; both judged the dead
  supervisor's `supervisor.lock` stale and the second one's removal took the first one's new lock, so both believed they held it (measured:
  most of the time when they start together). One noticed at its next beat, but its driver — which starts seconds later, after the Windows
  Job Object helper — still published its stale state when it began, which could land after the winner's last write and leave the session
  `queued` with `wait` never returning its result. Taking over a stale lock is now exclusive (a `supervisor.lock.takeover` marker, and the
  lock is re-checked under it), and a supervisor that lost the lock writes nothing to the session.
- Skills: `codex-steer` leads with the tools (CLI as the fallback) and documents the three notification tiers;
  `codex-implement` and `codex-ask` mention the tools and `notify`. README: tools table, notification tiers, the
  channel launch command, the `mcp__plugin_ultracodex_ultracodex__*` permission entry, the cost note.

## 0.4.0 — 2026-10-09 (sessions)

Claude can talk to a running Codex job. Opt-in, for direct runs only (`codex-implement`, `codex-ask`); Workflow
nodes and the relay path are untouched, and the one-shot behaviour of 0.3.9 is unchanged.

- **Steerable sessions.** `"session": true` makes the supervisor drive a private
  `codex app-server --listen stdio://` (JSON-RPC 2.0 over stdio, new module `scripts/session.mjs`) instead of
  `codex exec`. One session = one Codex thread. New commands: `send RUN (--message TEXT | --message-file FILE)
  [--mode auto|steer|queue]` (steer the running turn — Codex reads it at its next step boundary — start a
  follow-up turn on the same thread, or queue one), `interrupt RUN`, `answer RUN QUESTION_ID (--text|--file)`,
  `events RUN [--since SEQ] [--follow] [--max-wait SEC]` (the compact event feed, built for Claude Code's Monitor
  tool) and `close RUN [--force] [--archive]`; `result RUN --turn N`, `status`, `wait` and `gc` know sessions.
  New request fields: `session`, `idleTtlSec` (default 1200), `askOrchestrator` (default true), `askTimeoutSec`
  (default 1800). `timeoutSec` is the deadline of each turn. A relayed (framed) request with `session` is
  refused, as are `review` and `profile` with it.
- **State model.** `queued` → `running` → `idle` (app-server up for `idleTtlSec`) → `dormant` (no process; the
  thread is on disk) → revived by the next `send` — a new supervisor resumes the thread with the requested
  sandbox, also after a reboot — until `close`. `result.json` only exists once a session ended for good
  (closed, cancelled, failed, hermetic violation); each turn's signed envelope is `turns/<n>.json` and `wait`
  returns the latest as soon as the session is idle, or at once when a question is waiting. One supervisor per
  session (an exclusive `supervisor.lock`).
- **`ask_orchestrator`.** Codex gets a client-side tool to ask the orchestrating agent a question; the call is a
  `question` event, `wait` / `events --follow` return early, and it stays blocked until `answer` or an automatic
  "proceed with your best judgement" after `askTimeoutSec`.
- **Phase 1 inside sessions.** The usage-limit wait, account handoff (the app-server is restarted on the new
  account, the thread resumed and continued), checkpoint fallback, spacing and eight-continuation budget apply to
  a session's turns; limit waits no longer hold a slot, and `close` / `interrupt` / `cancel` act during one. Slots
  are held only while a turn runs. `onOrphan` applies while a turn runs; an idle session is never abandoned.
- **Event feed** (`events.jsonl`): `session_started`, `turn_started`, `message`, `command_started`, `command`,
  `file_change` (relative paths, no diffs), `plan`, `tool`, `question`, `answer`, `steer`, `followup`, `interrupt`,
  `error`, `turn_completed`, `limit_wait`, `resumed`, `idle`, `dormant`, `closed`, `cancelled`,
  `hermetic_violation`; `seq` strictly increasing across revives. Reasoning, auth data and account ids are never
  written; past 8 MB only structural events are kept.
- **Hermetic sessions fail closed.** `codex app-server` has no `--ignore-user-config`, so the spawn disables
  plugins, apps, notify and every MCP server the user's config declares, and after `thread/start|resume` the
  runner asks `mcpServerStatus/list`: a server that still reports tools (or a list that cannot be read) stops the
  app-server and ends the run as `hermetic_violation` before any turn.
- **Security.** A writable request (session or not) whose `cwd` or any `addDirs` entry contains, or lies inside, the
  runner's home (`~/.ultracodex`, links resolved) is refused: a Codex job must never write its own inbox. The relay
  guard is unchanged and gives relays and readers none of the session commands.
- Skills: new `codex-steer` (the command reference and the etiquette); `codex-implement` starts as a session and
  follows up with `send`; `codex-ask` mentions `session: true` for multi-turn questions.
- New failure kinds: `interrupted` (a turn interrupted on request), `context` (`contextWindowExceeded`),
  `hermetic_violation`.

## 0.3.9 — 2026-10-09 (limits)

Stop losing Codex work at usage limits.

- **A resume keeps the sandbox it was asked for.** `codex exec resume` without
  `-c sandbox_mode=…` runs read-only even when the original session was writable ("the current
  filesystem sandbox is read-only"; measured on codex-cli 0.163.0-alpha.2), and a previous
  writable resume does not stick. Every resume now restates the request's sandbox — for
  workspace-write also `network_access` and `writable_roots` (= `addDirs`) — whether it is a
  follow-up (`"resume": {...}`) or a continuation after an account change or a limit reset. A
  follow-up that must write now says `"sandbox": "workspace-write"` (documented in the
  `codex-implement` skill).
- **A usage-limited job waits for the limit to reset, not only for an account switch.** After a
  `usage_limit` (same preconditions as before: durable thread, managed ChatGPT account, clean
  teardown, under the eight-continuation budget) the supervisor enters a limit wait of up to
  `limitWaitSec` (integer 0–691200, default 86400; env `ULTRACODEX_LIMIT_WAIT_SEC`; 0 = the old
  15-minute account wait only) that ends when the managed account changes (the existing
  handoff, encrypted-reasoning fallback included) or when usage is allowed again on the same
  account, then resumes the same thread. "Allowed again" is read from a rate-limit probe: a
  short-lived `codex app-server --listen stdio://` (exported `probeRateLimits`) that gets
  `initialize`, `initialized` and `account/rateLimits/read` and nothing else — no model turn,
  no MCP servers, no usage — is closed through its stdin and killed only if it lingers.
  `ordinaryUsageAllowed: true` resumes, `false` keeps waiting, and with no verdict (`null`, or
  a failed probe) the latest known reset time plus 60 s stands in. The probe runs on entering
  the wait, then at most every 5 minutes (`ULTRACODEX_LIMIT_PROBE_MS`) and once 30 s after the
  expected reset. Only the verdict, percentages and reset times are kept or logged — never
  account or credit ids. A resume that hits the limit again is spaced out ("out of credits" is a
  `usage_limit` the verdict may still call allowed): from a run's second limit wait on, a
  resume waits at least 5, 10, 20, 40… minutes (`ULTRACODEX_LIMIT_PROBE_MS` × 2^(k−1), never
  beyond the cap) after the wait began; account changes are never deferred.
- Waiting does not use up the job's deadline (account wait included): the deadline moves by the
  time waited, so the continuation gets the work time the interrupted attempt had left.
  Reset-resumes and account handoffs share the eight-continuation budget and are reported
  separately in provenance (`accountHandoffs`, `limitResumes`, plus `limitWaitedSec`).
- While waiting, `status` and `wait` report `backoff` (relays keep polling) with
  `waitingForAccount: true`, `waitingForLimit: true`, `resumesAt` (the latest reset among the
  used-up windows of the `codex` limit, else the earliest known; null until a probe learned it)
  and `limitWaitUntil` (when the wait gives up). `codexNode` takes a `limitWaitSec` option.
- **An orphaned run is no longer torn down by default.** New `onOrphan: "finish" | "stop"`,
  default `finish`: a run nobody polls keeps going — a queued run still starts, a running attempt
  runs to its result or deadline, a limit wait continues — and `status` / `wait` show
  `orphaned: true` (state records `orphanedSince`) until a poll returns. A Claude session that
  hit its own usage limit stops polling; the old rule then killed Codex work that was already
  paid for, and a resumed workflow joined the dead run and got `abandoned`. A resumed workflow's
  re-upload of the same signed request now joins the live run and gets its result. `"stop"`
  restores the old behaviour. New `node codex-node.mjs cancel --orphaned` cancels every
  unfinished run whose caller stopped polling for its `orphanAfterSec` (the cleanup after
  stopping a workflow on purpose).
- The relay now polls with `wait <runId> --max-wait 570` under a 600 s Bash timeout (was ~110 s):
  about a fifth of the polling turns during long waits. `wait` already refreshed the heartbeat every
  poll while blocking. The relay guard accepts `--max-wait` up to 600.

## 0.3.8 — 2026-10-08 (Haiku 5.5)

- `codex-review` triage runs on Claude Haiku 5.5 at `high` effort by default; `triageModel`
  (`haiku` | `sonnet` | `opus` | `inherit` — Claude Code's default for workflow agents: the
  session's model, or `CLAUDE_CODE_SUBAGENT_MODEL` when set) and `triageEffort` override it, and the result
  reports what ran (`triage: { model, effort }`). Measured on 249 recorded triage cases
  replayed at their reviewed commits, every disagreement judged blind by astra@max: Haiku 5.5
  missed 1 real defect (low), Sonnet 5.5 missed 4, the original Opus 5.5 triage 11. Haiku leans
  towards confirming and towards higher severity (stricter ship verdicts, never looser);
  `high` behaved like `max` at about 1/15 of the cost and 1/8 of the time. The astra tiebreak
  for doubted high/critical findings is unchanged.
- The key agent (`codex-key`: `key`, `expect`) runs on Haiku: every call succeeded in the
  relay benchmark, at about 1/19 of the Sonnet cost; the Opus retry stays. Job relays stay
  on Sonnet — Haiku needed the Opus retry on 3 of 16 uploads.
- Direct runs (`codex-ask`, `codex-implement`) default to `orphanAfterSec` 1800 instead of
  300, so a background `wait` that Claude Code stops (memory pressure) can be restarted
  before the run is torn down. Workflow relays keep sending 900.
- Documented a known limit: very large paged results (~60 000 characters) failed to come
  back through every relay model; read them from `result.json` in the main conversation.

## 0.3.7 — 2026-10-05 (PrimerSwitch compatibility)

- Keep Codex thread history by default so quota-limited jobs can continue after
  PrimerSwitch changes the selected ChatGPT account. Resume the exact thread
  under the same run id, request authentication, schema and sandbox constraints.
- Wait up to 15 minutes for a changed account, within the original job deadline;
  preserve cancellation, orphan cleanup and bounded handoffs. Running tool
  commands are never stopped just because an account changed.
- Keep existing Claude relays polling through the compatible `backoff` state.
  Already-launched durable 0.3.6 jobs can be adopted once after their supervisor
  exits with a quota error, if their deadline and caller heartbeat remain valid.
- If cross-account resumption rejects encrypted reasoning, continue once per
  handoff from bounded visible messages and completed tool records in a fresh
  thread. Leave the original rollout intact and exclude hidden reasoning/config.
- Explicit `ephemeral: true` opts out of history and account continuation. Native
  `codex exec` has no supported live account reload; recovery resumes a saved
  thread after a terminal quota/auth error, rather than moving an active request.

## 0.3.6 — 2026-10-01 (fork)

- Prefer `xhigh` for every GPT-6.1 Sol workload: verification, analysis, reviews and
  implementation, including complex code. Sol at `max` is an explicit exceptional
  override; Luna remains always at `max`, and Astra at `max` handles critical gates.
- Align workflow descriptions, relay labels, skills and model-policy guidance with
  the new defaults. Relay labels also follow explicit model overrides across tiers.

## 0.3.5 — 2026-09-30 (fork)

- Route implementation, including complex modules, debugging and design analysis to
  Sol 6.1 by default. Reserve Astra for security, final critical review and concrete
  unresolved issues escalated from Sol; explicit owner-selected tiers still override.
- `codex-review` without an explicit tier now uses Astra for the security lens and
  Sol 6.1 for ordinary lenses. Results and the report name each lens's actual tier and
  model, including failed lenses. Only non-Astra findings can need an Astra tiebreak;
  `fast: true` continues to apply only to Astra nodes.
- Document the benchmark evidence behind this routing in the central model policy.

## 0.3.4 — 2026-09-30 (fork)

- Upgrade the `daily` tier from `gpt-6-sol` to `gpt-6.1-sol` across the runner,
  workflow helper, skills, references and generated workflows. Keep `xhigh` for
  verification and `max` for ask, review and implementation.
- Workflow relay labels identify GPT-6.1 Sol explicitly. Luna and Astra keep their
  existing roles; explicitly selected older Sol models remain supported.

## 0.3.3 — 2026-09-24 (fork)

- Workflow panel labels name what each agent is: `relay → key`, `relay → announce <node>`,
  `relay → <node> (sol@max)` — Claude (Sonnet) relays that carry the job to Codex, labelled
  with the Codex model and effort that do the actual work.

## 0.3.2 — 2026-09-24 (fork)

- `codex-review` picks the tier itself when the owner names none, from the measured diff:
  **final** (astra) for security, auth, money, concurrency, migrations, irreversible effects or
  the last gate before merge/deploy; else **light** (luna) for small (about 50 lines, at most 3
  files) or mechanical changes; else **daily** (sol). The pick is stated in one line so the
  owner can override it.

## 0.3.1 — 2026-09-24 (fork)

- `codex-review`: Claude's triage also rates each finding's **severity** itself — Codex tends
  to rate findings above their real impact. It judges impact × likelihood under the owner's
  context: lower when the failure needs conditions that practically never occur, is caught or
  harmless, or an existing control covers it; kept or raised when someone the threat model
  includes can trigger it at will. The report ranks by, and the ship verdict follows, Claude's
  rating ("do not ship" only for a confirmed, disputed or unresolved critical/high; "ship
  after fixes" when the worst is medium); Codex's rating stays beside it (`codexSeverity`) and
  every change is listed with its reason (`severityChanges`). The astra tiebreak still keys on
  Codex's severity, so a high/critical finding Claude refutes is always settled. The skill's
  by-hand path follows the same rule.

## 0.3.0 — 2026-09-23 (fork)

Merged upstream KingGyuSuh/ultracodex v0.1.3 and rebuilt the Codex path around a Node runner.

**New**
- `scripts/codex-node.mjs` runner: `start` / `part` / `wait` / `status` / `result` / `cancel` /
  `preflight` / `dry-run` / `policy` / `models` / `schema` / `schema-check` / `gc`. A detached
  supervisor owns each Codex run: per-attempt deadline (model × effort × kind), process-tree
  teardown (identity-checked `taskkill /F` on Windows, process group on POSIX) of only the tree it started,
  transient-error retries with backoff, machine-wide weighted slots
  (`ULTRACODEX_MAX_CONCURRENT`, default 4), heartbeat-based cleanup of abandoned runs, and one
  fail-closed JSON envelope with provenance (thread id, model, effort, token usage).
- GPT-6 routing policy: `light` → gpt-6-luna@max, `daily` → gpt-6-sol (xhigh for verify
  fan-outs, max otherwise), `final` → gpt-6-astra@max; `ultra` only when asked; catalog-checked
  models and efforts (luna+ultra is refused — the CLI silently accepts it).
- Strict-schema check before a run (the nested-`required` 400 is caught locally) and schema
  presets `verdict`, `score`, `review`, `implement`.
- Hermetic runs by default (`--ignore-user-config`, Windows sandbox carried over): the user's
  MCP servers are not loaded into verifiers.
- `codex exec review` and `codex exec resume` modes.
- Plugin workflows `ultracodex:cross-review`, `ultracodex:codex-review`, `ultracodex:crosscheck`,
  `ultracodex:judge-panel`; plugin agent `ultracodex:codex-relay`; skills `codex-review` and
  `codex-implement`.
- Relay transport that survives the Windows Bash tool: percent-encoded frames (no quotes,
  backslashes or control characters), small parts with per-part hashes, whole-frame hashes,
  retry with a stronger relay, collector for relays that stop early.
- Offline test suite (fake Codex CLI, stubbed Workflow runtime) and a build step that generates
  the shipped workflows and the helper doc from one source.

**From upstream v0.1.3, re-implemented on the runner**: long runs never block a Bash call;
deadlines (upstream: 20/30 min; here per model × effort × kind); process-tree teardown (now
also on Windows, where upstream's `pgrep` / `ps -o` teardown cannot work); cross-family jury
rule; runners-up content passed to synthesis; partial Codex errors never close a
loop-until-dry.

**Changed**: GPT-5.6 guidance replaced by GPT-6; manifest and marketplace point at this fork.

**Hardened after a final-gate review** (gpt-6-astra@max through the plugin's own
`codex-review` workflow — code, domain and security lenses — plus an independent Claude
review):
- relay guard hook: the relay agent may run only the runner's `part`/`wait` commands;
- no `--codex-path` CLI option; `taskkill` by absolute path; supervisors never run in the
  reviewed repository's directory;
- relayed requests are read-only and hermetic and must carry all their hashes; results carry
  `resultHash` and are bound to the request's `taskHash`;
- nothing vanishes: rejected relay/finder/triage/generation calls are failures, and the
  workflows reconcile every requested dimension, lens, finding and candidate;
- ambiguous batch answers are unverified; writing tasks are never retried automatically;
- owner-fenced slot leases with atomic reclaim; cancellation checked before slots and before
  every spawn; awaited process-tree teardown; runner-allocated upload ids; suspend-aware
  deadlines and heartbeats.

**Round 3 — authenticity, large results, cost**
- Signed results: `mac` = HMAC-SHA256 under a per-machine key (`~/.ultracodex/key`) over the run
  id, the SHA-256 of the task and the body. The helper (pure-JS SHA-256/HMAC, checked against
  `node:crypto`) fetches the key once per workflow through a relay that sees no untrusted text
  and refuses unsigned results; the relay guard fixes each relay's role, so a relay that saw a
  job can never read the key. New runner commands `key` and `page`.
- Paged results: above 24 KB, `wait`/`result` print a compact envelope and `page RUN K` serves
  10 KB slices (the Bash tool only previews output over 30 KB). Page data is percent-encoded
  (no quote or backslash to mis-copy) and hashed per page; the helper keeps verified pages
  across re-collects, stitches and re-verifies them. From the conversation the result file
  is simply read.
- Windows teardown by identity (PID + creation time): no `taskkill /T` (it trusts reused
  parent PIDs), tracked descendants that detached from the tree, children started during the
  teardown, survivors reported; leftovers of a normal exit reaped.
- Slot leases fenced by generation (`slot-N/lease-<runId>/`), staleness counted in the
  reclaimer's own polls, renewal that heals after a mistaken reclaim, and renames retried
  through Windows scanner locks (measured ~1 % `EPERM`) — which also fixes an upload claim that
  could fail a node as `upload_busy`.
- Cost: `cross-review` sends only the confirmed high/critical findings to one astra@max run
  (`finalGate`), `codex-review` sends only high/critical Claude-vs-Codex disagreements to astra
  (`escalate`); astra disagreements are reported as *disputed*. Batches scale their deadline
  (`workItems`); every shipped workflow returns `codexUsage` (runs, failed runs, tokens per model,
  all attempts). New skill `codex-ask` for direct, relay-free questions.
- Positional finding ids in both reviews (model-chosen ids could collide); run ids from relay
  replies are validated before they reach another relay's prompt; workflow nodes get a 15-minute
  orphan window; the user's Windows sandbox is read from any TOML form of `[windows]`.

**Round 4 — after the astra@max final gate of round 3** (code + security lenses: 21 findings,
20 confirmed by Claude triage, "do not ship"):
- Windows teardown on a **Job Object**: the supervisor joins a fresh job before it spawns
  Codex, and stopping terminates exactly the job's members through handles checked to be in
  the job — an orphan whose parent exited is stopped too, and no PID lookup can reach another
  session's process. Fallback without a job: kills only through handles pinned before the
  identity check, attributes children only through pinned parents, reports what it cannot
  prove (`possibleLeftovers`) instead of killing it. The dead-parent ancestry inference and
  bare-PID `taskkill` are gone. `preflight` reports `windowsJob`.
- **Signed requests**: the helper signs every request (`rmac` over the exact header — model,
  effort, tier, cwd, schema preset, nonce — the schema and the task); the runner starts no
  relayed job without it, and each nonce starts one run. This closes the path where a hijacked
  relay started a job of its own asking Codex to read the key and sign a forgery, and the
  schema/model/cwd swaps behind public checksums.
- Results are signed over the run, the full request digest and the payload kind: no replay of
  an older run of the same task, no result/text type confusion returning unsigned text.
- The key comes from a separate `ultracodex:codex-key` agent type; the guard gives job relays
  no way to read it (roles are decided by agent type, not by a relay's first command).
- Fail closed: a failed escalation leaves contested findings unresolved (needs-info) and the
  review incomplete; a failed final gate marks cross-review incomplete; page counts are
  bounded before anything is allocated; a node can no longer throw into the workflow.
- Lease release and reclaim move only the caller's own (or the judged-stale) generation, never
  another owner's slot; the key is published atomically (temp file + hard link); supervisors
  never work inside the home; `fast: true` puts a workflow's astra nodes on the priority tier.

**Round 5 — after the astra@max final gate of round 4**:
- **Announced requests**: a signature alone no longer starts a job. Before each upload the
  helper announces the request's digest through the key agent (new runner command
  `expect DIGEST`); the runner starts a relayed job only for an announced digest
  (`unregistered_request`), consumes the announcement when the run starts and forgets unused
  ones after a day, and keeps nonce records 7 days (`gc`). A Codex job or a Claude stage that
  read the key — read-only still reads the whole disk — can therefore no longer start an
  auxiliary job with it. A failed announcement fails the node (`register_failed`) before any
  relay sees the request.
- **Confined readers**: new agent type `ultracodex:codex-reader` (Read, Grep, Glob, and Bash
  restricted by the guard to one read-only git command) for every shipped Claude stage that
  reads reviewed code — cross-review finders and synthesis, codex-review triage and report,
  judge-panel generators, Claude jurors and synthesis. The guard now judges four classes by
  agent type: job relay, key agent (`key`, `expect`), reader, and every other subagent (only
  the runner's `key` and `expect` are refused to them). The reader's git is checked word by
  word as bash will pass it, against three ways measured on git 2.55 to run a program through
  read-only git: bundled `-nO<cmd>`, abbreviated `--open-files=<cmd>`, and git inside an
  embedded bare repository loading its `config` (`core.fsmonitor`) — `-C` must land on a
  directory containing `.git`. Unquoted globs and network paths (NTLM) are refused too.
- Windows teardown: process creation times (FILETIMEs, beyond a double's 2^53) are compared as
  exact 64-bit integers — a PID reused within the same ~1.6 µs rounding step could otherwise
  pass the identity check; the Job Object sweep repeats until a round finds no member (up to 8), so a
  process spawned during teardown is not missed; the fallback reports survivors from the final
  process table, not from the first attempt.
- Slots: an old empty slot directory is taken by removing it while empty, never by moving it
  (a move could carry off a lease created meanwhile); two leases that land in one slot are
  resolved by run id (the larger backs out) and the one that stays reports the slot as lost.
- A key file that exists but is not a key (an interrupted older runner) is never replaced
  automatically — two repairers could hand out different keys; `key_invalid` names the file
  to delete.
- Tests: 112 offline tests, including replayed frames, unannounced frames, exact FILETIMEs,
  double-booked slots, the reader allowlist and each measured git bypass.

**Round 6 — after the astra@max final gate of round 5** (code + security lenses: all seven
round-4 findings confirmed fixed; six new findings, one high):
- Reader: `git -C hop/..` passed the check on POSIX, where the kernel follows a committed
  symlink `hop` before `..` (a text normalisation does not). `..` is now refused in `-C`, and
  the guard mirrors git's upward discovery both as written and with links resolved — git
  walks up the physical path, measured on Windows through a junction into an embedded bare
  repository's `refs/`, where it ran that repository's `core.fsmonitor`. This also lets `-C`
  name a directory inside a repository (monorepo packages), not only its root.
- Slots are **born whole**: a taker prepares `.claim-<run>/lease-<run>/owner.json` and renames
  it to `slot-N`, which fails while `slot-N` exists. A slot someone owns is never empty, so an
  empty directory is never a live lease, and two takers can no longer both own a freed slot
  (the tie-break by run id, which a late smaller id defeated, is gone). A generation given
  back after a mistaken reclaim is reborn the same way, only into a slot nobody took since.
- Stale pre-0.3 debris (a corrupt `owner.json`, leftover temp files) is deleted file by file
  instead of blocking its slot forever; unknown content is left alone. `gc` frees slots only
  through the same fenced path (it used to delete whole slot directories after a check).
- Job Object teardown sweeps until a snapshot holds nothing but the supervisor — a member
  that started a child and exited before it could be opened no longer ends the sweep early.
- Fallback teardown: the kill script names every process it targets by PID and creation
  time, including descendants found during its rounds, and all of them are reconciled
  against the final process table — a late survivor is reported, never dropped.
- A duplicate upload that loses a race with the winner of the same request now joins the
  winner's run (it looks for the nonce record again, `ULTRACODEX_NONCE_WAIT_MS`) instead of
  failing as `unregistered_request` or `execution`.
- Relay transport: the first run of the round-6 gate failed both lenses — every relay (Sonnet,
  and Opus on retry: five copies, byte-identical) uploaded part 2 with part 3's lines after it,
  where a long line was cut mid-sentence at the part boundary. Reproduced with real relays
  and the fake Codex; the runner now keeps the prefix of a part's lines that matches its hash
  (the rest is the next part, sent next anyway; the assembled frame is verified as a whole),
  which made the same upload go through. Part markers also state their line count (a hint:
  it did not stop the over-copy by itself).
- Claude stages are told where the repository is (`ucxWhere(cwd)`): they work in the session's
  directory, and a report stage without it ran git there instead.
- Tests: 119 offline tests, including a two-process slot race with a late claim, a junction
  into an embedded bare repository, legacy slot debris, a late-winner upload race and a part
  copied with the next part's lines.

**Round 7 — after the astra@max final gate of round 6** (all six round-5 findings fixed or
narrowed; five new findings in the new code, two high):
- Reader guard fails closed: a `-C` start that cannot be resolved is refused (it used to be
  allowed), on Windows `-C` must be a native path (Git Bash rewrites POSIX-style arguments
  before git sees them), and any directory with a `HEAD` entry found before a `.git` counts as
  a repository of its own (git needs no local `objects`/`refs` when `commondir` points
  elsewhere).
- Slot give-back: a renewed owner's generation goes straight back into its slot directory,
  which stays in place (fresh, so no taker touches it). Known limit (final gate of round 7):
  a reclaimer or claimant stalled past the stale window at one exact moment can still end with
  two generations in one slot; both owners then report the slot as lost, so the cap is
  exceeded by one run, visibly.
- Fallback teardown: processes the kill script found but never reached before its round cap
  are reported (`pending`) and reconciled; every identity it found joins the tracked set, so
  a child started by one of them is reported; a capped sweep is never reported clean. The
  reconciliation is a pure function now, unit-tested on synthetic tables.
- Part prefix matching is one linear pass, and parts beyond 16 KB are refused unscanned
  (rejected copies are kept bounded).
- Every reader git command must start with `git -c safe.bareRepository=explicit`, so git
  itself refuses a repository it would only have found implicitly (measured: all three
  layouts the gates found are refused, a real repository and a linked worktree still work;
  command-line configuration is protected, no repository can switch it off). The guard's
  discovery check stays as a second line of defence.
- After the final gate of round 7 ("ship after fixes"): the fallback kill script also names
  every identity it set aside (`dropped`), and the reconciliation reports it — as a survivor
  if it is still there, and as the parent of possible leftovers.
- Tests: 122 offline tests.

## 0.2.1 — 2026-07-10 (fork)

Correctness fixes from a cross-model review; runtime self-test.

## 0.2.0 — 2026-07-10 (fork)

Stability hardening of the codexNode helper: salted heredoc delimiters, POSIX-quoted flags,
validated options, intrinsic ≤4 concurrency gate, structured `_codex_error{kind}` with
classified retries, fail-closed templates.

## Upstream

0.1.0–0.1.3 by KingGyuSuh — see https://github.com/KingGyuSuh/ultracodex.
