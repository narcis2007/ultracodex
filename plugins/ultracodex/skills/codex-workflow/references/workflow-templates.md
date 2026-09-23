# Workflow templates — Codex blended in (Pattern A)

Two ways to use Codex nodes in a Workflow:

1. **Run a shipped workflow** (tested, no copy-paste). Invoke by name with `args`:

   | Workflow | What it does | Key args |
   | --- | --- | --- |
   | `ultracodex:cross-review` | Claude finders per dimension → Codex refutes each finding against the code → Claude report | `target`, `cwd`, `dimensions`, `verifyTier: 'daily'\|'final'`, `context`, `lessons`, `batch` |
   | `ultracodex:codex-review` | Codex reviews through lenses (code, domain, security, tests, performance) → Claude checks each finding in the code → report | `cwd`, `base` \| `commit` \| `uncommitted`, `lenses`, `tier: 'daily'\|'final'`, `context`, `lessons`, `triage` |
   | `ultracodex:crosscheck` | one Codex attempt to refute one load-bearing claim (astra@max) | `claim`, `evidence`, `cwd`, `tier` |
   | `ultracodex:judge-panel` | Claude angles + a Codex candidate, Claude+Codex jury, cross-family ranking, synthesis | `problem`, `angles`, `cwd`, `codexCandidate` |

   Example: `Workflow({ name: 'ultracodex:cross-review', args: { cwd: 'C:/repo', verifyTier: 'final' } })`.

2. **Write a custom script** when none fits: paste the helper block below once near the top,
   then call `codexNode(...)` wherever a node should run on Codex. The templates further down
   are starting points (they assume the helper is pasted where the stub comment is).

## The helper block

`codexNode(task, opts)` — `opts`: `schema` (strict JSON Schema) or `schemaPreset`
(`verdict` · `score` · `review` · `implement`), `tier` (`light` · `daily` · `final`), `kind`
(`verify` · `ask` · `review`), optional `model`/`effort` overrides, `cwd` (the tree Codex may
read), `timeoutSec`, `maxAttempts`, `label`, `phase`, `meta`. It resolves to the parsed object
(provenance in the non-enumerable `_codex`), the final text (no schema), or
`{ _codex_error: true, kind, message, retryable, runId }`. Always test with `isCodexError(x)`.

Also in the block: `codexBatchNode(instruction, items, opts)` (N small items, one Codex run,
id integrity enforced), `ucxPartition(items, verdictOf)` (fail-closed confirmed / refuted /
unverified), `isCodexError(x)` and `ucxError(kind, message)`.

<!-- BEGIN ULTRACODEX HELPER (generated from tools/src/helper.js) -->

