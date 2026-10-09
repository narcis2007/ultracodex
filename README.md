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
| Skill `codex-steer` | Talk to a running Codex session: steer it, send follow-ups, see what it does, answer its questions, close it. |
| Agent `codex-relay` | Internal: the Bash-only relay that runs one Codex job for a Workflow node. |
| Agent `codex-key` | Internal: fetches the runner key and a nonce once per workflow, and announces each request to the runner (no task text in its prompt). |
| Agent `codex-reader` | Internal: the confined type for Claude stages that read reviewed code — Read, Grep, Glob and read-only git. |
| Runner `scripts/codex-node.mjs` (+ `session.mjs`) | Validates requests, runs `codex exec` — or, for a steerable session, a private `codex app-server` — under a detached supervisor with deadlines, process-tree teardown, retries, machine-wide slots and a provenance envelope. |

## Model policy — astra, sol, luna

| Tier | Model | For | Effort |
| --- | --- | --- | --- |
| `light` | gpt-6-luna | light work: triage, dedupe, mechanical edits, wide fan-outs of small checks | always `max` |
| `daily` | gpt-6.1-sol | implementation including complex code, debugging, architecture analysis, verification, jurors, routine review | `xhigh` for every workload |
| `final` | gpt-6-astra | security review, final critical review gates, load-bearing verdicts, unresolved issues escalated from Sol | `max` |

Sol 6.1 is the default implementer, including complex modules. Astra reviews security and
critical changes at the end. In `codex-review`, omitting `tier` uses Sol on ordinary lenses
and Astra on `security`; an explicit tier applies to every lens. Actual models are reported
in `lenses[].model`, and Astra findings are not sent to Astra again for a tiebreak.

Prefer Sol 6.1 at `xhigh`, including complex and long tasks. Use Sol at `max` only with an
explicit effort override for an exceptional unresolved problem or at the owner's request;
state the reason. Astra at `max` remains reserved for security and critical gates, and
Luna stays at `max` for light work. `ultra` only on explicit request, once per run. Details:
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
The continuation keeps the original model, schema, directory, sandbox and network
permissions (a resume restates them on every call: `codex exec resume` alone
would run read-only). Time spent waiting does not count against the job's deadline.
While waiting, `status` and `wait` show `backoff` with `waitingForLimit: true`,
`resumesAt` (best estimate) and `limitWaitUntil`; the result's provenance counts
`accountHandoffs` and `limitResumes` (together at most 8 per job).

The supervisor lets active commands finish. Native `codex exec` does not support
live account reload, so an already-running request may use the old account until
it finishes or fails; continuation handles the terminal quota error. Cancellation
still works while waiting.
Explicit `ephemeral: true`, external API-key authentication, a missing saved
thread or an unverified process teardown prevent continuation. An already-polled
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
(`codex-implement`, `codex-ask`; never a Workflow node — a relayed request with `session` is refused) and
the supervisor drives a private `codex app-server --listen stdio://` (JSON-RPC over stdio) instead of
`codex exec`. One session is one Codex thread; Claude can

- **steer** the running turn (`send`: Codex reads it at its next step boundary) or **queue** a message;
- send **follow-ups** after a turn — same thread, same context, no new run;
- **interrupt** a turn, read the **event feed** (`events RUN --follow`, built for Claude Code's Monitor tool),
  **answer questions** Codex asks through its client-side tool `ask_orchestrator`, and **close** the session.

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
`timeoutSec` is the deadline of **each turn**; the usage-limit wait, account handoff, spacing and budget of
the one-shot runs apply inside a session (the app-server is restarted on a new account, then the thread is
resumed and continued); orphan handling, slots (held only while a turn runs) and Job Object teardown are the
same.

**Questions.** With `askOrchestrator` (default on) the thread gets a client-side tool `ask_orchestrator`. A call
is a `question` event; `wait` and `events --follow` return at once and Codex is blocked until `answer` — or
until `askTimeoutSec` (default 1800) passes and it is told to proceed on its best judgement. The deadline keeps
running meanwhile.

**Safety.** Hermetic sessions (the default) disable every MCP server of `~/.codex/config.toml`, plugins and apps
(`app-server` has no `--ignore-user-config`) and then check with `mcpServerStatus/list` that none reports a tool
— before any turn, failing closed (`hermetic_violation`). A writable request whose `cwd` or `addDirs` contains or
lies inside the runner's home (`~/.ultracodex`) is refused: a Codex job must never write its own inbox. One
supervisor per session (an exclusive `supervisor.lock`); the relay guard still allows relays and readers only
their own commands, so none of `send`, `answer`, `interrupt`, `events`, `close` is available to them.

**Event feed** (`events.jsonl`, one compact object per line, `seq` strictly increasing for the session's life):
`session_started`, `turn_started`, `message`, `command_started`, `command`, `file_change` (relative paths, no diffs),
`plan`, `tool`, `question`, `answer`, `steer`, `followup`, `interrupt`, `error`, `turn_completed`, `limit_wait`, `resumed`,
`idle`, `dormant`, `closed`, `cancelled`, `hermetic_violation`. Reasoning, auth data and account ids are never
written. Past 8 MB the file keeps only the structural events (no command / file / plan / tool / commentary events).
The skill `codex-steer` is the command reference; `codex-node.mjs help` lists the syntax.

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
  MCP servers); the Windows sandbox setting is carried over.
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
npm test           # 90+ offline tests (fake Codex CLI, stubbed workflow runtime) — no quota
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
