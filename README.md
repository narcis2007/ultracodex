# Ultracodex

> Claude orchestrates. Codex (GPT-6) cross-checks — and, when asked, implements.

A Claude Code plugin that puts OpenAI's Codex CLI (`codex exec`) to work inside Claude Code:
as an independent **verifier / juror / second opinion** in Workflow orchestration, as an
**adversarial reviewer** of a change, and as an **implementer** in an isolated worktree whose
work Claude then verifies. A second model family catches correlated failures that more Claude
agents cannot.

This is a fork of [KingGyuSuh/ultracodex](https://github.com/KingGyuSuh/ultracodex)
(Apache-2.0), rebuilt around a tested Node runner. Upstream v0.1.3 is merged into the history;
see [CHANGELOG.md](CHANGELOG.md) for what changed.

## What you get

| Component | What it is |
| --- | --- |
| Workflow `ultracodex:cross-review` | Claude finders per dimension → Codex (sol@xhigh, batched) refutes each finding against the code → one astra@max run re-checks the confirmed high/critical ones → report. Fails closed. |
| Workflow `ultracodex:codex-review` | Codex reviews through lenses (code, domain, security, tests, performance) → Claude checks every finding in the code → high/critical disagreements settled by astra in one run → report. |
| Workflow `ultracodex:crosscheck` | One Codex (astra@max) attempt to refute a load-bearing claim. |
| Workflow `ultracodex:judge-panel` | Claude angles + a Codex candidate, a Claude+Codex jury, cross-family ranking, synthesis. |
| Skill `codex-ask` | One question or claim from the conversation, straight to the runner (no relay — the cheapest way to consult Codex). |
| Skill `codex-workflow` | Modes and cost levers; how to blend Codex nodes into custom Workflow scripts (the `codexNode` helper). |
| Skill `codex-review` | Standalone adversarial review of a branch / commit / uncommitted change, with triage. |
| Skill `codex-implement` | Delegate implementation to Codex in a worktree, verify, iterate, review. |
| Skill `codex-steer` | Talk to a running Codex session — or steer / stop a running Workflow node: steer it, send follow-ups, see what it does, answer its questions, close it. |
| Agent `codex-relay` | Internal: the Bash-only relay that runs one Codex job for a Workflow node. |
| Agent `codex-key` | Internal: fetches the runner key and a nonce once per workflow, and announces each request to the runner (no task text in its prompt). |
| Agent `codex-reader` | Internal: the confined type for Claude stages that read reviewed code — Read, Grep, Glob and read-only git. |
| MCP server `scripts/mcp-server.mjs` | Codex sessions as native Claude Code tools (`codex_start`, `codex_send`, `codex_answer`, …) and an optional channel that pushes "Codex asks …" / "finished turn N" into the conversation. |
| Plugin monitors + hooks | `notify --forever` started by the codex skills (events without polling); a `SessionStart` hook that tells each run which Claude session started it. |
| Runner `scripts/codex-node.mjs` (+ `session.mjs`, `notify.mjs`) | Validates requests, runs `codex exec` — or, for a steerable session, a private `codex app-server` — under a detached supervisor with deadlines, process-tree teardown, retries, machine-wide slots and a provenance envelope. |

## Model policy — astra, sol, terra

| Tier | Model | For | Effort |
| --- | --- | --- | --- |
| `light` | gpt-6.1-terra | light work: quick review or verification passes, triage, dedupe, wide fan-outs of small checks | `xhigh` for every workload |
| `daily` | gpt-6.1-sol | implementation including complex code, debugging, architecture analysis, verification, jurors, routine review | `xhigh` for every workload |
| `final` | gpt-6-astra | critical security work, data migrations, irreversible production steps, production release gates, high/critical issues escalated from Sol | `max` |

Sol 6.1 is the default for implementation, including complex modules, and routine reviews and
asks. Astra is for critical work only: security-sensitive code (auth, keys, crypto, payments,
personal data), data migrations, irreversible production steps and the last gate before a
production release. In `codex-review`, omitting `tier` uses Sol at `xhigh` on every lens,
including `security`. For critical work, pass `securityTier: 'final'` for Astra on security only,
or `tier: 'final'` for every lens. `securityTier` accepts `light`, `daily` or `final`; invalid
values are ignored. An explicit `tier` overrides it. Actual routing is reported in
`lenses[].tier` and `lenses[].model`, and Astra findings are not sent to Astra again for a tiebreak.

Prefer Sol 6.1 at `xhigh`, including complex and long tasks. Use Sol at `max` only with an
explicit effort override for an exceptional unresolved problem or at the owner's request;
state the reason. Astra at `max` remains reserved for critical work.
The light tier moved from luna@max to terra@xhigh on 2026-10-27: on 10 replayed review jobs with 12
known medium-or-worse defects, luna@max found 2, terra@xhigh 5 ($0.12 a run, ~80 s), terra@max 10
($0.49, ~7.5 min, as costly as sol@xhigh, which found 4). Small sample, noisy. Luna stays usable as
an explicit `model: 'gpt-6-luna', effort: 'max'` for mechanical, high-volume work. `ultra` only on
explicit request, once per run. Details:
[model-policy.md](plugins/ultracodex/skills/codex-workflow/references/model-policy.md).

Cost, in short: ask directly (`codex-ask`) when one answer is enough; batch small items into
one run; let sol verify broadly and astra re-check only what would block a merge (the shipped
reviews do this by default and report any astra disagreement as *disputed*); every shipped
workflow returns `codexUsage` — runs and tokens per model.

## Requirements

- Claude Code with dynamic workflows (tested on 2.1.280)
- Codex CLI, logged in (`codex login`; tested on 0.156.1; sessions drive `codex app-server`, tested on 0.163.0-alpha.2)
- Node.js 18+

## Usage limits and account switching

Jobs retain their Codex thread history by default. If a ChatGPT job reaches a
usage limit, the supervisor waits — by default up to 24 hours (`limitWaitSec`,
0 to 8 days; 0 keeps only the 15-minute account wait) — for either of two things,
whichever comes first, then runs `codex exec resume` for that exact thread:

- the selected account changes (PrimerSwitch), or
- usage is allowed again on the same account. This is read from a short-lived
  `codex app-server` that only asks for the account's rate limits (no model call,
  no usage; at most every 5 minutes and once just after the expected reset). Codex's
  own verdict decides; only when it gives none does the reset time, plus a minute,
  stand in for it. A resume that hits the limit again is spaced out (5, 10, 20… minutes
  between resumes), so a limit the verdict does not reflect cannot burn the 8 continuations.

