export const meta = {
  name: 'cross-review',
  description: 'Claude finds issues per dimension, Codex (GPT) adversarially verifies each against the code, Claude writes the report. Fails closed.',
  whenToUse: 'Review a change with a second model family refuting the findings. args: { target, cwd, dimensions, verifyTier: daily|final, context, lessons, batch }',
  phases: [
    { title: 'Find', detail: 'one Claude finder per dimension' },
    { title: 'Verify', detail: 'Codex refutes each finding (sol@xhigh, or astra@max when verifyTier is final)' },
    { title: 'Synthesize', detail: 'Claude writes the report; unverified findings are listed, never dropped' },
  ],
}

// Generated from tools/src/workflows/cross-review.js — edit the source, then `npm run build`.

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
let ucxCallCounter = 0

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

function ucxUnwrap(env, raw) {
  if (!env) {
    return raw == null
      ? ucxError('relay_failed', 'the relay agent returned nothing')
      : ucxError('relay_no_envelope', 'relay reply carried no runner line: ' + String(raw).slice(0, 200))
  }
  if (env.ok === true) {
    const p = env.provenance || {}
    if (!p.threadId || !(p.usage && p.usage.output_tokens > 0)) {
      return ucxError('no_provenance', 'result has no Codex thread id / token usage — not trusted', env.runId)
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
  const inbox = 'ucx-' + ucxHash(frame) + '-' + (++ucxCallCounter)
  const relayLabel = label || 'codex'
  const partHashes = parts.map(p => ucxHash(p.join('\n')))        // the runner refuses a part that differs
  const startPrompt = inboxId => [
    'ULTRACODEX START', 'INBOX: ' + inboxId, 'PARTS: ' + parts.length, 'DELIMITER: ' + delim,
    'For k = 1..' + parts.length + ' run: node <runner> part ' + inboxId + ' k ' + parts.length + ' <hash of part k>' +
      " <<'" + delim + "' + part k lines + " + delim + ' — resend a part the runner answers with part_rejected.',
    ...parts.flatMap((p, i) => ['=====' + delim + ' PART ' + (i + 1) + '/' + parts.length + ' ' + partHashes[i] + '=====', ...p, '=====' + delim + ' END=====']),
  ].join('\n')
  const weight = (model || UCX_TIER_MODEL[tier]) === 'gpt-6-astra' ? 2 : 1

  return ucxGate(async () => {
    let raw = null, env = null
    for (let attempt = 0; attempt < 2; attempt++) {                // a corrupted copy is retried once, by a stronger relay
      raw = await agent(startPrompt(attempt ? inbox + '-r' : inbox), {
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
      raw = await agent('ULTRACODEX COLLECT\nRUN_ID: ' + env.runId, { agentType: UCX_RELAY, label: relayLabel + ':collect', phase, effort: 'low' })
      env = ucxEnvelope(raw)
    }
    return ucxUnwrap(env, raw)
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
    if (isCodexError(res)) return { ...ucxError(res ? res.kind : 'relay_failed', res ? res.message : ''), missing: ids }
    const out = Array.isArray(res.results) ? res.results : []
    const got = new Set(out.map(r => String(r.id)))
    const missing = ids.filter(id => !got.has(id))
    const extras = out.map(r => String(r.id)).filter(id => !expected.has(id))
    const byId = new Map(out.filter(r => expected.has(String(r.id))).map(r => [String(r.id), r]))
    return { byId, missing, extras, complete: !missing.length && !extras.length && got.size === out.length, _codex: res._codex }
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

const A = args || {}
const TARGET = A.target || 'the changes on the current branch against its merge-base with main, plus any uncommitted changes'
const CWD = A.cwd || null
const DIMENSIONS = Array.isArray(A.dimensions) && A.dimensions.length
  ? A.dimensions
  : ['correctness', 'security', 'concurrency-and-state', 'error-handling-and-edge-cases']
const VERIFY_TIER = A.verifyTier === 'final' ? 'final' : 'daily'
const BATCH = A.batch !== false
const CONTEXT = A.context ? '\nCONTEXT FROM THE OWNER:\n' + A.context : ''
const LESSONS = A.lessons ? '\nAlso apply the recurring-defect checklist in ' + A.lessons + ' (read it first).' : ''
const WHERE = CWD ? ' in the repository at ' + CWD : ' in the current repository'

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['id', 'title', 'file', 'line', 'detail', 'failure_scenario', 'severity'],
    properties: {
      id: { type: 'string' }, title: { type: 'string' }, file: { type: 'string' }, line: { type: ['integer', 'null'] },
      detail: { type: 'string' }, failure_scenario: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    },
  } } },
}

const findPrompt = d => `Review ${TARGET}${WHERE}. Focus ONLY on this dimension: ${d}.
Scope the change with git (diff against the merge-base, status for uncommitted work), then read the surrounding code.
Report only concrete, real issues: each with file, line, what is wrong, and a reachable failure scenario.
Give each finding a short stable id. If there is nothing real, return an empty list — do not pad.${CONTEXT}${LESSONS}`

const VERIFY_INSTRUCTION = `You are an adversarial verifier. Each item below is a finding another model reported about the code in your working directory.
For each one, read the cited file and surrounding code yourself and try to REFUTE it: is the failure scenario actually reachable?
Set refuted=false only when the code confirms the issue; if you cannot confirm it from the code, set refuted=true.
confidence is 0..1. reasoning must cite what you read.`

phase('Find')
const results = await pipeline(
  DIMENSIONS,
  d => agent(findPrompt(d), { label: 'find:' + d, phase: 'Find', schema: FINDINGS }),
  async (review, d) => {
    const findings = ((review && review.findings) || []).map((f, i) => ({ ...f, id: d + ':' + (f.id || i), dimension: d }))
    if (!findings.length) return []
    if (BATCH) {
      const batch = await codexBatchNode(VERIFY_INSTRUCTION,
        findings.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, detail: f.detail, failure_scenario: f.failure_scenario })),
        { tier: VERIFY_TIER, kind: 'verify', cwd: CWD || undefined, label: 'codex:' + d, phase: 'Verify' })
      return findings.map(f => ({
        ...f,
        verdict: isCodexError(batch) ? batch : (batch.byId.get(f.id) || ucxError('missing_from_batch', 'Codex returned no verdict for ' + f.id)),
      }))
    }
    return parallel(findings.map(f => () =>
      codexNode(VERIFY_INSTRUCTION + '\nFINDING (JSON):\n' + JSON.stringify(f),
        { schemaPreset: 'verdict', tier: VERIFY_TIER, kind: 'verify', cwd: CWD || undefined, label: 'codex:' + f.id, phase: 'Verify' })
        .then(v => ({ ...f, verdict: v }))))
  },
)

const all = results.flat().filter(Boolean)
const part = ucxPartition(all)
if (part.unverified.length) log('⚠ ' + part.unverified.length + '/' + all.length + ' findings UNVERIFIED — the result is incomplete')

phase('Synthesize')
const report = await agent(`Write a code-review report for ${TARGET}${WHERE}.
CONFIRMED findings (a second model family could not refute them) — rank by severity, give file:line, the failure scenario and a fix:
${JSON.stringify(part.confirmed)}
UNVERIFIED findings (the Codex verifier failed — state this plainly at the top; they are neither confirmed nor refuted):
${JSON.stringify(part.unverified.map(f => ({ id: f.id, title: f.title, file: f.file, why: f.verdict && f.verdict.kind })))}
REFUTED count: ${part.refuted.length} (list their titles briefly at the end).`, { label: 'synthesize', phase: 'Synthesize' })

return {
  status: part.status,
  report,
  confirmed: part.confirmed,
  refuted: part.refuted.map(f => ({ id: f.id, title: f.title, reasoning: f.verdict.reasoning })),
  unverified: part.unverified.map(f => ({ id: f.id, title: f.title, error: f.verdict && f.verdict.kind })),
}
