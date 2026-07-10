# Workflow templates — Codex blended in (Pattern A)

Copy-paste starting points. Each template is a complete Workflow script (begins
with `export const meta`). Adapt the prompts, schemas, and item lists to the task.

The **canonical `codexNode` helper (plus `safeDelim`, `makeLimiter`/`codexGate`,
and `CODEX_ERROR_SCHEMA`) is defined ONCE at the top of this file** — it is the
single source of truth. Each template below assumes it is in scope and shows only
a `/* paste the helper block from the top of this file */` stub. In a real script,
define the block once near the top.

> **v0.2 hardening (this fork).** The helper is injection- and delimiter-safe,
> fails *visibly* (its error sentinel is schema-compatible), runs `--ephemeral`
> on request, retries transient errors with backoff, and ships a concurrency gate.
> The templates **fail closed** — a dead Codex node surfaces as `unverified`, never
> as a silent pass. Rationale and the empirical numbers behind the defaults are in
> `SKILL.md` → "Stability & routing (read this before scaling out)".

## Contents

- **The helper block** — `codexNode` + `safeDelim` + `makeLimiter`/`codexGate` + `CODEX_ERROR_SCHEMA`.
- **Template 1 — Cross-model review** (Claude find → Codex verify → Claude synthesize): the default; fails closed.
- **Template 2 — Judge panel with a Codex juror**: candidate generation + mixed jury.
- **Template 3 — Cross-check one risky conclusion**: minimal; one cross-check of a single conclusion.
- **Template 4 — Loop-until-dry with a Codex gate**: iterate find → verify until a round adds no new confirmed findings.
- **Variants & notes**: batch node, large-payload (`revalidate:false`), the `cwd` (`-C`) variant, `_codex_error` discipline.

---

## The helper block

Paste this whole block once near the top of your script. `schema` drives both
Codex's `--output-schema` and (when `revalidate`) the Workflow's re-validation, so
`codexNode` returns a parsed object.

```js
// ── allowlists & tiny utilities ──────────────────────────────────────────────
const CODEX_EFFORTS   = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CODEX_SANDBOXES = ['read-only', 'workspace-write']

// Deterministic heredoc delimiter guaranteed absent from `text`. Workflow JS has no
// Math.random, so we salt deterministically. Stops a line INSIDE the payload (e.g.
// content that literally contains the delimiter) from closing the heredoc early and
// spilling the remainder into the relay's Bash. (Upstream's fixed CODEX_TASK_EOF is
// unsafe when you verify arbitrary repo content — including this plugin's own docs.)
function safeDelim(text, base = 'CDX_EOF') {
  let d = base
  while (text.includes(d)) d += '_X'
  return d
}

// Concurrency gate — cap SIMULTANEOUS Codex nodes below the Workflow's global cap
// (min(16, cores-2)). Codex 429s are mostly RPM; keeping concurrency modest and
// each node SHORT avoids them. Empirically ~6 small sol verifies run clean, so 4
// leaves headroom. Long / large-context Codex nodes should use a gate of 1–2.
function makeLimiter(max) {
  let active = 0; const q = []
  const pump = () => { while (active < max && q.length) { active++; q.shift()() } }
  return fn => new Promise((resolve, reject) => {
    q.push(() => fn().then(resolve, reject).finally(() => { active--; pump() }))
    pump()
  })
}
const codexGate = makeLimiter(4)   // wrap every codexNode call: codexGate(() => codexNode(...))

// The sentinel a failed node returns. anyOf'd into the revalidation schema below so
// it can actually PASS re-validation (upstream returned it against a strict success
// schema, where it could never validate → null / retry / fabricated answers).
const CODEX_ERROR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['_codex_error'],
  properties: { _codex_error: { const: true } },
}

// ── the hardened codexNode ───────────────────────────────────────────────────
// model/effort are optional and OMITTED when unset (stays install-agnostic — the CLI
// default applies). Pin them per node via a role policy const (see the templates).
function codexNode(taskText, {
  schema, sandbox = 'read-only', model, effort, cwd,
  revalidate = true, ephemeral = false, maxAttempts = 2, phase, label,
} = {}) {
  if (effort && !CODEX_EFFORTS.includes(effort))     throw new Error(`codexNode: bad effort "${effort}"`)
  if (!CODEX_SANDBOXES.includes(sandbox))            throw new Error(`codexNode: bad sandbox "${sandbox}"`)
  const schemaJson = JSON.stringify(schema, null, 2)
  const sd = safeDelim(schemaJson, 'CDX_SCHEMA')     // salted, per-payload delimiters
  const td = safeDelim(taskText,  'CDX_TASK')
  const flags = [
    model     ? `-m "${model}"` : '',                // quoted (upstream left -m unquoted)
    effort    ? `-c model_reasoning_effort="${effort}"` : '',
    cwd       ? `-C "${cwd}"` : '',
    ephemeral ? '--ephemeral' : '',
  ].filter(Boolean).join(' ')
  return agent(
    `You are a RELAY, not a solver. Do NOT attempt the task, reason about it, or use