Claude keeps polling the same job and receives its original authenticated result.
The continuation's input is a factual system notice — the previous turn was stopped by the system before it
was finished, why (account switched, usage limit reset, ...), that the request is not complete — followed by
the request it interrupted (the original task, or the follow-up message; clipped to 8000 characters) and the
instruction to do the remaining steps without repeating completed ones; a bare "continue" let a model take
a handoff at a step boundary for the end of its work. The continuation keeps the original model, schema, directory, sandbox and network
permissions (a resume restates them on every call: `codex exec resume` alone
would run read-only). Time spent waiting does not count against the job's deadline.
While waiting, `status` and `wait` show `backoff` with `waitingForLimit: true`,
`resumesAt` (best estimate) and `limitWaitUntil`; the result's provenance counts
`accountHandoffs` and `limitResumes` (together at most 8 per job).

Cancellation still works while waiting.

**Running work follows an account switch.** Native `codex exec` and the app-server do not reload the
login of a running process, so the supervisor does it: while a turn (session) or an attempt (one-shot
run) runs, it compares the managed account with the one it started on every ~2 s
(`ULTRACODEX_ACCOUNT_CHECK_MS`). On a change it waits for the next **step boundary** — no command, file
change, MCP or dynamic tool call or web search in flight, and no `ask_orchestrator` question waiting;
a running command is never stopped — and then hands the work over: a session's turn is interrupted
(`turn/interrupt`), its app-server is replaced by one with the new login, the thread is resumed and the
continuation prompt runs as the next turn (`resumed {reason: "account_change"}`; the interrupted part keeps
its `turns/<n>.json` with kind `account_switch`, it is not a result for the caller); a one-shot attempt
is stopped with the usual teardown and `exec resume`d on the same thread, sandbox restated, with no
wait. Each handoff counts in the 8-handoff budget and the job's deadline; rejected encrypted reasoning
takes the checkpoint fallback below. A message sent to a session during its handoff is held back and
steers the continuation. `"followAccountSwitch": false` (a request field, also allowed in relayed
requests; `ULTRACODEX_FOLLOW_ACCOUNT_SWITCH=0` changes the default) keeps the old behaviour: the work
finishes on the old account. It is not followed either — the work finishes on the old account, with a
log line saying why — for an ephemeral run, a run whose thread id is not known yet, a review run
(resuming an `exec review` thread is not supported), a used-up budget or too little time left. A stop
whose process teardown cannot be verified is never resumed: the run ends with an `account_switch`
failure that says so. A missing or unreadable login, and a token refresh on the same account, are not
switches. An idle session sleeps (`dormant {reason: "account_change"}`) as soon as the account changes.
Explicit `ephemeral: true`, external API-key authentication, a missing saved
thread or an unverified process teardown prevent continuation (of a limit failure and of a followed switch alike). An already-polled
durable job from the installed 0.3.6 runner can be adopted once after a quota
failure; completed or abandoned jobs are left alone.

