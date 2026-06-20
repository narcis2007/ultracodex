# Workflow templates — Codex blended in (Pattern A)

Copy-paste starting points. Each template is a complete Workflow script (begins
with `export const meta`). Adapt the prompts, schemas, and item lists to the task.

The **canonical `codexNode` helper is defined ONCE at the top of this file** — it
is the single source of truth. Each template below assumes it is in scope and
shows only a `/* paste the codexNode helper from the top of this file */` stub.
In a real script, define the helper once near the top.

## Contents

- **The `codexNode` helper** — the canonical relay; define once, the templates stub it.
- **Template 1 — Cross-model review** (find → Codex-verify): the default; fan-out find, per-finding adversarial verify.
- **Template 2 — Judge panel with a Codex juror**: candidate generation + mixed jury.
- **Template 3 — Cross-check one risky conclusion**: minimal; one cross-check of a single conclusion.
- **Template 4 — Loop-until-dry with a Codex gate**: iterate find → verify until a round adds no new confirmed findings.
- **Variants & notes**: batch node, large-payload (`revalidate:false`), `_codex_error` discipline.

---

## The `codexNode` helper

The single source of truth — `schema` drives both Codex's `--output-schema` and
(when `revalidate`) the Workflow's own re-validation, so the node returns a parsed
object.

```js
// One Workflow node, backed by a Codex headless run.
// schema:     a JS object (JSON Schema). Drives BOTH codex --output-schema and the
//             Workflow's re-validation (when revalidate), so this returns a parsed object.
// cwd:        optional working root (-C) so Codex can READ files itself (read-only still reads).
// effort:     optional reasoning-effort knob, mapped to -c model_reasoning_effort="...".
// revalidate: default true; set false for large payloads and JSON.parse the string yourself.
function codexNode(taskText, { schema, sandbox = 'read-only', model, cwd, effort, revalidate = true, phase, label } = {}) {
  const flags = [
    model  ? `-m ${model}` : '',
    cwd    ? `-C "${cwd}"` : '',   // quote: cwd is an arbitrary path and may contain spaces
    effort ? `-c model_reasoning_effort="${effort}"` : '',
  ].filter(Boolean).join(' ')
  const schemaJson = JSON.stringify(schema, null, 2)
  return agent(
    `You are a RELAY, not a solver. Do NOT attempt the task yourself, do NOT
reason about it, do NOT use your own judgment. Your only job is to run Codex on
the task below and return Codex's JSON verbatim. If you answer it yourself the
whole point — a second, independent model — is defeated.

Run exactly this (the heredocs write the schema and task to temp files):
  SCHEMA=$(mktemp); TASK=$(mktemp); OUT=$(mktemp)
  cat > "$SCHEMA" <<'CODEX_SCHEMA_EOF'
${schemaJson}
CODEX_SCHEMA_EOF
  cat > "$TASK" <<'CODEX_TASK_EOF'
${taskText}
CODEX_TASK_EOF
  codex exec --skip-git-repo-check -s ${sandbox} ${flags} \\
    --output-schema "$SCHEMA" -o "$OUT" - < "$TASK" >/dev/null 2>&1
  cat "$OUT"

Return EXACTLY the contents of "$OUT" — no prose, no markdown fences. If "$OUT"
is empty or codex errored, return the literal: {"_codex_error": true}`,
    { label: label ?? 'codex', phase, schema: revalidate ? schema : undefined },
  )
}
```

---

## Template 1 — Cross-model review (find → Codex-verify)

The canonical Pattern A. Claude finds broadly across dimensions; each finding is
adversarially verified by Codex as soon as it surfaces — pipeline, no barrier.
Survivors are findings a *different model family* could not refute.

```js
export const meta = {
  name: 'cross-model-review',
  description: 'Claude finds issues across dimensions; Codex adversarially verifies each',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

function codexNode(taskText, opts) { /* paste the codexNode helper from the top of this file */ }

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'title', 'detail', 'file'],
    properties: { id: {type:'string'}, title: {type:'string'}, detail: {type:'string'}, file: {type:'string'} },
  } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['refuted', 'confidence', 'reasoning'],
  properties: { refuted: {type:'boolean'}, confidence: {type:'number'}, reasoning: {type:'string'} },
}

const DIMENSIONS = [
  { key: 'correctness', findPrompt: 'Review the changed files for correctness bugs. Return structured findings.' },
  { key: 'security',    findPrompt: 'Review the changed files for security issues. Return structured findings.' },
  // …add the dimensions the task needs
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.findPrompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS }),
  (review, d) => parallel((review?.findings ?? []).map(f => () =>
    codexNode(
      `Adversarially verify this finding. Default to refuted=true if you cannot confirm it from the evidence.\nTITLE: ${f.title}\nFILE: ${f.file}\nDETAIL: ${f.detail}`,
      { schema: VERDICT, phase: 'Verify', label: `codex:${d.key}:${f.id}` },
    ).then(v => ({ ...f, dimension: d.key, verdict: v })))),
)

const confirmed = results.flat().filter(Boolean)
  .filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false)
return { confirmed, total_findings: results.flat().filter(Boolean).length }
```