```js
// ── ultracodex helper v0.3.0 ───────────────────────────────────────────────────
// Generated from tools/src/helper.js in the ultracodex repo — edit the source, then
// `npm run build`. Needs the ultracodex plugin (its `codex-relay` agent + runner).
//
// codexNode(task, opts) runs ONE Codex (GPT) job and resolves to:
//   • the parsed object when a schema/schemaPreset is given — with a non-enumerable
//     `_codex` provenance {runId, threadId, model, effort, usage, ...};
//   • the final text when there is no schema;
//   • or { _codex_error: true, kind, message, retryable, runId } — "no data", never a
//     pass or a refutation. Test with isCodexError(x) before using a result.
// Routing (runner policy): tier 'light' → gpt-6-luna@max · 'daily' → gpt-6-sol
// (xhigh for kind 'verify', max otherwise) · 'final' → gpt-6-astra@max. Pin
// model/effort only to override. Concurrency is capped intrinsically: 4 Codex jobs
// per workflow, an astra job counting as 2 — do not wrap calls in another gate.
const UCX_VERSION = '0.3.0'
const UCX_RELAY = 'ultracodex:codex-relay'
const UCX_TIER_MODEL = { light: 'gpt-6-luna', daily: 'gpt-6-sol', final: 'gpt-6-astra' }
const UCX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const UCX_KINDS = ['verify', 'ask', 'review']
const UCX_PRESETS = ['verdict', 'score', 'review', 'implement']
const UCX_LINE_MAX = 400
const UCX_PART_MAX = 1600

// Same normalization and hash as the runner, so it can prove the relay's copy exact.
const UCX_TRAILING_SPACE = new RegExp('[ ' + String.fromCharCode(0xa0) + ']+$', 'gm')
function ucxNormalize(text) {
  return String(text ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(UCX_TRAILING_SPACE, '').replace(/^\n+/, '').replace(/\n+$/, '')
}
function ucxHash(text) {
  let h = 0x811c9dc5
  const s = String(text)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
// No quote, backslash or invisible character survives into the relay's Bash command.
const UCX_ESCAPED = new Set([0x25, 0x5c, 0x27, 0x7f, 0xa0, 0x200b, 0x200c, 0x200d, 0x2028, 0x2029, 0xfeff,
  ...Array.from({ length: 0x20 }, (_, c) => c).filter(c => c !== 0x0a)])
function ucxEncode(text) {
  let out = ''
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    if (!UCX_ESCAPED.has(c)) out += ch
    else out += c === 0x25 ? '%25' : c === 0x5c ? '%5C' : c === 0x27 ? '%27' : '%u' + c.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
function ucxWrap(line) {
  const out = []
  let rest = line
  while (rest.length > UCX_LINE_MAX) {
    let cut = UCX_LINE_MAX
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1          // never split a surrogate pair
    out.push(rest.slice(0, cut) + '%+')
    rest = rest.slice(cut)
  }
  out.push(rest)
  return out
}
function ucxParts(lines) {
  const parts = []
  let current = [], size = 0
  for (const line of lines) {
    if (current.length && size + line.length + 1 > UCX_PART_MAX) { parts.push(current); current = []; size = 0 }
    current.push(line); size += line.length + 1
  }
  if (current.length) parts.push(current)
  return parts
}
function ucxDelimiter(lines) {
  let d = 'UCX_P'
  while (lines.some(l => l.includes(d))) d += 'X'
  return d
}

// Weighted limiter: capacity 4, an astra job weighs 2. Releases on throw.
function ucxMakeGate(capacity) {
  let used = 0
  const queue = []
  const pump = () => {
    while (queue.length && used + queue[0].weight <= capacity) {
      const job = queue.shift()
      used += job.weight
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { used -= job.weight; pump() })
    }
  }
  return (fn, weight = 1) => new Promise((resolve, reject) => {
    queue.push({ fn, weight: Math.min(Math.max(1, weight), capacity), resolve, reject }); pump()
  })
}
const ucxGate = ucxMakeGate(4)

function ucxError(kind, message, runId = null, retryable = false) {
  return { _codex_error: true, kind, message: String(message ?? '').slice(0, 500), retryable, runId }
}
function isCodexError(x) { return x == null || (typeof x === 'object' && x._codex_error === true) }

function ucxEnvelope(raw) {
  if (raw && typeof raw === 'object') return raw.ultracodex === 1 ? raw : null
  const lines = String(raw ?? '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^`+|`+$/g, '').trim()
    if (!line.startsWith('{') || !line.includes('"ultracodex"')) continue
    try { const obj = JSON.parse(line); if (obj && obj.ultracodex === 1) return obj } catch (e) { /* keep scanning */ }
  }
  return null
}

// The result also travels back through the relay (the model transcribes the runner's
// line); the runner's resultHash proves it arrived unchanged.
function ucxResultIntact(env) {
  if (!env || env.ok !== true) return true
  if (typeof env.resultHash !== 'string') return false
  const body = env.result !== undefined && env.result !== null ? JSON.stringify(env.result) : String(env.text ?? '')
  return ucxHash(body) === env.resultHash
}

function ucxUnwrap(env, raw, expectedTaskHash) {
  if (raw && typeof raw === 'object' && raw.__ucxRejected !== undefined) {
    return ucxError('relay_failed', 'the relay agent call failed: ' + raw.__ucxRejected)
  }
  if (!env) {
    return raw == null
      ? ucxError('relay_failed', 'the relay agent returned nothing')
      : ucxError('relay_no_envelope', 'relay reply carried no runner line: ' + String(raw).slice(0, 200))
  }
  if (env.ok === true && !ucxResultIntact(env)) {
    return ucxError('relay_corruption', 'the result changed on its way back through the relay (hash mismatch)', env.runId, true)
  }
  if (env.ok === true) {
    const p = env.provenance || {}
    if (!p.threadId || !(p.usage && p.usage.output_tokens > 0)) {
      return ucxError('no_provenance', 'result has no Codex thread id / token usage — not trusted', env.runId)
    }
    if (expectedTaskHash && p.taskHash !== expectedTaskHash) {
      return ucxError('relay_mismatch', 'the result belongs to a different request (taskHash ' + p.taskHash + ')', env.runId)
    }
    const prov = { runId: env.runId, threadId: p.threadId, model: p.model, effort: p.effort, tier: p.tier,
      usage: p.usage, durationMs: p.durationMs, attempts: p.attempts, codexVersion: p.codexVersion }
    if (env.result && typeof env.result === 'object') {
      Object.defineProperty(env.result, '_codex', { value: prov, enumerable: false })
      return env.result
    }
    if (typeof env.text === 'string') return env.text
    return ucxError('parse', 'runner envelope had neither result nor text', env.runId)
  }
  if (env.state === 'receiving') {
    return ucxError('relay_incomplete_upload', 'the relay uploaded ' + env.received + '/' + env.total + ' parts', null, true)
  }
  if (env.ok === null) {
    return ucxError('relay_gave_up', 'run ' + env.runId + ' is still ' + env.state + ' (collect: wait ' + env.runId + ')', env.runId, true)
  }
  const e = env.error || {}
  return ucxError(e.kind || 'unknown', e.message || env.state, env.runId || null, Boolean(e.retryable))
}

function codexNode(task, opts = {}) {
  const { schema = null, schemaPreset = null, tier = 'daily', kind = 'verify', model, effort, cwd, timeoutSec,
    maxAttempts = 2, orphanAfterSec, label, phase, meta } = opts
  if (typeof task !== 'string' || !task.trim()) throw new Error('codexNode: task must be a non-empty string')
  if (!UCX_TIER_MODEL[tier]) throw new Error('codexNode: tier must be light, daily or final')
  if (!UCX_KINDS.includes(kind)) throw new Error('codexNode: kind must be verify, ask or review (implementation is not a workflow node)')
  if (effort !== undefined && !UCX_EFFORTS.includes(effort)) throw new Error('codexNode: bad effort ' + effort)
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) throw new Error('codexNode: bad model ' + model)
  if (schema !== null && (typeof schema !== 'object' || Array.isArray(schema))) throw new Error('codexNode: schema must be an object')
  if (schema && schemaPreset) throw new Error('codexNode: give schema or schemaPreset, not both')
  if (schemaPreset && !UCX_PRESETS.includes(schemaPreset)) throw new Error('codexNode: bad schemaPreset ' + schemaPreset)
  if (timeoutSec !== undefined && !(Number.isInteger(timeoutSec) && timeoutSec >= 60)) throw new Error('codexNode: timeoutSec must be an integer >= 60')

  const text = ucxNormalize(task)
  // Workflow nodes are read-only and hermetic by construction; the runner refuses anything else from a relay.
  const header = { v: 1, tier, kind, sandbox: 'read-only', hermetic: true, maxAttempts, attached: true }
  if (model) header.model = model
  if (effort) header.effort = effort
  if (cwd) header.cwd = String(cwd).replace(/\\/g, '/')
  if (timeoutSec) header.timeoutSec = timeoutSec
  if (orphanAfterSec) header.orphanAfterSec = orphanAfterSec
  if (schemaPreset) header.schemaPreset = schemaPreset
  if (label) header.label = String(label).replace(/[^\w .:/@#+=-]/g, '_').slice(0, 120)
  if (meta !== undefined) header.meta = meta
  header.taskHash = ucxHash(text)
  header.schemaHash = ucxHash(schema ? JSON.stringify(schema) : 'null')
  header.h = ucxHash(JSON.stringify(header))                       // last: covers every field above

  const frame = [JSON.stringify(header), '---ULTRACODEX-SCHEMA---', schema ? JSON.stringify(schema) : 'null',
    '---ULTRACODEX-TASK---', text].join('\n')
  const lines = ['UCXF1', ...ucxEncode(frame).split('\n').flatMap(ucxWrap)]
  const parts = ucxParts(lines)
  const delim = ucxDelimiter(lines)
  const relayLabel = label || 'codex'
  const partHashes = parts.map(p => ucxHash(p.join('\n')))        // the runner refuses a part that differs
  // The runner allocates the upload id on part 1 ("part new"), so identical requests from
  // different workflows or sessions can never share (or clear) each other's upload.
  const startPrompt = [
    'ULTRACODEX START', 'PARTS: ' + parts.length, 'DELIMITER: ' + delim,
    'Part 1: node <runner> part new 1 ' + parts.length + ' <hash of part 1> — it prints the upload id.' +
      ' Parts k = 2..' + parts.length + ': node <runner> part <upload id> k ' + parts.length + ' <hash of part k>.' +
      " Each with <<'" + delim + "' + the part lines + " + delim + '. Resend a part the runner answers with part_rejected.',
    ...parts.flatMap((p, i) => ['=====' + delim + ' PART ' + (i + 1) + '/' + parts.length + ' ' + partHashes[i] + '=====', ...p, '=====' + delim + ' END=====']),
  ].join('\n')
  const weight = (model || UCX_TIER_MODEL[tier]) === 'gpt-6-astra' ? 2 : 1
  // agent() may reject (runtime error, exhausted budget): that is a failed node, never a vanished one.
  const call = async (prompt, callOpts) => {
    try { return await agent(prompt, callOpts) } catch (e) { return { __ucxRejected: String((e && e.message) || e) } }
  }

  return ucxGate(async () => {
    let raw = null, env = null
    for (let attempt = 0; attempt < 2; attempt++) {                // a corrupted copy is retried once, by a stronger relay
      raw = await call(startPrompt, {
        agentType: UCX_RELAY, label: relayLabel + (attempt ? ':retry' : ''), phase, ...(attempt ? { model: 'opus' } : { effort: 'low' }),
      })
      env = ucxEnvelope(raw)
      const corrupted = env && env.ok === false && env.error && env.error.kind === 'relay_corruption'
      const stuck = env && env.state === 'receiving'
      if (!corrupted && !stuck) break
    }
    // The relay stopped while the run is still going: a collector resumes polling
    // (the supervisor tears the run down if nobody polls for orphanAfterSec).
    for (let round = 0; env && env.ok === null && env.runId && round < 3; round++) {
      raw = await call('ULTRACODEX COLLECT\nRUN_ID: ' + env.runId, { agentType: UCX_RELAY, label: relayLabel + ':collect', phase, effort: 'low' })
      env = ucxEnvelope(raw)
    }
    // A result garbled on the way back is fetched again (it is stored by the runner).
    for (let round = 0; env && env.ok === true && env.runId && !ucxResultIntact(env) && round < 2; round++) {
      raw = await call('ULTRACODEX COLLECT\nRUN_ID: ' + env.runId, {
        agentType: UCX_RELAY, label: relayLabel + ':recollect', phase, ...(round ? { model: 'opus' } : { effort: 'low' }),
      })
      env = ucxEnvelope(raw)
    }
    return ucxUnwrap(env, raw, header.taskHash)
  }, weight)
}

// N small, homogeneous items in ONE Codex run, results keyed back by id. Missing,
// extra and duplicate ids mark the batch incomplete (fail closed).
const UCX_BATCH_VERDICTS = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'refuted', 'confidence', 'reasoning'],
    properties: { id: { type: 'string' }, refuted: { type: 'boolean' }, confidence: { type: 'number' }, reasoning: { type: 'string' } },
  } } },
}
function codexBatchNode(instruction, items, opts = {}) {
  const ids = items.map(i => String(i.id))
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dup.length) throw new Error('codexBatchNode: duplicate input ids: ' + [...new Set(dup)].join(','))
  const expected = new Set(ids)
  const task = instruction + '\nReturn EXACTLY one entry per input id in "results" — same ids, no extras, no omissions.\nINPUT ITEMS (JSON):\n' + JSON.stringify(items)
  return codexNode(task, { schema: UCX_BATCH_VERDICTS, ...opts }).then(res => {
    if (isCodexError(res)) return { ...ucxError(res ? res.kind : 'relay_failed', res ? res.message : ''), missing: ids, byId: new Map(), ambiguous: [], complete: false }
    const out = Array.isArray(res.results) ? res.results : []
    const count = new Map()
    for (const r of out) count.set(String(r.id), (count.get(String(r.id)) || 0) + 1)
    const missing = ids.filter(id => !count.has(id))
    const extras = [...count.keys()].filter(id => !expected.has(id))
    // An id answered twice is ambiguous: neither answer is used (never resolve by order).
    const ambiguous = [...count].filter(([id, n]) => n > 1 && expected.has(id)).map(([id]) => id)
    const byId = new Map(out.filter(r => expected.has(String(r.id)) && count.get(String(r.id)) === 1).map(r => [String(r.id), r]))
    return { byId, missing, extras, ambiguous, complete: !missing.length && !extras.length && !ambiguous.length, _codex: res._codex }
  })
}

// Fail-closed partition of verified items: an errored or missing verdict is
// UNVERIFIED — never silently a pass, never silently a refutation.
function ucxPartition(items, verdictOf = x => x.verdict) {
  const confirmed = [], refuted = [], unverified = []
  for (const item of items.filter(Boolean)) {
    const v = verdictOf(item)
    if (isCodexError(v)) unverified.push(item)
    else if (v.refuted === true) refuted.push(item)
    else if (v.refuted === false) confirmed.push(item)
    else unverified.push(item)
  }
  return { confirmed, refuted, unverified, status: unverified.length ? 'incomplete' : 'complete' }
}
// ── end ultracodex helper ──────────────────────────────────────────────────────
```