If the new account rejects the saved encrypted reasoning, the runner continues
in a fresh thread using visible messages and completed tool records from that
job. The original rollout stays intact. This fallback excludes hidden reasoning
and configuration, keeps the same permissions, and runs once per account
handoff. Bounded transcripts can omit older context; Codex must inspect current
work and request missing essential information instead of guessing.

## Orphaned runs

A run nobody polls any more (Claude hit its own usage limit, the session closed) is
**not** torn down by default: `onOrphan: "finish"` lets it run to its result or deadline
(a queued run still starts, a limit wait goes on), and a resumed workflow joins it
and gets the result. `status` and `wait` show `orphaned: true` while no poller is
seen. `onOrphan: "stop"` restores the old rule (`abandoned` after `orphanAfterSec`
without a poll). After stopping a workflow on purpose, `node scripts/codex-node.mjs
cancel --orphaned` cancels every unfinished run on this machine whose caller stopped polling.

## Sessions: steer a running Codex job

A one-shot run cannot be talked to. A **session** can: add `"session": true` to the request of a direct run
(`codex-implement`, `codex-ask`; a relayed request with `session` is refused — Workflow nodes are steerable differently, see "Steering a workflow node") and
the supervisor drives a private `codex app-server --listen stdio://` (JSON-RPC over stdio) instead of
`codex exec`. One session is one Codex thread; Claude can

