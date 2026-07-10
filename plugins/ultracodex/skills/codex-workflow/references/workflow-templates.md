# Workflow templates — Codex blended in (Pattern A)

Copy-paste starting points. Each template is a complete Workflow script (begins
with `export const meta`). Adapt the prompts, schemas, and item lists to the task.

The **canonical helper block (`codexNode` + `safeDelim` + `shq` + `makeLimiter`/
`codexDefaultGate` + `codexError`) is defined ONCE at the top of this file** — it is
the single source of truth. Each template below assumes it is in scope and shows only
a `/* paste the helper block from the top of this file */` stub. In a real script,
define the block once near the top.

> **v0.2.1 hardening (this fork).** The helper is injection/delimiter-safe (salted
> heredoc + POSIX-quoted args + validated options), **self-gates** the ≤4 concurrency
> cap (you can't forget it), returns a **structured** failure sentinel
> `{_codex_error, kind, attempts}`, retries only *classified transient* errors with
> backoff, supports an opt-in per-attempt timeout, and parses Codex output in JS
> (Codex's own `--output-schema` enforces shape — a top-level tool-schema `anyOf`/union
> is rejected by the Anthropic API, so we do NOT use one). Templates **fail closed** — a
> dead Codex node surfaces as `unverified`/`incomplete`, never as a silent pass.
> Rationale + empirical numbers: `SKILL.md` → "Stability & routing".

## Contents

- **The helper block** — `codexNode`, `safeDelim`, `shq`, `makeLimiter`/`codexDefaultGate`, `codexError`.
- **Template 1 — Cross-model review** (Claude find → Codex verify → Claude synthesize): the default; fails closed.
- **Template 2 — Judge panel with a Codex juror**: mixed jury; only ranks fully cross-family-judged candidates.
- **Template 3 — Cross-check one risky conclusion**: minimal; one cross-check.
- **Template 4 — Loop-until-dry with a Codex gate**: iterate find → verify; carries failed verifies forward; fails closed at the cap.
- **Variants & notes**: batch node, large-payload (`revalidate:false`), `cwd` (`-C`) variant, error discipline.
- **Deferred (v0.3 roadmap)**.

---

## The helper block

Paste this whole block once near the top of your script.

```js
// ── allowlists & tiny utilities ──────────────────────────────────────────────
const CODEX_EFFORTS   = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CODEX_SANDBOXES = ['read-only', 'workspace-write']
const CODEX_MODEL_RE  = /^[A-Za-z0-9._-]+$/          // tier IDs only; blocks shell metachars

// POSIX single-quote every dynamic shell value: wrap in '…', escaping embedded quotes.
const shq = s => `'` + String(s).replace(/'/g, `'"'"'`) + `'`

// Deterministic heredoc delimiter guaranteed absent from `text` (Workflow JS has no
// Math.random). Stops payload content that contains the delimiter from closing it early.
function safeDelim(text, base = 'CDX_EOF') { let d = base; while (text.includes(d)) d += '_X'; return d }

// Concurrency limiter — releases the slot even if fn throws synchronously or returns a
// non-Promise; validates max. This is what makes the ≤N cap real, not advisory.
function makeLimiter(max) {
  if (!Number.isInteger(max) || max < 1) throw new Error(`makeLimiter: max must be a positive integer, got ${max}`)
  let active = 0; const q = []
  const pump = () => { while (active < max && q.length) { active++; q.shift()() } }
  return fn => new Promise((resolve, reject) => {
    q.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump() }))
    pump()
  })
}
// The cap is INTRINSIC: codexNode routes through this shared gate by default, so you
// cannot forget it. Heavy/large-context nodes pass a tighter one: gate: makeLimiter(2).
const codexDefaultGate = makeLimiter(4)

// Structured failure sentinel — always "no data", never a pass/refute. `kind` classifies.
const codexError = (kind, attempts) => ({ _codex_error: true, kind, attempts })

