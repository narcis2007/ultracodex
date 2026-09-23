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
| Agent `codex-relay` | Internal: the Bash-only relay that runs one Codex job for a Workflow node. |
| Agent `codex-key` | Internal: fetches the runner key and a nonce once per workflow (no task text in its prompt). |
| Runner `scripts/codex-node.mjs` | Validates requests, runs `codex exec` under a detached supervisor with deadlines, process-tree teardown, retries, machine-wide slots and a provenance envelope. |

## Model policy — astra, sol, luna

| Tier | Model | For | Effort |
| --- | --- | --- | --- |
| `light` | gpt-6-luna | light work: triage, dedupe, mechanical edits, wide fan-outs of small checks | always `max` |
| `daily` | gpt-6-sol | day-to-day: verification, jurors, second opinions, review lenses, normal implementation | `xhigh` for verify fan-outs, `max` otherwise |
| `final` | gpt-6-astra | very advanced work and the last word: final review gate, critical code, hard problems | `max` |

Cascade with astra last; `ultra` only on explicit request, once per run. Details:
[model-policy.md](plugins/ultracodex/skills/codex-workflow/references/model-policy.md).

Cost, in short: ask directly (`codex-ask`) when one answer is enough; batch small items into
one run; let sol verify broadly and astra re-check only what would block a merge (the shipped
reviews do this by default and report any astra disagreement as *disputed*); every shipped
workflow returns `codexUsage` — runs and tokens per model.

## Requirements

- Claude Code with dynamic workflows (tested on 2.1.280)
- Codex CLI, logged in (`codex login`; tested on 0.156.1)
- Node.js 18+

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
Workflow script ──agent({agentType:'ultracodex:codex-relay'})──▶ relay (Bash only)
   codexNode()                                                     │  part … (≤1.6 KB each, hash-checked)
                                                                   ▼
                                                     codex-node.mjs start → detached supervisor
                                                                   │  spawns codex.exe directly,
                                                                   │  deadline · retries · slots
                                                     wait (≤110 s per call, repeated) ◀── relay polls
                                                                   ▼
                              { ok, result, provenance: { threadId, model, effort, usage } }
```

- **Nothing blocks a Bash call.** Codex jobs run 8–90 minutes; the Bash tool's default timeout is
  2 minutes. The supervisor owns the job; the relay polls.
- **Byte-exact transport.** On Windows the Bash tool halves backslashes and breaks commands over
  ~8 KB. Requests are percent-encoded (no quotes, backslashes or control characters), split into
  small parts with per-part hashes, and verified end to end.
- **Signed both ways.** The helper signs every request it builds (the runner starts nothing a
  relay composed itself) and accepts only results the runner signed for that exact request —
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
- **Confined relays.** A plugin hook lets the job relay run exactly the runner's `part`,
  `wait` and `page` commands, and the key agent exactly `key` (without permission prompts),
  and denies anything else. Reviewed content that tries to hijack a relay gets nowhere.
  Workflow nodes are read-only and hermetic by construction, and writing tasks are never
  retried automatically.

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