your own judgment — answering it yourself defeats the entire point (a second,
independent model family). Run EXACTLY this and return what it prints, verbatim:

  SCHEMA=$(mktemp); TASK=$(mktemp); OUT=$(mktemp); ERR=$(mktemp)
  trap 'rm -f "$SCHEMA" "$TASK" "$OUT" "$ERR"' EXIT
  cat > "$SCHEMA" <<'${sd}'
${schemaJson}
${sd}
  cat > "$TASK" <<'${td}'
${taskText}
${td}
  attempt=0
  while : ; do
    attempt=$((attempt+1))
    codex exec --skip-git-repo-check -s ${sandbox} ${flags} \\
      --output-schema "$SCHEMA" -o "$OUT" - < "$TASK" >/dev/null 2>"$ERR"
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$OUT" ]; then cat "$OUT"; break; fi
    if grep -qiE "429|rate.?limit|timed out|temporarily|http 5[0-9][0-9]" "$ERR" && [ "$attempt" -lt ${maxAttempts} ]; then
      sleep $((attempt * 8)); continue   # backoff; never retry immediately (that EXTENDS an RPM block)
    fi
    printf '%s' '{"_codex_error":true}'; break   # transient budget spent, OR a hard 400/auth error → no data
  done

Return EXACTLY what the script printed to stdout — no prose, no markdown fences.`,
    {
      label: label ?? 'codex', phase, model: 'opus',   // relay wrapper pinned (avoids agentType Haiku default)
      schema: revalidate ? { anyOf: [schema, CODEX_ERROR_SCHEMA] } : undefined,
    },
  )
}
```

Three rules are still load-bearing — keep them intact in any copy:

1. **"Relay, not solver."** The wrapping Claude subagent is smart and will be tempted
   to answer the question itself, silently turning the cross-model node back into a
   Claude node. The preamble forbids it; keep it at full strength.
2. **Extract from `-o`, not stdout.** `-o "$OUT"` is the clean-JSON path; stdout has
   session chrome around it. The helper reads `"$OUT"`.
3. **Payload via stdin (`- < "$TASK"`), never as a shell argument** — and via a
   *single-quoted, salted* heredoc so `$(...)`, backticks, and stray delimiter lines
   in the payload are inert.

`revalidate: true` (default) re-validates Codex's JSON (as `anyOf[schema, error]`) and
returns a parsed object — best for small structured payloads. For large outputs set
`revalidate: false` and `JSON.parse` the relayed string yourself (see Variants).

---

## Template 1 — Cross-model review (Claude find → Codex verify → Claude synthesize)

The canonical Pattern A, and the shape to reach for by default. **Claude** does all
the breadth and file-reading (fast, cache-warm, high concurrency); **Codex** only
adversarially verifies **small, self-contained findings** (each a few seconds);
**Claude** synthesizes. Verification **fails closed**: a finding a Codex node could
not reach is `unverified`, never silently dropped into "confirmed".

```js
export const meta = {
  name: 'cross-model-review',
  description: 'Claude finds across dimensions; Codex adversarially verifies each finding; Claude synthesizes. Fails closed.',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

/* paste the helper block from the top of this file */

// Role policy — pin ONCE, spread everywhere. See SKILL.md "Stability & routing".
const OPUS         = { model: 'opus' }
const CODEX_VERIFY = { model: 'gpt-5.6-sol', effort: 'xhigh' }  // best model; small verify = ~7-9s at any effort

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
  d => agent(d.findPrompt, { ...OPUS, label: `find:${d.key}`, phase: 'Find', schema: FINDINGS }),   // Claude finds
  (review, d) => parallel((review?.findings ?? []).map(f => () =>
    codexGate(() => codexNode(                                                                        // Codex verifies (gated, short)
      `Adversarially verify this finding. Default refuted=true if you cannot confirm it from the evidence.\nTITLE: ${f.title}\nFILE: ${f.file}\nDETAIL: ${f.detail}`,
      { ...CODEX_VERIFY, schema: VERDICT, phase: 'Verify', label: `codex:${d.key}:${f.id}` },
    )).then(v => ({ ...f, dimension: d.key, verdict: v })))),
)

// FAIL CLOSED: partition, never silently filter. "confirmed" must mean a different
// model family actively could NOT refute it — not "the verifier happened to die".
const flat       = results.flat().filter(Boolean)
const unverified = flat.filter(f => !f.verdict || f.verdict._codex_error)
const refuted    = flat.filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === true)
const confirmed  = flat.filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false)
if (unverified.length) log(`⚠ ${unverified.length}/${flat.length} findings UNVERIFIED (Codex failed) — result is INCOMPLETE`)

phase('Synthesize')
const report = await agent(
  `Synthesize the confirmed findings into a report. If any findings are unverified, say so explicitly up top.\nCONFIRMED: ${JSON.stringify(confirmed)}\nUNVERIFIED (Codex could not reach these): ${JSON.stringify(unverified.map(f => f.title))}`,
  { ...OPUS, label: 'synthesize' },
)

return { status: unverified.length ? 'incomplete' : 'complete', report, confirmed, refuted, unverified }
```