> **Verifying large/multi-file evidence?** Don't inline file contents — pass
> `cwd: '<abs target dir>'` to `codexNode` and name the files in the prompt; Codex
> reads them itself under read-only. See SKILL.md → "Variant: let Codex read the files itself".

---

## Template 2 — Judge panel with a Codex juror

Generate N candidates from different angles (optionally one by Codex for true
diversity), then score each with a mixed jury so no candidate is judged only by
its own author's model. Synthesize from the winner.

```js
export const meta = {
  name: 'mixed-judge-panel',
  description: 'Diverse candidate solutions scored by a Claude+Codex jury',
  phases: [{ title: 'Generate' }, { title: 'Judge' }, { title: 'Synthesize' }],
}

function codexNode(taskText, opts) { /* paste the codexNode helper from the top of this file */ }

const SOLUTION = {
  type: 'object', additionalProperties: false, required: ['approach', 'plan'],
  properties: { approach: {type:'string'}, plan: {type:'string'} },
}
const SCORE = {
  type: 'object', additionalProperties: false, required: ['score', 'rationale'],
  properties: { score: {type:'number', description:'0..10'}, rationale: {type:'string'} },
}

const TASK = 'Design an approach to <the problem>.'
const ANGLES = [
  { key: 'mvp',  prompt: `${TASK}\nBias toward the simplest shippable version.` },
  { key: 'risk', prompt: `${TASK}\nBias toward de-risking the hardest unknown first.` },
]

phase('Generate')
// Claude candidates + one Codex candidate for model diversity
const candidates = (await parallel([
  ...ANGLES.map(a => () => agent(a.prompt, { label: `gen:${a.key}`, schema: SOLUTION })
    .then(s => ({ ...s, author: `claude:${a.key}` }))),
  () => codexNode(`${TASK}\nPropose the approach you think is most robust.`,
        { schema: SOLUTION, label: 'gen:codex' }).then(s => ({ ...s, author: 'codex' })),
])).filter(Boolean)

phase('Judge')
const judged = await parallel(candidates.map((c, i) => () => parallel([
  () => agent(`Score this approach 0..10 for the problem.\n${JSON.stringify(c)}`, { label: `judge:claude:${i}`, schema: SCORE }),
  () => codexNode(`Score this approach 0..10 for the problem.\n${JSON.stringify(c)}`, { schema: SCORE, label: `judge:codex:${i}` }),
]).then(scores => {
  // exclude errored jurors from the average — never score an infra failure as 0.
  const valid = scores.filter(s => s && !s._codex_error)
  const avg = valid.reduce((a, s) => a + (s.score ?? 0), 0) / (valid.length || 1)
  return { candidate: c, avg, scores: valid }
})))

const winner = judged.filter(Boolean).sort((a, b) => b.avg - a.avg)[0]

phase('Synthesize')
const final = await agent(
  `Write the final approach. Base it on the winner, grafting the best ideas from the runners-up.\nWINNER: ${JSON.stringify(winner.candidate)}\nALL: ${JSON.stringify(judged.filter(Boolean).map(j => ({author: j.candidate.author, avg: j.avg})))}`,
)
return { final, winner: winner.candidate.author, ranking: judged.filter(Boolean).map(j => ({ author: j.candidate.author, avg: j.avg })) }
```

---

## Template 3 — Cross-check one risky conclusion

Minimal blend: Claude does the work, and a single Codex node tries to refute the
headline conclusion before reporting it. Cheap insurance for high-stakes claims.

```js
export const meta = {
  name: 'codex-crosscheck',
  description: 'Claude concludes; Codex attempts to refute before reporting',
  phases: [{ title: 'Conclude' }, { title: 'Cross-check' }],
}

function codexNode(taskText, opts) { /* paste the codexNode helper from the top of this file */ }

const VERDICT = {
  type: 'object', additionalProperties: false, required: ['refuted', 'confidence', 'reasoning'],
  properties: { refuted: {type:'boolean'}, confidence: {type:'number'}, reasoning: {type:'string'} },
}

phase('Conclude')
const conclusion = await agent('Analyze <X> and state your single headline conclusion with evidence.')

phase('Cross-check')
const verdict = await codexNode(
  `A Claude analysis concluded the following. Adversarially try to refute it; default to refuted=true if the evidence is not airtight.\n\n${conclusion}`,
  { schema: VERDICT, label: 'codex:crosscheck' },
)
return { conclusion, codex_verdict: verdict, trustworthy: verdict && !verdict._codex_error && verdict.refuted === false }
```

---

## Template 4 — Loop-until-dry with a Codex gate

Iterate Claude-find → Codex-verify until a round surfaces no NEW findings (or a
max-rounds cap), feeding already-known ids back into the finder as "don't repeat".
Exhaustion is judged on *confirmed* survivors, not raw Claude output — for thorough
reviews/audits.

