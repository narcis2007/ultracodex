# codex exec — headless reference & gotchas

Everything the `codexNode` helper relies on, plus the escalation patterns for
when a Workflow node is the wrong container. The flag set below was verified
against `codex` 0.144.0 (the first release bundling the GPT-5.6 generation);
flags are stable across recent releases, but confirm with `codex exec --help`
and the preflight if behavior differs.

## `codex exec` flags that matter

| Flag | Use |
| --- | --- |
| `-m, --model <MODEL>` | Model override. The default model is whatever the install is configured for (recent builds default to the flagship GPT tier — a *different* family from Claude, which is the entire point). Use **fully-qualified IDs** (e.g. `gpt-5.6-sol`): on ChatGPT-account auth, aliases like bare `gpt-5.6` and shorthand tier names are rejected with a 400 mid-run — after the banner has already echoed them (see the caveats below). Confirm availability with the preflight; do not hard-code a model name in shared scripts — pick tiers per run/node (see "Model tiers & reasoning effort" below). |
| `--output-schema <FILE>` | Path to a **JSON Schema file** the final response must satisfy. Codex emits validated JSON. Use strict schemas: `additionalProperties:false` and a `required` listing **every** key in `properties` — OpenAI's backend 400s on a partial `required` before the run starts (strict mode has no optional keys). |
| `-o, --output-last-message <FILE>` | Writes the final message to a file. **This is the clean extraction path** — `cat "$OUT"`. stdout also prints it but with session chrome around it. |
| `--json` | Stream events as JSONL to stdout. For debugging/observability, not for clean extraction. |
| `-s, --sandbox <MODE>` | `read-only` \| `workspace-write` \| `danger-full-access`. See tiers below. |
| `--skip-git-repo-check` | Run outside a git repo. Codex normally insists on a repo as a safety boundary; include this for scratch/verify nodes. |
| `-c key=value` | Override any `~/.codex/config.toml` value, TOML-parsed. E.g. `-c model_reasoning_effort="medium"` for cheaper/faster runs, or `-c model="gpt-5.6-terra"`. |
| `-i, --image <FILE>` | Attach image(s) to the prompt. |
| `-C, --cd <DIR>` | Use the specified directory as the working root. `read-only` blocks writes, **not reads** — a `-C` node can read the whole tree, which is what makes large-context / multi-file verify cheap (name the files in the prompt instead of inlining them). |
| `--dangerously-bypass-approvals-and-sandbox` | No approvals, no sandbox. Only for trusted headless harnesses. |
| `codex exec resume [--last]` | Resume the most recent session (durable context). Backbone of the background-pool pattern. |
| prompt arg vs stdin | A positional `[PROMPT]` works for simple text; for arbitrary task text **pipe via stdin** (`- < file`) to avoid shell quoting/expansion bugs. |

In `exec` mode, **approval is disabled** — it does not prompt. With `-s read-only`
the *model's* shell commands cannot modify the workspace, so a verify/judge node
has no model-driven side effects on your files. (Codex still writes its own
session files unless `--ephemeral`, and `-o` writes the output file by design —
`read-only` constrains the model's commands, not Codex's own bookkeeping.)

## Model tiers & reasoning effort (GPT-5.6 generation)

OpenAI's stated naming convention for the GPT-5.6 generation (Codex CLI ≥
0.144.0): the number is the generation; Sol/Terra/Luna are capability tiers
meant to advance on their own cadence. Both knobs map straight onto `codexNode`
options (`model` → `-m`, `effort` → `-c model_reasoning_effort`), and **the
choice is per node — leave it to the orchestrating model** to match tier and
effort to what each node is for.

| Tier (API ID) | Position | Catalog default effort |
| --- | --- | --- |
| `gpt-5.6-sol` | flagship reasoning — hardest verification, deep judging, long-horizon | `low` |
| `gpt-5.6-terra` | balanced mid-tier — everyday verify/judge at roughly half flagship cost | `medium` |
| `gpt-5.6-luna` | fastest/cheapest — wide verify fan-outs, routine structured checks | `medium` |

