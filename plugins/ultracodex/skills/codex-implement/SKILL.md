---
name: codex-implement
description: >-
  Delegate an implementation task to Codex (GPT-6) running in an isolated git worktree,
  then verify its work in Claude (build, tests, diff, claimed-vs-real) before anything is
  merged — optionally followed by a Codex or cross-model review and Codex follow-up fixes in
  the same session. Use when the user asks to have Codex implement / build / fix / refactor /
  migrate something, "give this to codex", "let codex write it", "use codex as the
  implementer or subagent", or any implement-then-review combination. Tiers: gpt-6.1-sol@xhigh by
  default, including complex code; gpt-6-astra@max for an explicit escalation or final critical
  review, gpt-6.1-terra@xhigh for mechanical changes (gpt-6-luna@max only as an explicit override).
---

# Delegate implementation to Codex

Runner: `${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs` · brief template: `references/brief-template.md` ·
tier policy: `${CLAUDE_PLUGIN_ROOT}/skills/codex-workflow/references/model-policy.md` ·
talking to the running job: the `codex-steer` skill

Codex writes the draft; **Claude owns the result**. Nothing Codex reports counts until you
have checked it yourself, and nothing is merged without the owner's OK.

## 1. Preflight and tier

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" preflight
```

- `daily` → gpt-6.1-sol@xhigh: features, fixes, debugging, refactors and cross-module designs
  from a clear brief, including complex implementation;
- `final` → gpt-6-astra@max: implementation only when the owner explicitly requests Astra,
  or when a concrete unresolved issue justifies escalation after a Sol attempt;
- `light` → gpt-6.1-terra@xhigh: mechanical work (renames, boilerplate, docs, test scaffolding).
  For high-volume mechanical edits where cost matters most, name `model: "gpt-6-luna", effort: "max"`.

Complexity alone does not switch the implementer to Astra. Use Sol to implement and review
routine changes. Use Astra for the final review only for critical work: security-sensitive code
(auth, keys, crypto, payments, personal data), data migrations, irreversible production steps,
or the last gate before a production release, unless the owner chose another model. In
`codex-review`, use `securityTier: 'final'` for security only or `tier: 'final'` for every lens.

Keep Sol at `xhigh`, including long implementations. Set `"effort": "max"` only for an
exceptional unresolved problem after an `xhigh` attempt or when the owner requests it;
state the reason. Complexity or duration alone does not justify `max`.

## 2. Isolate — a worktree outside the repo

```bash
git -C "<repo>" worktree add "<repo>/../<repo-name>.codex-<slug>" -b codex/<slug> <base-branch>
```

A sibling directory, never inside the repo (tools that walk up the tree, like dotenv, would
pick up the owner's `.env`) and never the owner's own working tree. One worktree per run; with
Rust, give it its own `CARGO_TARGET_DIR` in the brief.

## 3. Write the brief (Write tool, never a heredoc)

Fill `references/brief-template.md`: goal, context, scope and non-goals, the house rules
(point at AGENTS.md/CLAUDE.md), acceptance criteria, the **exact** verification commands (with
resource limits for this machine: e.g. `cargo … -j 1`, one test binary at a time), and git
rules (Codex does not commit or push unless the brief says otherwise). Save it next to the
request, e.g. in the session scratchpad.

## 4. Start it — as a session

Request file (Write tool):

```json
{
  "taskFile": "<abs path of the brief>",
  "cwd": "<abs path of the worktree>",
  "sandbox": "workspace-write",
  "network": true,
  "kind": "implement",
  "tier": "daily",
  "schemaPreset": "implement",
  "session": true,
  "attached": false,
  "label": "implement:<slug>"
}
```

`"session": true` makes the run a **steerable session**: Codex runs on a private app-server, and you can
steer it, send follow-ups, answer its questions and see what it does (the `codex-steer` skill has the
command reference). `timeoutSec` (default sol@xhigh ≈ 90 min, astra@max ≈ 135 min) is the deadline of
**each turn**. The cwd and `addDirs` of a writable run must not contain or lie inside the runner's home
(`~/.ultracodex`): a Codex job must never be able to write its own inbox.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" start --request "<request.json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" events <runId> --follow   # Monitor tool: one notification per event
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" wait <runId> --max-wait 9000   # run_in_background: true
```

- **Tools instead of Bash**: when the plugin's MCP tools are in your tool list, `codex_start` starts the
  session from the same fields as the request file, and `codex_wait`, `codex_events`, `codex_send`,
  `codex_answer`, `codex_interrupt`, `codex_result` and `codex_close` replace the commands below
  (full names `mcp__plugin_ultracodex_ultracodex__codex_*`; the `codex-steer` skill lists them). Everything
  here still applies: isolated worktree, the brief, verification. The CLI stays as the fallback.