// ── the hardened codexNode ───────────────────────────────────────────────────
// model/effort are optional and OMITTED when unset (install-agnostic — CLI default
// applies). Pin them per node via a role policy const (see the templates).
function codexNode(taskText, {
  schema, sandbox = 'read-only', model, effort, cwd,
  revalidate = true, ephemeral = false, maxAttempts = 2, attemptTimeoutSec,
  gate = codexDefaultGate, phase, label,
} = {}) {
  if (typeof taskText !== 'string' || !taskText)          throw new Error('codexNode: taskText must be a non-empty string')
  if (effort && !CODEX_EFFORTS.includes(effort))          throw new Error(`codexNode: bad effort "${effort}"`)
  if (!CODEX_SANDBOXES.includes(sandbox))                 throw new Error(`codexNode: bad sandbox "${sandbox}"`)
  if (model && !CODEX_MODEL_RE.test(model))               throw new Error(`codexNode: bad model "${model}"`)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)  throw new Error('codexNode: maxAttempts must be a positive integer')
  if (attemptTimeoutSec != null && (!Number.isInteger(attemptTimeoutSec) || attemptTimeoutSec < 1))
    throw new Error('codexNode: attemptTimeoutSec must be a positive integer')
  const schemaJson = JSON.stringify(schema, null, 2)
  if (schemaJson === undefined) throw new Error('codexNode: schema must be JSON-serializable')
  const sd = safeDelim(schemaJson, 'CDX_SCHEMA'); const td = safeDelim(taskText, 'CDX_TASK')
  const flags = [
    model     ? `-m ${shq(model)}` : '',
    effort    ? `-c model_reasoning_effort=${shq(effort)}` : '',
    cwd       ? `-C ${shq(cwd)}` : '',
    ephemeral ? '--ephemeral' : '',
  ].filter(Boolean).join(' ')
  const timeoutPrefix = attemptTimeoutSec ? `timeout -k 5 ${attemptTimeoutSec} ` : ''   // opt-in; needs coreutils `timeout`
  const run = () => agent(
    `You are a RELAY, not a solver. Do NOT attempt the task, reason about it, or use
your own judgment — answering it yourself defeats the point (a second, independent
model family). Run EXACTLY this and return what it prints, verbatim:

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
    ${timeoutPrefix}codex exec --skip-git-repo-check -s ${sandbox} ${flags} \\
      --output-schema "$SCHEMA" -o "$OUT" - < "$TASK" >/dev/null 2>"$ERR"
    rc=$?
    if [ "$rc" -eq 0 ] && [ -s "$OUT" ]; then cat "$OUT"; break; fi
    kind=unknown
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then kind=timeout
    elif grep -qiE '(^|[^0-9])429([^0-9]|$)|rate.?limit' "$ERR"; then kind=rate_limit
    elif grep -qiE '(^|[^0-9])5[0-9][0-9]([^0-9]|$)|server error|overloaded' "$ERR"; then kind=server
    elif grep -qiE '(^|[^0-9])40[13]([^0-9]|$)|unauthor|not logged in|codex login' "$ERR"; then kind=auth
    elif grep -qiE '(^|[^0-9])400([^0-9]|$)|unsupported_value|invalid_request|schema' "$ERR"; then kind=schema
    fi
    case "$kind" in
      rate_limit|server|timeout)
        if [ "$attempt" -lt ${maxAttempts} ]; then sleep $((attempt * 8)); continue; fi ;;
    esac
    printf '{"_codex_error":true,"kind":"%s","attempts":%s}' "$kind" "$attempt"; break
  done

Return EXACTLY what the script printed to stdout — no prose, no markdown fences.`,
    { label: label ?? 'codex', phase, model: 'opus' },   // NO tool schema (a top-level anyOf/union 400s); parse in JS
  ).then(raw => {
    if (!revalidate) return raw                            // large-payload path: caller parses
    if (raw == null || raw === '') return codexError('empty_output', maxAttempts)
    if (typeof raw === 'object') return raw                // defensive
    try { return JSON.parse(raw) } catch { return codexError('parse', maxAttempts) }
  })
  return gate ? gate(run) : run()
}
```

Load-bearing rules — keep them intact in any copy:

1. **"Relay, not solver."** The wrapping Claude subagent will be tempted to answer the
   question itself, silently collapsing the cross-model node into a Claude node. The
   preamble forbids it; keep it at full strength.
2. **Extract from `-o`, not stdout.** `-o "$OUT"` is the clean-JSON path.
3. **Payload via a single-quoted, salted heredoc + stdin** so `$(...)`, backticks, and
   stray delimiter lines in the payload are inert; every dynamic *flag* value is
   `shq`-quoted and options are validated (no shell injection through `model`/`cwd`/
   `effort`/`maxAttempts`).
4. **No tool schema on the relay `agent()`** — a top-level `anyOf`/union `input_schema`
   is rejected by the Anthropic API (`input_schema.type: Field required`). Codex's own
   `--output-schema` enforces the success shape; `codexNode` `JSON.parse`s the result and
   returns `{_codex_error, kind, attempts}` on failure. This also removes any nudge that
   could make the relay *fabricate* a fake success object.

`revalidate: true` (default) parses and returns an object. For large outputs set
`revalidate: false` and `JSON.parse` the relayed string yourself (see Variants).

---

## Template 1 — Cross-model review (Claude find → Codex verify → Claude synthesize)

The default shape. **Claude** does all breadth and file-reading; **Codex** adversarially
verifies **small, self-contained findings** (self-gated to ≤4 concurrent); **Claude**
synthesizes. Verification **fails closed**.

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
  properties: { refuted: {type:'boolean'}, confidence: {type:'number', minimum:0, maximum:1}, reasoning: {type:'string'} },
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
    codexNode(                                                                                        // Codex verifies (self-gated ≤4)
      `Adversarially verify this finding. Default refuted=true if you cannot confirm it from the evidence.\nTITLE: ${f.title}\nFILE: ${f.file}\nDETAIL: ${f.detail}`,
      { ...CODEX_VERIFY, schema: VERDICT, phase: 'Verify', label: `codex:${d.key}:${f.id}` },
    ).then(v => ({ ...f, dimension: d.key, verdict: v })))),
)

// FAIL CLOSED: partition, never silently filter.
const flat       = results.flat().filter(Boolean)
const unverified = flat.filter(f => !f.verdict || f.verdict._codex_error)
const refuted    = flat.filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === true)
const confirmed  = flat.filter(f => f.verdict && !f.verdict._codex_error && f.verdict.refuted === false)
if (unverified.length) log(`⚠ ${unverified.length}/${flat.length} findings UNVERIFIED (${unverified.map(f => f.verdict?.kind || 'null').join(',')}) — result is INCOMPLETE`)

phase('Synthesize')
const report = await agent(
  `Synthesize the confirmed findings into a report. If any findings are unverified, say so explicitly up top.\nCONFIRMED: ${JSON.stringify(confirmed)}\nUNVERIFIED (Codex could not reach these): ${JSON.stringify(unverified.map(f => f.title))}`,
  { ...OPUS, label: 'synthesize' },
)

return { status: unverified.length ? 'incomplete' : 'complete', report, confirmed, refuted, unverified }
```