<!-- END ULTRACODEX HELPER -->

Rules the helper already enforces — do not work around them:

- **Relay, not solver.** Every node goes through the `ultracodex:codex-relay` agent (Bash only,
  Sonnet at low effort). It uploads the request, polls, and returns the runner's JSON line. A
  result without a Codex thread id and token usage is rejected (`no_provenance`), so a relay that
  "answers" by itself cannot pass as Codex.
- **Byte-exact or rejected.** The request is normalized, percent-encoded (no quote, backslash or
  control character reaches the relay's Bash command), split into ≤2.4 KB parts (the Windows
  command line breaks near 8 KB) and hash-checked by the runner. A corrupted copy is rejected
  (`relay_corruption`) and retried once with a stronger relay.
- **No slot is held by a blocked call.** Codex runs detached under the runner's supervisor, which
  owns the deadline and stops only the process tree it started. Each `wait` returns within two
  minutes, so the relay never hits the Bash timeout; if the relay stops polling for five minutes
  the supervisor tears the run down (`abandoned`).
- **Intrinsic concurrency cap:** 4 Codex jobs per workflow, an astra job counting as 2, plus the
  runner's machine-wide cap (`ULTRACODEX_MAX_CONCURRENT`, default 4). Don't add another gate.
- **Fail closed.** A dead node is unverified, never a pass: partition with `ucxPartition`, report
  `status: 'incomplete'` when a required node failed.