```js
export const meta = {
  name: 'loop-until-dry-codex',
  description: 'Iterate Claude-find -> Codex-verify until a round adds no new findings',
  phases: [{ title: 'Hunt' }],
}

function codexNode(taskText, opts) { /* paste the codexNode helper from the top of this file */ }

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'title', 'detail'],
    // the finder assigns a STABLE id so rounds can dedupe.
    properties: { id: {type:'string'}, title: {type:'string'}, detail: {type:'string'} },
  } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['refuted', 'reasoning'],
  properties: { refuted: {type:'boolean'}, reasoning: {type:'string'} },
}

const MAX_ROUNDS = 4          // Workflow JS forbids unbounded loops / Date.now / Math.random — always cap.
const confirmed = []
const seen = new Set()        // stable ids already surfaced
let roundsUsed = 0

for (let round = 0; round < MAX_ROUNDS; round++) {
  roundsUsed = round + 1
  phase(`Round ${roundsUsed}`)
  const known = [...seen].join(', ') || '(none yet)'
  const review = await agent(
    `Find issues in <the target>. Assign each a STABLE id. Do NOT repeat already-known ids: ${known}. Return structured findings.`,
    { label: `find:r${round}`, schema: FINDINGS },
  )
  const fresh = (review?.findings ?? []).filter(f => !seen.has(f.id))
  if (fresh.length === 0) break              // dry round -> done
  fresh.forEach(f => seen.add(f.id))
  const verdicts = await parallel(fresh.map(f => () =>
    codexNode(`Adversarially verify, defaulting to refuted=true if uncertain:\n${f.title}\n${f.detail}`,
      { schema: VERDICT, label: `codex:${f.id}` }).then(v => ({ ...f, verdict: v }))))
  confirmed.push(...verdicts.filter(Boolean)
    .filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false))
}
return { confirmed, rounds_used: roundsUsed }
```

---

## Variants & notes

### Batch codex node — verify/judge N small items in one Codex run

Every template above fans out one Codex node per item. When items are **small and
homogeneous** and a single Codex context can hold them, batch them instead: one
slot, one Codex/OpenAI run, results keyed back by id. Fan out (Template 1) only
when each item needs a fresh, independent context — or when items are large.

```js
// instruction: what to do per item. items: [{ id, ... }]. schema: the BATCH shape below.
function codexBatchNode(instruction, items, opts = {}) {
  const taskText = `${instruction}
Return EXACTLY one result object per input id, in a "results" array — same ids, no extras.
INPUT ITEMS (JSON array):
${JSON.stringify(items)}`
  return codexNode(taskText, opts)  // returns the parsed { results: [...] }
}

const BATCH_VERDICTS = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'refuted', 'reasoning'],
    properties: { id: {type:'string'}, refuted: {type:'boolean'}, reasoning: {type:'string'} },
  } } },
}

// usage: verify all findings in ONE codex run, then key verdicts back by id.
const { results = [] } = await codexBatchNode(
  'Adversarially verify each finding; default refuted=true if uncertain.',
  findings.map(f => ({ id: f.id, title: f.title, detail: f.detail })),
  { schema: BATCH_VERDICTS, label: 'codex:batch-verify' },
) || {}
const byId = new Map(results.map(r => [r.id, r]))
```

### Large payloads — skip Workflow re-validation, parse the string yourself

`revalidate: true` (default) re-validates Codex's JSON through the Claude wrapper
and auto-parses it — best for small verdicts/scores, immune to schema drift. For a
**large** structured output, set `revalidate: false` so the wrapper relays the raw
string (Codex's own `--output-schema` still enforces shape), then parse it
yourself with the same `_codex_error` convention:

```js
const raw = await codexNode(bigTask, { schema: BIG_SCHEMA, revalidate: false, label: 'codex:big' })
let obj
try { obj = JSON.parse(raw) } catch { obj = { _codex_error: true } }
```

### `_codex_error` discipline (applies to every template)

A Codex node returns `{ _codex_error: true }` on failure. Treat it as **"no data"**,
never as a pass/refute:

- Always `.filter(Boolean)` to drop null agent returns, **then** drop any result
  where `_codex_error` is true, **before** any aggregation.
- In a judge panel, **exclude** errored jurors from the average — scoring them `0`
  silently penalizes the candidate for an infra failure (Template 2 does this).
- If more than a small fraction of nodes return `_codex_error` in a run, stop and
  re-run the preflight — that signals auth expiry or a bad schema, not flakiness.

Full failure-mode table in `codex-headless.md` → Troubleshooting.

### Notes that apply to all templates

- **Keep Codex nodes short** (read-only verify/judge/small-gen). They hold a
  concurrency slot for Codex's full runtime — do not put long implementations here.
- **Schemas must be strict** — set `additionalProperties: false` **and** list
  *every* key from `properties` in `required` (OpenAI's structured-output backend
  400s on a partial `required` *before the run starts* — strict mode has no
  optional keys). Strictness also makes both Codex's `--output-schema` and the
  Workflow re-validation reliable.
- **Speed/cost knob:** pass `effort: 'medium'` (or `'low'`) to `codexNode` for
  cheaper/faster verify nodes — it maps to `-c model_reasoning_effort`. See
  `codex-headless.md`.