> **Do NOT invert this.** Putting Codex in the *find* stage (reading many files at high
> effort, fanned out wide) is the one shape that reliably throttles: several long,
> high-token runs at once drain RPM/TPM. Keep Codex on small self-contained verifies.
> If a verify genuinely needs file context, see the `cwd` (`-C`) variant in Variants —
> and gate it to 1–2 concurrent.

---

## Template 2 — Judge panel with a Codex juror

Generate N candidates from different angles (optionally one by Codex for true
diversity), then score each with a mixed jury so no candidate is judged only by its
own author's model. **Requires a successful cross-family juror** before it will crown
a winner.

```js
export const meta = {
  name: 'mixed-judge-panel',
  description: 'Diverse candidate solutions scored by a Claude+Codex jury; refuses to pick a winner without a live Codex juror',
  phases: [{ title: 'Generate' }, { title: 'Judge' }, { title: 'Synthesize' }],
}

/* paste the helper block from the top of this file */

const OPUS         = { model: 'opus' }
const CODEX_VERIFY = { model: 'gpt-5.6-sol', effort: 'xhigh' }

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
const candidates = (await parallel([
  ...ANGLES.map(a => () => agent(a.prompt, { ...OPUS, label: `gen:${a.key}`, schema: SOLUTION })
    .then(s => ({ ...s, author: `claude:${a.key}` }))),
  () => codexGate(() => codexNode(`${TASK}\nPropose the approach you think is most robust.`,
        { ...CODEX_VERIFY, schema: SOLUTION, label: 'gen:codex' })).then(s => ({ ...s, author: 'codex' })),
])).filter(Boolean).filter(c => !c._codex_error)

phase('Judge')
const judged = await parallel(candidates.map((c, i) => () => parallel([
  () => agent(`Score this approach 0..10 for the problem.\n${JSON.stringify(c)}`, { ...OPUS, label: `judge:claude:${i}`, schema: SCORE }),
  () => codexGate(() => codexNode(`Score this approach 0..10 for the problem.\n${JSON.stringify(c)}`, { ...CODEX_VERIFY, schema: SCORE, label: `judge:codex:${i}` })),
]).then(([claudeScore, codexScore]) => {
  const valid = [claudeScore, codexScore].filter(s => s && !s._codex_error)   // exclude errored jurors from the average
  const codexAlive = codexScore && !codexScore._codex_error
  const avg = valid.reduce((a, s) => a + (s.score ?? 0), 0) / (valid.length || 1)
  return { candidate: c, avg, codexAlive, scores: valid }
})))

const scored = judged.filter(Boolean)
// FAIL CLOSED: don't crown a winner unless at least one candidate got a live Codex juror.
if (!scored.some(j => j.codexAlive)) return { status: 'incomplete', reason: 'no Codex juror succeeded', ranking: scored.map(j => ({ author: j.candidate.author, avg: j.avg })) }
const winner = scored.sort((a, b) => b.avg - a.avg)[0]

phase('Synthesize')
const final = await agent(
  `Write the final approach. Base it on the winner, grafting the best ideas from the runners-up.\nWINNER: ${JSON.stringify(winner.candidate)}\nALL: ${JSON.stringify(scored.map(j => ({author: j.candidate.author, avg: j.avg})))}`,
  { ...OPUS },
)
return { status: 'complete', final, winner: winner.candidate.author, ranking: scored.map(j => ({ author: j.candidate.author, avg: j.avg })) }
```

---

## Template 3 — Cross-check one risky conclusion

Minimal blend: Claude does the work, and a single Codex node tries to refute the
headline conclusion before reporting it. Cheap insurance for a high-stakes claim — a
good place to spend `effort: 'max'` (or `ultra`), since it's ONE node, not a fan-out.