---

## Template — Cross-model review (custom variant)

Prefer the shipped `ultracodex:cross-review`. Copy this when you need different prompts.

```js
export const meta = {
  name: 'my-cross-review',
  description: 'Claude finds; Codex refutes each finding; Claude reports. Fails closed.',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

/* paste the helper block here */

const CWD = 'C:/path/to/repo'   // Codex reads the code itself (read-only, hermetic)
const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['id', 'title', 'file', 'detail'],
    properties: { id: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' } },
  } } },
}
const DIMENSIONS = ['correctness', 'security']

const results = await pipeline(
  DIMENSIONS,
  d => agent(`Review the branch in ${CWD} for ${d} issues. Concrete findings only.`, { label: 'find:' + d, phase: 'Find', schema: FINDINGS }),
  (review, d) => parallel(((review && review.findings) || []).map(f => () =>
    codexNode(`Adversarially verify this finding against the code; refuted=true unless the code confirms it.\n${JSON.stringify(f)}`,
      { schemaPreset: 'verdict', tier: 'daily', kind: 'verify', cwd: CWD, label: 'codex:' + d + ':' + f.id, phase: 'Verify' })
      .then(v => ({ ...f, dimension: d, verdict: v })))),
)
const part = ucxPartition(results.flat())
if (part.unverified.length) log(`⚠ ${part.unverified.length} findings UNVERIFIED — incomplete`)
phase('Synthesize')
const report = await agent(`Report CONFIRMED: ${JSON.stringify(part.confirmed)}\nUNVERIFIED (say so up top): ${JSON.stringify(part.unverified.map(f => f.title))}`, { label: 'synthesize' })
return { status: part.status, report, confirmed: part.confirmed, unverified: part.unverified }
```

