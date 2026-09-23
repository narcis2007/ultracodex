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
  10 KB slices (the Bash tool only previews output over 30 KB); the helper stitches and
  re-verifies them, and from the conversation the result file is simply read.
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

## 0.2.1 — 2026-07-10 (fork)

Correctness fixes from a cross-model review; runtime self-test.

## 0.2.0 — 2026-07-10 (fork)

Stability hardening of the codexNode helper: salted heredoc delimiters, POSIX-quoted flags,
validated options, intrinsic ≤4 concurrency gate, structured `_codex_error{kind}` with
classified retries, fail-closed templates.

## Upstream

0.1.0–0.1.3 by KingGyuSuh — see https://github.com/KingGyuSuh/ultracodex.