```js
export const meta = {
  name: 'codex-crosscheck',
  description: 'Claude concludes; Codex attempts to refute before reporting',
  phases: [{ title: 'Conclude' }, { title: 'Cross-check' }],
}

/* paste the helper block from the top of this file */

const OPUS = { model: 'opus' }
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['refuted', 'confidence', 'reasoning'],
  properties: { refuted: {type:'boolean'}, confidence: {type:'number'}, reasoning: {type:'string'} },
}

phase('Conclude')
const conclusion = await agent('Analyze <X> and state your single headline conclusion with evidence.', { ...OPUS })

phase('Cross-check')
const verdict = await codexNode(   // single load-bearing node → spend the effort
  `A Claude analysis concluded the following. Adversarially try to refute it; default to refuted=true if the evidence is not airtight.\n\n${conclusion}`,
  { model: 'gpt-5.6-sol', effort: 'max', schema: VERDICT, label: 'codex:crosscheck' },
)
const ok = verdict && !verdict._codex_error
return {
  conclusion,
  codex_verdict: verdict,
  status: ok ? 'complete' : 'incomplete',                    // fail closed: an errored cross-check is NOT a pass
  trustworthy: ok && verdict.refuted === false,
}
```

---

## Template 4 — Loop-until-dry with a Codex gate

Iterate Claude-find → Codex-verify until a round surfaces no NEW findings (or a
max-rounds cap). Exhaustion is judged on *confirmed* survivors. **A finding is only
marked "seen" after it is successfully verified** — so a finding whose verifier errored
is retried next round rather than lost forever.

```js
export const meta = {
  name: 'loop-until-dry-codex',
  description: 'Iterate Claude-find -> Codex-verify until a round adds no new confirmed findings',
  phases: [{ title: 'Hunt' }],
}

/* paste the helper block from the top of this file */

const OPUS         = { model: 'opus' }
const CODEX_VERIFY = { model: 'gpt-5.6-sol', effort: 'xhigh' }

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'title', 'detail'],
    properties: { id: {type:'string'}, title: {type:'string'}, detail: {type:'string'} },   // finder assigns a STABLE id
  } } },
}
const VERDICT = {
  type: 'object', additionalProperties: false, required: ['refuted', 'reasoning'],
  properties: { refuted: {type:'boolean'}, reasoning: {type:'string'} },
}

const MAX_ROUNDS = 4          // Workflow JS forbids unbounded loops / Date.now / Math.random — always cap.
const confirmed = []
const seen = new Set()        // stable ids successfully verified (confirmed OR refuted) so far
let roundsUsed = 0

for (let round = 0; round < MAX_ROUNDS; round++) {
  roundsUsed = round + 1
  phase(`Round ${roundsUsed}`)
  const known = [...seen].join(', ') || '(none yet)'
  const review = await agent(
    `Find issues in <the target>. Assign each a STABLE id. Do NOT repeat already-resolved ids: ${known}. Return structured findings.`,
    { ...OPUS, label: `find:r${round}`, schema: FINDINGS },
  )
  const fresh = (review?.findings ?? []).filter(f => !seen.has(f.id))
  if (fresh.length === 0) break                       // dry round -> done
  const verdicts = await parallel(fresh.map(f => () =>
    codexGate(() => codexNode(`Adversarially verify, defaulting to refuted=true if uncertain:\n${f.title}\n${f.detail}`,
      { ...CODEX_VERIFY, schema: VERDICT, label: `codex:${f.id}` })).then(v => ({ ...f, verdict: v }))))
  for (const f of verdicts.filter(Boolean)) {
    if (!f.verdict || f.verdict._codex_error) continue         // verifier died → do NOT mark seen; retry next round
    seen.add(f.id)                                             // resolved → don't re-hunt
    if (f.verdict.refuted === false) confirmed.push(f)
  }
}
return { confirmed, rounds_used: roundsUsed }
```

---

## Variants & notes

### The `cwd` (`-C`) variant — let Codex read files itself

When the thing to verify *is* large (a big diff, several files), don't inline the
contents into `taskText`. Point Codex at the tree: pass `cwd: '<abs dir>'` (→ `-C`)
and name the files in the prompt. `read-only` blocks writes, **not reads**.

**Caveat (learned the hard way):** a `-C` node reading files at high effort is no
longer "short". Several of them fanned out wide is exactly what drains RPM/TPM and
throttles. So for `-C` verify nodes: prefer `effort: 'high'`, use a **tighter gate**
(`makeLimiter(2)`), or do it as a single node. Never fan a `-C` + `max` node out wide.