## Template — Loop-until-dry with a Codex gate

Rounds of Claude finding → Codex verifying until a round is **fully judged** and adds nothing
confirmed. Findings whose verdict errored are carried to the next round and retried directly;
at the cap, leftovers are returned as unverified with `status: 'incomplete'`.

```js
export const meta = {
  name: 'loop-until-dry-codex',
  description: 'Iterate Claude-find → Codex-verify until a fully judged round confirms nothing new',
  phases: [{ title: 'Hunt' }],
}

/* paste the helper block here */

const CWD = 'C:/path/to/repo'
const FINDINGS = { /* strict schema: findings[{ id, title, detail }] with a STABLE id */ }
const MAX_ROUNDS = 4                  // always cap loops in Workflow JS
const confirmed = [], refuted = [], resolved = new Set()
let pending = [], finderDry = false, rounds = 0

for (let round = 0; round < MAX_ROUNDS; round++) {
  rounds = round + 1
  phase('Round ' + rounds)
  let toVerify = [...pending]
  if (!finderDry) {
    const review = await agent(`Find issues in ${CWD}. Stable ids. Skip these already-resolved ids: ${[...resolved].join(', ') || '(none)'}`,
      { label: 'find:r' + rounds, schema: FINDINGS })
    const fresh = ((review && review.findings) || []).filter(f => !resolved.has(f.id) && !pending.some(p => p.id === f.id))
    if (!fresh.length) finderDry = true
    toVerify = [...pending, ...fresh]
  }
  if (!toVerify.length) break
  pending = []
  const verdicts = await parallel(toVerify.map(f => () =>
    codexNode(`Adversarially verify; refuted=true unless the code confirms it.\n${JSON.stringify(f)}`,
      { schemaPreset: 'verdict', tier: 'daily', kind: 'verify', cwd: CWD, label: 'codex:' + f.id }).then(v => ({ ...f, verdict: v }))))
  for (const f of verdicts.filter(Boolean)) {
    if (isCodexError(f.verdict)) { pending.push(f); continue }      // no verdict → retry next round
    resolved.add(f.id)
    ;(f.verdict.refuted === false ? confirmed : refuted).push(f)
  }
  if (verdicts.filter(Boolean).every(f => isCodexError(f.verdict))) log('round ' + rounds + ': every Codex verdict errored — check `node <runner> preflight`')
  if (finderDry && !pending.length) break
}
return { status: pending.length ? 'incomplete' : 'complete', confirmed, refuted, unverified: pending, rounds }
```