> **The invariant is the cap, not the role.** Codex CAN do the finding/reading/research
> too — the hard rule is **≤4 concurrent Codex agents** (enforced intrinsically by
> `codexDefaultGate`). What throttles is *many long high-effort Codex runs at once*, not
> Codex reading per se: for long large-context nodes pass `gate: makeLimiter(2)`,
> `effort: 'high'`, and consider `attemptTimeoutSec` (see the `cwd` `-C` variant). Small
> self-contained verifies stay cheap at any effort.

---

## Template 2 — Judge panel with a Codex juror

Generate N candidates from different angles (optionally one by Codex), then score each
with a Claude+Codex jury. **Only candidates that received a full cross-family jury are
rankable** — a winner is never crowned on a Claude-only score, and solo scores are never
compared against mixed ones.

```js
export const meta = {
  name: 'mixed-judge-panel',
  description: 'Diverse candidates scored by a Claude+Codex jury; ranks only fully cross-family-judged candidates',
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
  properties: { score: {type:'number', minimum:0, maximum:10}, rationale: {type:'string'} },
}

const TASK = 'Design an approach to <the problem>.'
const ANGLES = [
  { key: 'mvp',  prompt: `${TASK}\nBias toward the simplest shippable version.` },
  { key: 'risk', prompt: `${TASK}\nBias toward de-risking the hardest unknown first.` },
]

phase('Generate')
// Validate BEFORE spreading, so a null/errored generation cannot survive as a candidate.
const candidates = (await parallel([
  ...ANGLES.map(a => () => agent(a.prompt, { ...OPUS, label: `gen:${a.key}`, schema: SOLUTION })
    .then(s => (s ? { ...s, author: `claude:${a.key}` } : null))),
  () => codexNode(`${TASK}\nPropose the approach you think is most robust.`, { ...CODEX_VERIFY, schema: SOLUTION, label: 'gen:codex' })
    .then(s => (s && !s._codex_error ? { ...s, author: 'codex' } : null)),
])).filter(Boolean)

phase('Judge')
const judged = (await parallel(candidates.map((c, i) => () => parallel([
  () => agent(`Score this approach 0..10 for the problem.\n${JSON.stringify(c)}`, { ...OPUS, label: `judge:claude:${i}`, schema: SCORE }),
  () => codexNode(`Score this approach 0..10 for the problem.\n${JSON.stringify(c)}`, { ...CODEX_VERIFY, schema: SCORE, label: `judge:codex:${i}` }),
]).then(([cl, cx]) => {
  const claudeAlive = cl && typeof cl.score === 'number'
  const codexAlive  = cx && !cx._codex_error && typeof cx.score === 'number'
  // Only a candidate scored by BOTH families is comparable; others get avg=null (ineligible).
  return { candidate: c, claudeAlive, codexAlive, avg: (claudeAlive && codexAlive) ? (cl.score + cx.score) / 2 : null }
})))).filter(Boolean)

// FAIL CLOSED: rank only fully cross-family-judged candidates.
const eligible = judged.filter(j => j.avg != null)
if (!eligible.length) return { status: 'incomplete', reason: 'no candidate received a full Claude+Codex jury', ranking: judged.map(j => ({ author: j.candidate.author, claudeAlive: j.claudeAlive, codexAlive: j.codexAlive })) }
const winner = eligible.sort((a, b) => b.avg - a.avg)[0]

phase('Synthesize')
const final = await agent(
  `Write the final approach. Base it on the winner, grafting the best ideas from the runners-up.\nWINNER: ${JSON.stringify(winner.candidate)}\nRANKING: ${JSON.stringify(eligible.map(j => ({ author: j.candidate.author, avg: j.avg })))}`,
  { ...OPUS },
)
return {
  status: eligible.length === candidates.length ? 'complete' : 'partial',   // some candidates weren't fully judged
  final, winner: winner.candidate.author,
  ranking: eligible.map(j => ({ author: j.candidate.author, avg: j.avg })),
}
```