- **Do not poll**: in an interactive session the plugin starts a `notify` watcher by itself once this skill
  ran (a notification when Codex asks, finishes a turn, waits for a limit or fails); otherwise arm the Monitor
  tool with `notify` — or use `events <runId> --follow` for one run (re-armed with `--since <lastSeq>`
  when it ends), or the background `wait`, which also returns when Codex **asks a question**.
- A `question` event is Codex blocked on you: `answer <runId> <questionId> --text "…"` (`codex_answer`).
- Steer with `send <runId> --message "…"` (`codex_send`; lands at Codex's next step; one clear instruction at
  a time), `interrupt <runId>` to stop the turn now.
- The turn's end shows as `idle` (`wait` prints that turn's envelope — the `implement` report). The
  session sleeps by itself after `idleTtlSec` (default 20 min) and the next `send` revives it, also
  after a reboot.

If the owner switches ChatGPT accounts (PrimerSwitch) while Codex works, the run follows within seconds — at the next step boundary, never in the
middle of a command: the turn (or a one-shot attempt) is interrupted and its thread resumed on the new account, so a long implementation does not
keep the old login (`"followAccountSwitch": false` opts out; the `codex-steer` skill has the details).

`attached: false` lets the run continue while you do other work. Implementation turns are **never
retried automatically** (a replay could apply its changes twice): after a transient failure, inspect the
worktree and send a follow-up deliberately. Keep at most one or two implementation sessions at once on this
machine, and do not run heavy builds in parallel with them. A session holds a machine-wide slot only while a
turn runs.

*Fallback, one line:* leave `"session"` out for the old one-shot run (`wait` returns its single result;
a follow-up is then a new run with `"resume": { "sessionId": "<provenance.threadId>" }` — see section 6).

## 5. Verify — trust nothing unverified

1. Read the `implement` report of the turn (status, tasks, files, commands, tests, open questions, risks):
   `wait <runId>` once the session is idle, or `result <runId> [--turn N]`.
2. `git -C <worktree> status` and `git -C <worktree> diff` — read the actual change.
3. Run the verification commands yourself. "Tests passed" in the report is a claim, not evidence.
4. Check every task marked `done` against the diff; list anything missing or partial.
5. If the run ended in `timeout`, `abandoned`, `cancelled`, `interrupted` or `usage_limit`, the tree may hold a
   half-written change: inspect it before building on it. (A usage-limited run first waits up to
   `limitWaitSec`, 24 h by default, for the limit to reset and then resumes by itself; `status`
   shows `waitingForLimit` and `resumesAt`.)

## 6. Iterate or review (combinations)

- **Follow-up in the same Codex session** (same thread, same context, no new run): `send <runId> --message-file
  "<fix brief>"` — the effort, schema and sandbox of the session apply, and nothing needs restating. Give it as
  a complete instruction (list the findings to fix). `wait <runId>` returns the follow-up turn's report.
  *One-shot fallback:* `{ "resume": { "sessionId": "<provenance.threadId>" }, "sandbox": "workspace-write", "taskFile": "<fix brief>", "cwd": "<worktree>", "kind": "implement", "tier": "daily", "schemaPreset": "implement", "attached": false }`
  (the runner restates the sandbox on every resume — `codex exec resume` alone runs read-only — so a follow-up that
  must write says `"sandbox": "workspace-write"`).
- **Adversarial review of the result**: the `codex-review` skill (or the
  `ultracodex:codex-review` workflow) on the worktree branch. Sol implements → Sol reviews
  routine changes, including security lenses. For the critical categories in section 1,
  use `securityTier: 'final'` for an Astra security review or `tier: 'final'` for every lens.
  Or use `ultracodex:cross-review` so Claude finds and Codex verifies.
- Fix findings and re-verify, then follow the `codex-review` skill's fixes and re-review policy:
  no new pass after low-only findings; otherwise review only the fix delta; at most 3 passes.

## 7. Close and hand over

After verification, `close <runId>` (`--archive` when the work is merged or abandoned: it also archives the Codex
thread; without it the thread stays in Codex's history). An idle session would sleep by itself, but a session you
are done with should be closed. Then summarize what was built, what you verified and how, the open items, and where
the branch is.
**Do not merge or push to shared branches without the owner's explicit OK** — they review
locally first.

## Rules

- Never stop Codex processes this plugin did not start (the owner runs parallel Codex
  sessions). `cancel <runId>` only for your own run and only when the owner asks. A
  `supervisor_lost` run is reported with its PID, never killed. `close` is the normal way to end your own
  session; `interrupt` stops a turn but keeps the session.
- Hermetic by default (the owner's MCP servers are not loaded). Pass `"hermetic": false` only if
  the task truly needs the user's Codex config.
- A strict schema is required for structured reports; the `implement` preset already is.
