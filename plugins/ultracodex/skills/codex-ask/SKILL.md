---
name: codex-ask
description: >-
  Ask Codex (GPT-6) one question or check one claim from the main conversation, without a
  Workflow — a second opinion, an independent analysis of some code, an attempt to refute a
  conclusion before acting on it. Claude writes a request file, the runner runs Codex
  read-only and hermetic, and Claude reads the answer directly (no relay agent: the cheapest
  way to consult Codex). Use for "ask codex", "what does codex / gpt think", "second opinion
  from codex", "double-check this with astra / sol / luna", "have codex refute this",
  "cross-check before we do X". Tier by role and risk: gpt-6-luna@max for light questions,
  gpt-6.1-sol@xhigh for coding analysis and design, gpt-6-astra@max for security and final critical calls.
---

# Ask Codex directly

Runner: `${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs` · tier policy:
`${CLAUDE_PLUGIN_ROOT}/skills/codex-workflow/references/model-policy.md`

One question → one Codex run, read-only and hermetic. For several Codex calls with Claude
checking them, use a workflow (`codex-workflow` skill); for code changes, `codex-implement`;
for a branch review, `codex-review`.

## 1. Pick tier and kind

| the question is… | tier → model | kind + output |
| --- | --- | --- |
| light: "where is X handled", a quick sanity check, a small factual claim about the code | `light` → luna@max | `verify` + `schemaPreset: "verdict"`, or `ask` (text) |
| coding analysis: a bug hypothesis, complex debugging, a design second opinion, routine checks | `daily` → 6.1-sol@xhigh | as above |
| load-bearing: security / money / concurrency / data migration, an irreversible step, the last word before acting | `final` → astra@max | usually `verify` + `verdict` |

Decide what you want before writing the brief:

- an **independent** answer → do *not* include your own conclusion (it anchors Codex);
- a **refutation attempt** → state the claim and ask Codex to try to refute it
  (`verdict`: `refuted` true unless the evidence is airtight).

Keep Sol at `xhigh` for both `ask` and `verify`. Set `"effort": "max"` only for an
exceptional unresolved problem after an `xhigh` attempt or when the owner requests it;
state the reason. A long or complex question alone does not justify `max`.

## 2. Write the brief and the request (Write tool — never a heredoc)

The brief (e.g. `<scratchpad>/ask-<slug>.md`): the question or claim, where to look (files,
`git diff main...HEAD`, commands it may run read-only), what a good answer contains, and any
domain rule it must respect.

```json
{
  "taskFile": "<abs path of the brief>",
  "cwd": "<abs repo path Codex may read>",
  "tier": "daily",
  "kind": "verify",
  "schemaPreset": "verdict",
  "label": "ask:<slug>"
}
```

Several related claims → one run, not several: give them ids in the brief, set
`"workItems": <N>` (the deadline scales) and pass this strict schema as `"schema"`:

```json
{"type":"object","additionalProperties":false,"required":["results"],"properties":{"results":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["id","refuted","confidence","reasoning"],"properties":{"id":{"type":"string"},"refuted":{"type":"boolean"},"confidence":{"type":"number"},"reasoning":{"type":"string"}}}}}}
```

## 3. Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" start --request "<request.json>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-node.mjs" wait <runId> --max-wait 7200   # run_in_background: true
```

You are notified when the background `wait` exits (luna: minutes; sol: ~5–25 min; astra:
~10–40 min). Keep working meanwhile; `status <runId>` shows progress. For a light question
you may instead wait in the foreground: `wait <runId> --max-wait 540` with a 600000 ms Bash
timeout, repeated while the state is `running`.

The final line is the envelope: `result` (or `text`) plus `provenance` (model, effort,
tokens, duration). A large result prints as a compact line with `paged.file` — read that
file with the Read tool.

### Several questions in a row: `"session": true`

The default is one-shot: one question, one run. When you expect to **follow up** (a second angle,
"now check X", pressing on a disagreement), add `"session": true` to the request. The run then keeps
its Codex thread: `wait` returns the first answer and the session goes idle; `send <runId> --message
"…"` asks the next question in the same thread (same context, effort and schema, no new run), and the
next `wait <runId>` returns that answer. `close <runId>` when you are done (an idle session sleeps by
itself and the next `send` revives it). Sessions stay read-only and hermetic here, and they are for
direct asks only — never a Workflow node. The command reference is the `codex-steer` skill; with the
plugin's MCP tools in your tool list, `codex_start` / `codex_wait` / `codex_send` / `codex_close` do the same
without Bash, and `notify` (or the plugin monitor, or the channel) tells you when Codex asks or answers
instead of polling.

## 4. Use the answer

- Codex is evidence, not authority: check what it cites in the code before relying on it.
- If it disagrees with you on something that matters, look again yourself; if it is still
  open and load-bearing, ask once more on `final` with both positions in the brief.
- Report it with its provenance (model@effort, tokens) and say what you verified.
- A failure (`timeout`, `usage_limit`, `auth`, …) is "no answer", never agreement.

## Rules

- Read-only and hermetic: never `workspace-write` here (that is `codex-implement`).
- Never stop Codex processes this plugin did not start; `cancel <runId>` only for your own
  run and only when the owner asks (`close <runId>` ends a session of yours normally).