---

## Template 3 — Cross-check one risky conclusion

Minimal blend: Claude concludes, a single Codex node tries to refute before reporting.
Cheap insurance for a high-stakes claim — a good place to spend `effort: 'max'`/`ultra`,
since it's ONE node, not a fan-out.

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
  properties: { refuted: {type:'boolean'}, confidence: {type:'number', minimum:0, maximum:1}, reasoning: {type:'string'} },
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
  conclusion, codex_verdict: verdict,
  status: ok ? 'complete' : 'incomplete',                    // fail closed: an errored cross-check is NOT a pass
  trustworthy: ok && verdict.refuted === false,
}
```

---

## Template 4 — Loop-until-dry with a Codex gate

Iterate Claude-find → Codex-verify until a genuinely dry round *and* nothing is pending.
Findings whose verifier errored are carried in `pending` and retried **directly** next
round (not dependent on the finder rediscovering them); at the round cap, leftovers are
returned as `unverified` with `status:'incomplete'`.

```js
export const meta = {
  name: 'loop-until-dry-codex',
  description: 'Iterate Claude-find -> Codex-verify; carry failed verifies forward; fail closed at the cap',
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
const confirmed = [], refuted = []
const resolved = new Set()    // ids successfully verified (confirmed OR refuted)
let pending = []              // findings whose verifier errored — retried directly
let finderDry = false, roundsUsed = 0

for (let round = 0; round < MAX_ROUNDS; round++) {
  roundsUsed = round + 1
  phase(`Round ${roundsUsed}`)
  let toVerify = [...pending]
  if (!finderDry) {
    const known = [...resolved].join(', ') || '(none yet)'
    const review = await agent(
      `Find issues in <the target>. Assign each a STABLE id. Do NOT repeat already-resolved ids: ${known}. Return structured findings.`,
      { ...OPUS, label: `find:r${round}`, schema: FINDINGS },
    )
    const fresh = (review?.findings ?? []).filter(f => !resolved.has(f.id) && !pending.some(p => p.id === f.id))
    if (fresh.length === 0) finderDry = true
    toVerify = [...pending, ...fresh]
  }
  if (toVerify.length === 0) break                    // finder dry AND nothing pending -> done
  pending = []
  const verdicts = await parallel(toVerify.map(f => () =>
    codexNode(`Adversarially verify, defaulting to refuted=true if uncertain:\n${f.title}\n${f.detail}`,
      { ...CODEX_VERIFY, schema: VERDICT, label: `codex:${f.id}` }).then(v => ({ ...f, verdict: v }))))
  for (const f of verdicts.filter(Boolean)) {
    if (!f.verdict || f.verdict._codex_error) { pending.push(f); continue }   // verifier died → retry next round
    resolved.add(f.id)
    ;(f.verdict.refuted === false ? confirmed : refuted).push(f)
  }
  if (finderDry && pending.length === 0) break
}
return {
  status: pending.length ? 'incomplete' : 'complete',
  confirmed, refuted, unverified: pending, rounds_used: roundsUsed,
}
```

---

## Variants & notes

### The `cwd` (`-C`) variant — let Codex read files itself

When the thing to verify *is* large (a big diff, several files), don't inline the
contents into `taskText`. Point Codex at the tree: `cwd: '<abs dir>'` (→ `-C`) and name
the files in the prompt. `read-only` blocks writes, **not reads**.

**A `-C` node is no longer "short".** Several of them at high effort at once drain
RPM/TPM. So for `-C` nodes pass `gate: makeLimiter(2)`, prefer `effort: 'high'`, and set
`attemptTimeoutSec` so a hung read can't hold a slot forever. `read-only` is **not a
confidentiality boundary** — Codex can read and transmit any file under `-C`; point it
only at trees you're comfortable sending to the Codex backend.

### Batch codex node — verify/judge N small items in one Codex run

When items are **small and homogeneous** and one Codex context holds them, batch them:
one slot, one run, results keyed back by id. The one-result-per-id contract is enforced
in code — missing, **extra**, and duplicate ids all mark the batch incomplete.

```js
function codexBatchNode(instruction, items, opts = {}) {
  const ids = items.map(i => i.id)
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dup.length) throw new Error(`codexBatchNode: duplicate input ids: ${[...new Set(dup)].join(',')}`)
  const expected = new Set(ids)
  const taskText = `${instruction}
Return EXACTLY one result object per input id, in a "results" array — same ids, no extras, no omissions.
INPUT ITEMS (JSON array):
${JSON.stringify(items)}`
  return codexNode(taskText, opts).then(res => {
    if (!res || res._codex_error) return { _codex_error: true, kind: res && res.kind, missing: ids }
    const out = res.results ?? []
    const outIds = out.map(r => r.id)
    const got = new Set(outIds)
    const missing = ids.filter(id => !got.has(id))
    const extras  = outIds.filter(id => !expected.has(id))
    const dupes   = outIds.length !== got.size
    if (missing.length || extras.length || dupes) return { ...res, _batch_incomplete: true, missing, extras }
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

const batch = await codexBatchNode(
  'Adversarially verify each finding; default refuted=true if uncertain.',
  findings.map(f => ({ id: f.id, title: f.title, detail: f.detail })),
  { model: 'gpt-5.6-sol', effort: 'xhigh', schema: BATCH_VERDICTS, label: 'codex:batch-verify' },
)
const byId = new Map((batch && !batch._codex_error && !batch._batch_incomplete ? batch.results : []).map(r => [r.id, r]))
// Any finding whose id is absent from byId is UNVERIFIED — treat fail-closed, or retry individually.
```

### Large payloads — skip parsing, handle the string yourself

```js
const raw = await codexNode(bigTask, { schema: BIG_SCHEMA, revalidate: false, label: 'codex:big' })
let obj
try { obj = JSON.parse(raw) } catch { obj = { _codex_error: true, kind: 'parse' } }
```

### Error discipline (applies to every template)

A node returns `{ _codex_error: true, kind, attempts }` on failure — **after** it has
spent its bounded transient retries. `kind` ∈ `rate_limit | server | timeout | auth |
schema | empty_output | parse | unknown`. Treat it as **"no data"**, never as pass/refute:

- **Fail closed.** Partition `confirmed`/`refuted`/`unverified`; return
  `status:'incomplete'` when required nodes failed (Templates 1/4). An empty `confirmed`
  set must never be indistinguishable from "everything was refuted".
- In a judge panel, exclude errored jurors and rank only fully cross-family-judged
  candidates (Template 2).
- Only `rate_limit`/`server`/`timeout` are retried; `auth`/`schema`/`unknown` are not
  (retrying them wastes quota or extends an RPM block). A run with many `_codex_error`s
  → stop and re-run the preflight.

### Notes that apply to all templates

- **The ≤4 cap is intrinsic** (`codexDefaultGate`) — do NOT wrap calls in an outer gate
  (that double-gates and can deadlock). Pass `gate: makeLimiter(2)` on a call for heavy
  nodes; a shared tighter gate for a group is fine as long as it's a *single* gate.
- **Keep Codex nodes short.** Small self-contained verifies are ~7-9s on `gpt-5.6-sol` at
  *any* effort — latency scales with context, not effort — so pick effort for QUALITY and
  keep the *task* small.
- **Strict success schemas** — `additionalProperties: false` and every `properties` key in
  `required` (OpenAI 400s on a partial `required`). Codex's `--output-schema` enforces the
  shape; `codexNode` parses the result in JS.
- **Pin model/effort per role.** `agent()` → `model: 'opus'` (agentType defaults can be
  Haiku); Codex verify → `{ model: 'gpt-5.6-sol', effort: 'xhigh' }`; single load-bearing
  cross-check → `effort: 'max'`/`ultra`. Fully-qualified tier IDs only. See `codex-headless.md`
  → "Model tiers & reasoning effort".

---

## Deferred (v0.3 roadmap)

High-value, larger items intentionally NOT in v0.2.1 — build next:

- **Automated test harness** — a fake `codex` on `PATH` + a node test suite for hostile
  payloads, delimiter collisions, option validation, empty/stale output, retry decisions,
  cleanup, concurrency, and batch integrity; one opt-in live-CLI smoke. (Generate the
  helper markdown from tested source so docs can't drift.)
- **Audit / provenance mode** (`audit:true`) — run `codex exec --json` alongside `-o`,
  return an envelope with CLI version, requested vs reported model/effort, session id,
  token usage, attempts, and content hashes. Operational provenance, not attestation.
- **Versioned `--json` error classifier** — parse machine-readable terminal/error events
  instead of the stderr regex fallback; contract-test event shapes per CLI version.
- **Hermetic verifier mode** — `--ignore-user-config` (+ document what config/MCP/hooks/
  rules remain loaded); real worktree isolation for parallel `workspace-write` nodes.
