---
name: codex-ask
description: >-
  Ask Codex (GPT-6) one question or check one claim from the main conversation, without a
  Workflow — a second opinion, an independent analysis of some code, an attempt to refute a
  conclusion before acting on it. Claude writes a request file, the runner runs Codex
  read-only and hermetic, and Claude reads the answer directly (no relay agent: the cheapest
  way to consult Codex). Use for "ask codex", "what does codex / gpt think", "second opinion
  from codex", "double-check this with astra / sol / luna", "have codex refute this",
  "cross-check before we do X". Tier by difficulty: gpt-6-luna@max for light questions,
  gpt-6-sol for day-to-day ones, gpt-6-astra@max for the hardest or final calls.
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
| day-to-day: a bug hypothesis, a design second opinion, "is this change safe" | `daily` → sol (xhigh for verify, max for ask) | as above |
| load-bearing: security / money / concurrency / data migration, an irreversible step, the last word before acting | `final` → astra@max | usually `verify` + `verdict` |

Decide what you want before writing the brief:

- an **independent** answer → do *not* include your own conclusion (it anchors Codex);
- a **refutation attempt** → state the claim and ask Codex to try to refute it
  (`verdict`: `refuted` true unless the evidence is airtight).

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

## 4. Use the answer

- Codex is evidence, not authority: check what it cites in the code before relying on it.
- If it disagrees with you on something that matters, look again yourself; if it is still
  open and load-bearing, ask once more on `final` with both positions in the brief.
- Report it with its provenance (model@effort, tokens) and say what you verified.
- A failure (`timeout`, `usage_limit`, `auth`, …) is "no answer", never agreement.

## Rules

- Read-only and hermetic: never `workspace-write` here (that is `codex-implement`).
- Never stop Codex processes this plugin did not start; `cancel <runId>` only for your own
  run and only when the owner asks.