- **steer** the running turn (`send`: Codex reads it at its next step boundary) or **queue** a message;
- send **follow-ups** after a turn — same thread, same context, no new run;
- **interrupt** a turn, read the **event feed** (`events RUN --follow`, built for Claude Code's Monitor tool),
  **answer questions** Codex asks through its client-side tool `ask_orchestrator`, and **close** the session.

In Claude Code the plugin's MCP tools do all of this without Bash (see "Native tools" below); the commands are the
fallback and what the tools run.

```bash
node scripts/codex-node.mjs start --request req.json        # {"session": true, "task": "…", …}
node scripts/codex-node.mjs events RUN --follow             # a line per event; ends on idle / question / dormant / ended
node scripts/codex-node.mjs send RUN --message "also handle the empty case"   # steer, follow up or queue (--mode)
node scripts/codex-node.mjs answer RUN QUESTION_ID --text "use Postgres"
node scripts/codex-node.mjs interrupt RUN
node scripts/codex-node.mjs close RUN [--force] [--archive]
```

**State.** `queued` → `running` (a turn) → `idle` (the app-server stays up for `idleTtlSec`, default 20 min)
→ `dormant` (no process at all; the thread is on disk) → the next `send` **revives** it transparently — a new
supervisor resumes the thread with the requested sandbox, also after a reboot — until `close`
(`closed`; `--archive` also archives the Codex thread). `result.json` exists only for a session that
ended for good (closed, cancelled, failed, a hermetic violation); each turn's signed envelope is
`turns/<n>.json`, and `wait` returns the latest one as soon as the session is idle (or a question is waiting).
An idle session also sleeps as soon as the managed ChatGPT account changes (checked every ~2 s, and right after a turn;
`dormant {reason: "account_change"}`, nothing left running): an app-server that kept the old login could merge its old
tokens into the new `auth.json` when it refreshes them. The next `send` resumes the thread on the new account.
`timeoutSec` is the deadline of **each turn**; the usage-limit wait, account handoff, spacing and budget of
the one-shot runs apply inside a session (the app-server is restarted on a new account, then the thread is
resumed and continued); orphan handling, slots (held only while a turn runs) and Job Object teardown are the
same.

**Questions.** With `askOrchestrator` (default on) the thread gets a client-side tool `ask_orchestrator`. A call
is a `question` event; `wait` and `events --follow` return at once and Codex is blocked until `answer` — or
until `askTimeoutSec` (default 1800) passes and it is told to proceed on its best judgement. The deadline keeps
running meanwhile.

**Safety.** Hermetic sessions (the default) disable every MCP server of `~/.codex/config.toml`, plugins and apps
(`app-server` has no `--ignore-user-config`) and then **verify** the isolation, before any turn and failing closed
(`hermetic_violation`): the app-server's own `config/read` says which layer every effective setting came from, and anything
from the user's or a project's config that could change what the model sees or can do (instructions, providers, profiles, shell
environment, hooks, other features, an enabled MCP server, …) stops the run before a thread starts — see "Verified isolation"
below — and `mcpServerStatus/list` must show that no MCP server reports a tool. A writable request whose `cwd` or `addDirs` contains or
lies inside the runner's home (`~/.ultracodex`) is refused: a Codex job must never write its own inbox. One
supervisor per session (an exclusive `supervisor.lock`); the relay guard still allows relays and readers only
their own commands, so none of `send`, `answer`, `interrupt`, `events`, `close` is available to them.

**Event feed** (`events.jsonl`, one compact object per line, `seq` strictly increasing for the session's life):
`session_started`, `turn_started`, `message`, `command_started`, `command`, `file_change` (relative paths, no diffs),
`plan`, `tool`, `question`, `answer`, `steer`, `followup`, `interrupt`, `error`, `turn_completed`, `limit_wait`, `resumed`, `account_switch`,
`idle`, `dormant`, `closed`, `cancelled`, `hermetic_violation`. Reasoning, auth data and account ids are never
written. Past 8 MB the file keeps only the structural events (no command / file / plan / tool / commentary events).
The skill `codex-steer` is the command reference; `codex-node.mjs help` lists the syntax.

### Native tools

The plugin declares a stdio MCP server (`plugin:ultracodex:ultracodex`, hand-written, no dependencies); Claude
Code starts one small node process per session, and Claude — and a subagent that inherits the conversation's
tools — calls Codex directly. Tool names are `mcp__plugin_ultracodex_ultracodex__<tool>`:

| Tool | Does |
| --- | --- |
| `codex_start` | Start a session (always `session: true`, never attached): `task` or `taskFile`, absolute `cwd`, `sandbox`, `tier`, `kind`, `model`, `effort`, `schemaPreset`, `label`, `network`, `addDirs`, `idleTtlSec`, `timeoutSec`, `limitWaitSec`, `askOrchestrator`. Only starts it: implementation work still follows the `codex-implement` skill. |
| `codex_sessions` | The sessions this Claude session started (`all`: everyone's), with the pending question, and which owner id the server uses. |
| `codex_send` | Steer the running turn, start a follow-up, or queue one (`mode`). |
| `codex_interrupt` | Stop the running turn now; the session stays open. |
| `codex_answer` | Answer a question Codex asked (it is blocked until then). |
| `codex_events` | The event feed after `since`: at most 200 per call, `truncated` + `lastSeq` to page, `waitSec` (≤ 300) to wait for the next one. |
| `codex_wait` | Return on a question, a finished turn or the end; otherwise after `waitSec` (≤ 600, default 300). |
| `codex_result` | The envelope of the latest turn, or of turn `turn`. |
| `codex_close` | End the session (`force` interrupts a running turn first, `archive` archives the thread). |

Every tool runs the runner CLI and returns its JSON line, so the two cannot drift apart; a refusal is an answer,
only a bad argument or a dead runner is a tool error. To avoid a permission prompt per call, allow the whole
server once: `mcp__plugin_ultracodex_ultracodex__*` in the `permissions.allow` of your Claude Code settings. The
relay, key and reader agents are restricted to Bash/Read/Grep/Glob by their frontmatter, so they never get these
tools.

### Notifications without polling

Claude should not poll a Codex session. Three tiers, from the most to the least widely available; the runner
records which Claude session started a run (`owner` in `status`; a `SessionStart` hook exports the session id as
`ULTRACODEX_OWNER`, with `CLAUDE_CODE_SESSION_ID` as the fallback), and every one of them speaks only for that
session's runs.

1. **`notify`**, for Claude Code's **Monitor** tool — works wherever Monitor does:
   `node scripts/codex-node.mjs notify [--owner ID | --all] [--max-wait SEC | --forever] [--from now|cursor]`.
   One compact JSON line per *actionable* event and nothing else: `question`, `turn_done`, `limit_wait` (once per usage-limit wait), `resumed`
   (after a limit reset or an account change), `error`, `ended`. Messages, commands, file changes, steers and idle
   are never reported. A cursor per owner (`~/.ultracodex/notify/<hash>.json`) makes a re-armed watcher continue
   where the last one stopped — nothing missed, nothing repeated — and a question still waiting is printed again.
   It ends after 29 minutes (`--max-wait`, to fit the Monitor tool's 30-minute cap): re-arm it. It writes no heartbeat.
2. **The plugin monitor** (`experimental.monitors` in `plugin.json`, an experimental Claude Code feature, interactive sessions only):
   the first time `codex-implement`, `codex-steer` or `codex-ask` runs, Claude Code starts `notify --forever` and
   its lines arrive as notifications. A per-owner lock keeps it to one process however many entries start it. If the
   monitor's environment does not name the session, the watcher says `notify_unavailable` and leaves; the Monitor
   recipe above is the fallback.
3. **The channel** (Claude Code *research preview*): the MCP server declares `claude/channel` and pushes
   "Codex session … asks: … — answer with codex_answer(…)" / "… finished turn 2 (ok): … — read it with codex_result
   or continue with codex_send" into the conversation as `<channel>` messages, which Claude answers with the tools.
   A plugin channel that is not on Anthropic's allowlist registers only when you start an interactive session with

   ```bash
   claude --dangerously-load-development-channels plugin:ultracodex@ultracodex
   ```

   (a confirmation dialog appears; not available with `-p`). Without the flag Claude Code drops the notifications
   silently and the tools work as before. `ULTRACODEX_CHANNEL=0` turns the push off. The channel keeps its own cursor,
   so with a Monitor watcher running as well you get each event twice.

**Whose run is it?** `codex_start` and `codex_sessions` report `owner` and `ownerSource` (`ultracodex_owner`,
`claude_code_session_id`, or `instance`: the server found no session id in its environment and made up its own, so
only its channel and tools see those runs; a watcher then needs `notify --owner <that id>`).

**Cost.** One small node process per Claude session for the MCP server, plus one watcher while the codex skills are in
use (the same watcher logic runs in the server for the channel; it polls a few small files once a second). Nothing runs
when no session exists. The MCP server needs Claude Code to start plugin MCP servers (it does by default); the server
asks for MCP protocol revision 2025-06-18 whatever the client prefers, because a channel server that negotiates the
newer revision cannot deliver channel messages.

## Steering a workflow node

Since 0.6.0 the nodes of the workflows — a review lens, a verifier, a juror (`codexNode`) — run **steerable** by default: the
runner drives each as **one turn** of a session on a private `codex app-server` instead of `codex exec`. The request is the same, the
result is the same (signed for the same request, same envelope, plus `provenance.backend` and `steers`), the relay protocol is
unchanged — but while a node runs you, or the main Claude session, can reach it:

```text
codex_sessions                                  # your nodes, running or ended: runId, label, state, steerable: true
codex_send     {runId, message, mode: "steer"}  # Codex reads it at its next step boundary
codex_interrupt {runId}                         # stop it now: the node ends as interrupted (never retried)
codex_events   {runId, waitSec}                 # what it is doing, live
```

From the shell: `node scripts/codex-node.mjs status --sessions [--all]`, `send RUN --mode steer --message …`, `interrupt RUN`,
`events RUN --follow`, `cancel RUN` (`close` is a cancel here). Find a node by its `label` (the workflows give each one). What
differs from a session: a node **ends with its turn** — queue-mode messages are rejected (`single_turn`), there is no follow-up, no
idle period, no revive and no `ask_orchestrator` (`answer` is rejected); `notify` and the channel stay quiet about its turns,
errors and end (a review runs a dozen nodes) and only report a usage-limit wait and its resume. Everything else is the node's own
rules: deadline (`timeoutSec` bounds the whole job, retries included), orphans, slots, the usage-limit wait, following an account
switch, and the retry of a transient failure on the same thread (`maxAttempts`).

**Verified isolation.** A node on `codex exec --ignore-user-config` never sees your config; `app-server` has no such flag, so before
any thread starts the runner asks it `config/read` and judges, key by key, where each effective setting came from. What your
`config.toml` contributes is allowed only if it is *inert* (UI and bookkeeping: `tui`, `notice`, `projects`, `marketplaces`, …),
*neutralized* (plugins, apps and MCP servers that are switched off, an empty `notify`), *owned by the runner* (model, effort,
approval policy and reviewer, sandbox mode, service tier — set explicitly on every thread and turn) or carried on purpose
(`windows.sandbox`). Anything else — instructions, providers, profiles, shell environment, hooks, other features, an MCP server that
is enabled, … — fails the check, as does a Codex without `config/read` or an answer it cannot read: the app-server is stopped
(`hermetic_violation`, naming the keys, never their values). This covers sessions too.

**Fallback and kill switch.** If the session backend cannot be used before the first turn starts — the isolation cannot be verified,
the app-server does not start — the very same job runs on `codex exec`, as if it had never been steerable (same run id, same
signature, same deadline and attempts; event `backend_fallback`, `provenance.backend: "exec"`). `ULTRACODEX_NODE_BACKEND=exec` in
the environment of the runner makes every node run on exec; `codexNode(task, { steerable: false })` does it for one node.

## Install

```text
/plugin marketplace add narcis2007/ultracodex
/plugin install ultracodex@ultracodex
```

Update after a new release (third-party marketplaces do not auto-update unless you enable it
in `/plugin` → Marketplaces):

```text
/plugin marketplace update ultracodex
/plugin update ultracodex@ultracodex
```

Then check the setup once (no model call):

```bash
node "<plugin dir>/scripts/codex-node.mjs" preflight --pretty
```

## How a Codex node runs

```
Workflow script ──agent({agentType:'ultracodex:codex-key'})────▶ key agent: key (once) · expect DIGEST
   codexNode()   ──agent({agentType:'ultracodex:codex-relay'})──▶ relay (Bash only)
                                                                   │  part … (≤1.6 KB each, hash-checked)
                                                                   ▼
                                                     codex-node.mjs start → detached supervisor
                                                                   │  spawns codex.exe directly,
                                                                   │  deadline · retries · slots
                                                     wait (≤570 s per call, repeated) ◀── relay polls
                                                                   ▼
                              { ok, result, provenance: { threadId, model, effort, usage } }
```

- **Nothing blocks a Bash call.** Codex jobs run 8–90 minutes; the Bash tool's default timeout is
  2 minutes. The supervisor owns the job; the relay polls.
- **Byte-exact transport.** On Windows the Bash tool halves backslashes and breaks commands over
  ~8 KB. Requests are percent-encoded (no quotes, backslashes or control characters), split into
  small parts with per-part hashes, and verified end to end.
- **Signed both ways.** The helper signs every request it builds and announces it to the runner
  before a relay sees it (the runner starts nothing a relay, a Codex job or anyone else
  composed) and accepts only results the runner signed for that exact request —
  nonce, model, directory, schema, task and payload type — so a relay that "answers" by itself,
  replays an old run or retargets a job cannot pass for Codex. The key reaches the helper
  through a separate key agent; no job relay ever holds it. Large results travel in verified
  pages.
- **Hermetic by default.** Verification and review runs ignore `~/.codex/config.toml` (no user
  MCP servers); the Windows sandbox setting is carried over. A node that runs on an app-server (steerable, the
  default) gets the same isolation, verified with `config/read` before its thread starts.
- **Own processes only.** The supervisor stops only the tree it started (deadline, cancel, or a
  relay that stopped polling) — on Windows exactly the members of the run's Job Object, so an
  orphan whose parent exited is still stopped and nothing of another session ever is. It
  never touches other Codex sessions.
- **Confined agents.** A plugin hook lets the job relay run exactly the runner's `part`,
  `wait` and `page` commands, the key agent exactly `key` and `expect`, and the Claude stages
  that read reviewed code only read-only git (without permission prompts), and denies
  anything else. Reviewed content that hijacks a relay or a reader can neither run a program
  nor sign or announce a request (the reader's git is checked word by word against the ways,
  measured on git 2.55, to make "read-only" git run one).
  Workflow nodes are read-only and hermetic by construction. Writing tasks are
  never replayed from their initial prompt automatically; account continuation
  uses their saved thread and instructs Codex to inspect existing work first.

## Development

```bash
npm test           # 340+ offline tests (fake Codex CLI, stubbed workflow runtime) — no quota
npm run build      # regenerate plugins/ultracodex/workflows/*.js and the helper block in the docs
npm run check      # build --check + tests
npm run preflight
npm run dev        # Claude Code with this checkout as the plugin (installed copy disabled for that session)
```

Headless end-to-end runs (`claude -p --plugin-dir plugins/ultracodex --settings tools/dev-settings.json …`)
need `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, otherwise `claude -p` stops a workflow after 600 s.

Sources of the generated files: `tools/src/helper.js` (the `codexNode` helper) and
`tools/src/workflows/*.js`. Workflow scripts cannot import modules, so every shipped workflow
embeds the helper; `npm run build` keeps them identical and a test fails on drift.

Translations under `docs/` describe upstream v0.1.x and are not maintained in this fork.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Not affiliated with OpenAI or
Anthropic.