### Batch codex node — verify/judge N small items in one Codex run

When items are **small and homogeneous** and one Codex context holds them, batch them:
one slot, one run, results keyed back by id. The one-result-per-id contract is enforced
in code (set equality), not trusted from prose.

```js
// instruction: what to do per item. items: [{ id, ... }]. schema: the BATCH shape below.
function codexBatchNode(instruction, items, opts = {}) {
  const ids = items.map(i => i.id)
  const taskText = `${instruction}
Return EXACTLY one result object per input id, in a "results" array — same ids, no extras, no omissions.
INPUT ITEMS (JSON array):
${JSON.stringify(items)}`
  return codexNode(taskText, opts).then(res => {
    if (!res || res._codex_error) return { _codex_error: true, missing: ids }   // whole batch is "no data"
    const got = new Set((res.results ?? []).map(r => r.id))
    const missing = ids.filter(id => !got.has(id))
    const dupes   = (res.results ?? []).length !== got.size
    if (missing.length || dupes) return { ...res, _batch_incomplete: true, missing }   // caller retries missing ids individually
    return res
  })
}

const BATCH_VERDICTS = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'refuted', 'reasoning'],
    properties: { id: {type:'string'}, refuted: {type:'boolean'}, reasoning: {type:'string'} },
  } } },
}

// usage: verify all findings in ONE codex run, then key verdicts back by id.
const batch = await codexBatchNode(
  'Adversarially verify each finding; default refuted=true if uncertain.',
  findings.map(f => ({ id: f.id, title: f.title, detail: f.detail })),
  { model: 'gpt-5.6-sol', effort: 'xhigh', schema: BATCH_VERDICTS, label: 'codex:batch-verify' },
)
const byId = new Map((batch && !batch._codex_error ? batch.results : []).map(r => [r.id, r]))
// findings whose id is absent from byId are UNVERIFIED — treat them fail-closed, or retry individually.
```

### Large payloads — skip Workflow re-validation, parse the string yourself

`revalidate: true` (default) re-validates and auto-parses — best for small
verdicts/scores. For a **large** structured output, set `revalidate: false`, relay the
raw string (Codex's own `--output-schema` still enforces shape), and parse it with the
same `_codex_error` convention:

```js
const raw = await codexNode(bigTask, { schema: BIG_SCHEMA, revalidate: false, label: 'codex:big' })
let obj
try { obj = JSON.parse(raw) } catch { obj = { _codex_error: true } }
```

### `_codex_error` discipline (applies to every template)

A node returns `{ _codex_error: true }` on failure — **after** it has already spent its
bounded transient retries. Treat it as **"no data"**, never as a pass/refute:

- **Fail closed.** Partition into `confirmed` / `refuted` / `unverified` and surface the
  `unverified` count (Template 1). An empty `confirmed` set must never be
  indistinguishable from "everything was refuted".
- In a judge panel, **exclude** errored jurors from the average, and refuse to crown a
  winner unless a live cross-family juror scored (Template 2).
- In a loop, mark an id `seen` only **after** successful verification (Template 4).
- If more than a small fraction of nodes return `_codex_error` in a run, stop and re-run
  the preflight — that signals auth expiry or a bad schema, not flakiness.

Full failure-mode table in `codex-headless.md` → Troubleshooting.

### Notes that apply to all templates

- **Keep Codex nodes short** (read-only verify/judge/small-gen). Small self-contained
  verifies are ~7-9s on `gpt-5.6-sol` at *any* effort — latency is dominated by context
  size, not effort — so pick effort for QUALITY, and keep the *task* small.
- **Cap concurrency** with `codexGate` (default 4; 1–2 for `-C`/large nodes). This is
  below the Workflow's global cap on purpose — see SKILL.md "Stability & routing".
- **Schemas must be strict** — `additionalProperties: false` **and** every key from
  `properties` listed in `required` (OpenAI 400s on a partial `required` *before the run
  starts*). The helper's revalidation is `anyOf[yourSchema, CODEX_ERROR_SCHEMA]` so the
  error sentinel can pass; keep *your* success schema strict.
- **Pin model/effort per role, don't rely on defaults.** `agent()` → `model: 'opus'`
  (agentType defaults can silently be Haiku); Codex verify → `{ model: 'gpt-5.6-sol',
  effort: 'xhigh' }`, a single load-bearing cross-check → `effort: 'max'`/`ultra`.
  Fully-qualified tier IDs only (bare `gpt-5.6` 400s on ChatGPT auth). Tier table and
  caveats: `codex-headless.md` → "Model tiers & reasoning effort".