Effort ladder for the 5.6 tiers, per the CLI's bundled catalog (confirm with
`codex debug models`): `low` · `medium` · `high` · `xhigh` · **`max`** (all
three tiers) · **`ultra`** (Sol/Terra only — maximum reasoning with automatic
sub-agent task delegation; Luna's catalog omits it, yet passing it anyway is
*silently accepted*, not rejected — see the caveats below). All are legitimate options; a structured verify is
a few K tokens — cents even at flagship rates (sol $5/$30, terra $2.50/$15,
luna $1/$6 per 1M in/out) — so `max` is a reasonable pick for a hard node, not
a last resort. Typical mappings, not rules:

- **Wide verify/judge fan-outs** → `gpt-5.6-luna` or `gpt-5.6-terra` at `low`/`medium` —
  the per-node cost drop compounds across the fan-out.
- **Deep second opinion, judge of record, risky-conclusion cross-check** →
  `gpt-5.6-sol` at `high`/`xhigh`, or `max` when the node's verdict is
  load-bearing.
- **`ultra`** — the strongest option, and the one to place deliberately: it
  spawns its own sub-agent delegation, so runs are long (a Workflow node holds
  its concurrency slot throughout) and can consume usage quota quickly. Right
  for **at most one** decisive cross-check per run — a *knowing exception* to
  "keep Codex nodes short" that trades one held slot for the strongest verdict —
  or for a Pattern B worker; wrong for a 20-finding verify fan-out.

Caveats that bite in practice:

- **Fully-qualified IDs only** on ChatGPT-account auth — bare `gpt-5.6`,
  shorthand `sol`/`terra`/`luna`, and unlisted variants are rejected with a 400
  *after* the banner echoes them, so the banner alone doesn't prove the model ran.
- **Effort names are enforced asymmetrically.** A name outside the 5.6 catalog
  (e.g. `minimal`, still listed in the general config docs) 400s mid-run
  (`unsupported_value` on `reasoning.effort`) — but the unlisted *combination*
  `ultra` on `gpt-5.6-luna` is silently accepted: clean exit, banner echoing
  `ultra`. A clean run proves the node ran, not that the effort you asked for is
  what engaged; the catalog (`codex debug models`) is the source of truth.
- **Codex-side effective context is ~372K tokens** for the 5.6 tiers — smaller
  than the API-advertised 1.05M window; size `cwd`-variant nodes accordingly.
- Availability differs per install/account — the **preflight stays authoritative**;
  hard-code no model in shared scripts, pass tiers per run instead.

## Sandbox tiers

- **`read-only`** — default for verify/judge/read-and-reason nodes. No writes, no
  approvals. Safest; use unless the node must produce files.
- **`workspace-write`** — Codex may edit files under cwd. Use for generation that
  emits files. If several such nodes run in parallel, give each Workflow node
  `isolation: 'worktree'` so they do not collide on the same tree.
- **`danger-full-access`** / `--dangerously-bypass-approvals-and-sandbox` — no
  guardrails. Reserve for the background worker pool (Pattern B) where the harness
  itself is the boundary. Avoid inside Workflow nodes.

## Output extraction — why `-o`

```bash
OUT=$(mktemp)
codex exec --skip-git-repo-check -s read-only --output-schema "$SCHEMA" \
  -o "$OUT" - < "$TASK" >/dev/null 2>&1
cat "$OUT"
```

Codex prints the final message to **stdout** and writes a session header/log
(model, sandbox, session id, token count) to **stderr**. Redirecting both to
`/dev/null` and reading `"$OUT"` gives exactly the schema-validated JSON with no
chrome to parse around. This is what makes the relay reliable.

Two adjacent failure shapes worth understanding:

- **Schema drift.** A loose schema lets Codex emit extra keys or stray prose that
  breaks a downstream `JSON.parse`. Always use `additionalProperties:false` +
  `required`, and for small payloads keep passing the same `schema` object to the
  wrapping `agent()` (the helper's `revalidate:true`) so the Workflow re-validates
  and hands back a parsed object — that re-validation is precisely the drift
  defense.
- **Empty `-o`.** The `-o` file can come back empty when the model fails schema
  validation or errors mid-run — which is exactly the case the node maps to
  `{"_codex_error":true}`. So empty `-o` ≠ "Codex said nothing meaningful"; it is
  "no usable result", and must be filtered, never read as a pass/refute.

## Gotchas specific to blending into a Workflow

1. **Workflow JS has no filesystem.** The script body cannot write the schema
   file — so the codex node embeds the schema as a string and the (Bash-capable)
   subagent writes it to a temp file. Do not try `fs.writeFileSync` in the script;
   it is not there. Likewise `Date.now()`/`Math.random()` throw in Workflow scripts.
2. **The wrapper will try to solve it.** A Claude subagent handed a verifiable
   question often just answers it, silently collapsing the cross-model node into
   a Claude node. The "relay, not solver" instruction is non-negotiable.
   **How to detect it once:** a genuine Codex run should emit a session header on
   **stderr** (model, `provider: openai`, a session id, tokens used); a wrapper
   that answered locally emits none of it. To audit a node, run its exact command
   but capture stderr instead of discarding it (`… -o "$OUT" 2>"$ERR"`) and
   confirm `$ERR` shows a Codex provider line, a non-empty session id, and
   non-zero token use. (The exact stderr format is not a stable contract — treat
   it as a practical tell, not an API.) Keep `2>/dev/null` in the production
   helper; this is a diagnostic toggle only.
3. **Blocking holds a slot.** `codex exec` is synchronous; the wrapper subagent
   blocks on it and occupies one of the Workflow's ~16 concurrency slots for the
   whole Codex runtime. Short read-only nodes only. For long work, escalate.
4. **Two billing surfaces.** Each codex node = one Anthropic wrapper turn + one
   Codex/OpenAI run. The wrapper only relays, but it still pays a subagent's fixed
   overhead (and echoes the task/schema/output through its context), so it is not
   free — do not fan out hundreds of codex nodes casually; batch small items instead.
5. **`_codex_error` discipline (one rule, applied consistently).** On failure the
   node returns `{"_codex_error": true}`. Treat it as **"no data"**, never as a
   pass/refute:
   - Always `.filter(Boolean)` to drop null agent returns, **then** drop any
     result where `_codex_error` is true, **before** any aggregation.
   - In a judge panel, **exclude** errored jurors from the average — scoring them
     `0` silently penalizes the candidate for an infrastructure failure.
   - If more than a small fraction of nodes return `_codex_error` in a single run,
     stop and re-run the preflight: that signals auth expiry or a bad schema, not
     isolated flakiness.

## Troubleshooting — symptom → cause → fix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Empty `-o` file | auth expired, or the model failed schema validation | Re-run the preflight; capture stderr (gotcha #2) to see the real error. |
| OpenAI 400 before any output (`-o` never written) | strict schema with a partial `required` — a key in `properties` is missing from `required` | List **every** `properties` key in `required`; strict mode has no optional keys. |
| Node returns `{"_codex_error":true}` | codex exited non-zero or `-o` was empty | Treat as "no result" and filter it **before** aggregating — never as pass/refute (gotcha #5). |
| Session header on stderr but malformed JSON in `-o` | schema too loose | Tighten with `additionalProperties:false` + `required`; keep `revalidate:true` for small payloads. |
| `codex login` / auth error in `exec` | not authenticated | Run `codex login` interactively — it cannot be done headlessly. |
| Node hangs / a slot stays busy for minutes | a long task slipped into a Workflow node | Move it to Pattern B (background pool); Workflow nodes are for short reads. |
| Verify/judge nodes are slow or expensive | reasoning effort defaulting high for a "short" node | Pin `effort: 'medium'` (or `'low'`) on `codexNode` → `-c model_reasoning_effort`, and/or drop the tier (`model: 'gpt-5.6-luna'`) — this changes whether a node is actually short. See "Model tiers & reasoning effort". |
| `-m` accepted but the run 400s (`model is not supported`) | alias or shorthand model name on ChatGPT-account auth | Use the fully-qualified tier ID (`gpt-5.6-sol` / `-terra` / `-luna`); the banner echoes whatever you passed, so only a completed run proves the model. |
| Run 400s with `unsupported_value` on `reasoning.effort` | effort name outside the 5.6 catalog (e.g. `minimal` from the general config docs) | Use catalog names only (`low`→`xhigh`, `max`, `ultra` on Sol/Terra). Note the asymmetry: `ultra` on Luna does **not** 400 — it runs with the banner echoing `ultra` (see caveats), so a clean exit is not proof the effort engaged. |
| The verify "passed" but feels too easy | the wrapper answered instead of relaying to Codex | Audit with the stderr check in gotcha #2; strengthen the "relay, not solver" preamble. |
| Big diff/file verification bloats the prompt | inlining file contents into `taskText` | Pass `cwd` (`-C`) and name the files; Codex reads them under read-only (see `-C` row). |

## Escalation — when Pattern A is the wrong shape

### Pattern B — background worker pool (long / parallel Codex workers)

For Codex workers that run minutes-to-hours (real implementations, productions),
do **not** route through Workflow nodes — they would idle-hold slots. Instead
launch detached processes and poll. The shape is:

```bash
# 1. Preflight the CLI once (see Preflight below).
# 2. For each unit of work, materialize an isolated workspace + brief, then
#    background a worker capped at a small concurrency (e.g. 3):
mkdir -p run-A
# --json makes stdout a JSONL EVENT STREAM (so run-A/codex.jsonl is real JSONL);
# -o still writes the clean final message to run-A/last.txt. Without --json,
# stdout is plain CLI text, not JSONL.
codex exec --json --dangerously-bypass-approvals-and-sandbox -C run-A \
  -o run-A/last.txt "$(cat run-A/brief.md)" > run-A/codex.jsonl 2>&1 &
echo $! > run-A/pid          # record PID for liveness polling

# 3. Poll PIDs / output files for terminal state; when a worker needs to
#    continue with durable context, resume its session:
codex exec resume --last     # or: codex exec resume <SESSION_ID>
```

A complete pool implements: a CLI preflight, per-unit workspace materialization,
a bounded number of concurrent background `codex exec` workers (track PIDs, poll
for completion, free a slot, start the next), structured logging to per-run
JSONL, and `resume` for multi-turn work. Keep concurrency low (Codex runs are
heavy) and never let a runaway worker loop unbounded — cap total runs.

### Pattern C — one autonomous Codex objective

A single "implement this whole thing" handoff with its own resumable lifecycle
belongs in a dedicated Codex handoff command/agent (for example a goal-runner
that takes a brief file, or a `codex-rescue`-style agentType that forwards a
single second-opinion/rescue request to the Codex runtime) — not in a Workflow
node. Use Pattern A only for short, structured, in-orchestration nodes.

## Preflight

Before relying on Codex in a run, confirm the CLI is live and logged in:

```bash
command -v codex && codex --version
# bare structured smoke (cheap):
OUT=$(mktemp); SCH=$(mktemp)
printf '%s' '{"type":"object","additionalProperties":false,"required":["ok"],"properties":{"ok":{"type":"boolean"}}}' > "$SCH"
codex exec --skip-git-repo-check -s read-only --output-schema "$SCH" -o "$OUT" "Return {\"ok\":true}." </dev/null >/dev/null && cat "$OUT"
```

If that prints schema-valid JSON, codex nodes will work. If it errors on auth,
the user needs to `codex login` (interactive) — that cannot be done headlessly.
