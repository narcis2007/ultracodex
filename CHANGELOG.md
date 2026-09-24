# Changelog

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
- Tests: 117 offline tests, including a two-process slot race with a late claim, a junction
  into an embedded bare repository, legacy slot debris and a late-winner upload race.

## 0.2.1 — 2026-07-10 (fork)

Correctness fixes from a cross-model review; runtime self-test.

## 0.2.0 — 2026-07-10 (fork)

Stability hardening of the codexNode helper: salted heredoc delimiters, POSIX-quoted flags,
validated options, intrinsic ≤4 concurrency gate, structured `_codex_error{kind}` with
classified retries, fail-closed templates.

## Upstream

0.1.0–0.1.3 by KingGyuSuh — see https://github.com/KingGyuSuh/ultracodex.