## Batch node — N small items, one Codex run

```js
const batch = await codexBatchNode(
  'Adversarially verify each finding against the code; refuted=true unless confirmed.',
  findings.map(f => ({ id: f.id, title: f.title, detail: f.detail })),
  { tier: 'daily', kind: 'verify', cwd: CWD, label: 'codex:batch' },
)
// batch.byId: Map(id → {refuted, confidence, reasoning}); batch.missing / batch.extras;
// on failure batch is a _codex_error (with .missing = every id) — treat all as unverified.
```

## Picking tier & effort

Policy (enforced by the runner; override per node only with a reason):

| Node | tier / kind | Runs as |
| --- | --- | --- |
| wide fan-out of small checks, triage, dedupe | `light` / `verify` | gpt-6-luna @ max |
| everyday adversarial verify, jurors | `daily` / `verify` | gpt-6-sol @ xhigh |
| a second opinion, one lens of a review | `daily` / `ask` or `review` | gpt-6-sol @ max |
| final gate, load-bearing single verdict, hardest analysis | `final` / any | gpt-6-astra @ max |

`ultra` is never implicit: pass `effort: 'ultra'` on at most one decisive astra/sol node per run
(it delegates to sub-agents and runs long). Details: `model-policy.md`.

## Error discipline

`kind` values: `rate_limit` · `server` · `network` (retried by the runner with backoff) ·
`timeout` · `abandoned` · `cancelled` · `auth` · `usage_limit` · `model` · `effort` · `schema` ·
`schema_mismatch` · `parse` · `empty_output` · `invalid_request` · `execution` · `spawn` ·
relay-side `relay_corruption` · `relay_incomplete_upload` · `relay_gave_up` · `relay_failed` ·
`relay_no_envelope` · `relay_error` · `no_provenance` · `supervisor_lost`.

- Treat every one as **no data**. Exclude errored jurors from averages; never score them 0.
- Many errors in one run → stop and run `node <runner> preflight` (auth, catalog, CLI).
- `supervisor_lost` means the runner's supervisor died while Codex may still run: it is **not**
  stopped automatically — look at `node <runner> status` and ask the owner before stopping it.
