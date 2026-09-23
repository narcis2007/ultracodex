# Workflow templates — Codex blended in (Pattern A)

Two ways to use Codex nodes in a Workflow:

1. **Run a shipped workflow** (tested, no copy-paste). Invoke by name with `args`:

   | Workflow | What it does | Key args |
   | --- | --- | --- |
   | `ultracodex:cross-review` | Claude finders per dimension → Codex (sol@xhigh, batched) refutes each finding against the code → one astra@max run re-checks the confirmed high/critical ones → Claude report | `target`, `cwd`, `dimensions`, `verifyTier: 'daily'\|'final'`, `finalGate` (default on), `context`, `lessons`, `batch` |
   | `ultracodex:codex-review` | Codex reviews through lenses (code, domain, security, tests, performance) → Claude checks each finding in the code → high/critical disagreements go to astra@max in one run → report | `cwd`, `base` \| `commit` \| `uncommitted`, `lenses`, `tier: 'light'\|'daily'\|'final'`, `escalate` (default on), `context`, `lessons`, `triage` |
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
read), `timeoutSec`, `maxAttempts`, `orphanAfterSec` (default 900), `workItems` (set by
`codexBatchNode`), `label`, `phase`, `meta`. It resolves to the parsed object
(provenance in the non-enumerable `_codex`), the final text (no schema), or
`{ _codex_error: true, kind, message, retryable, runId }`. Always test with `isCodexError(x)`.

Also in the block: `codexBatchNode(instruction, items, opts)` (N small items, one Codex run,
id integrity enforced, deadline scaled to N), `ucxPartition(items, verdictOf)` (fail-closed
confirmed / refuted / unverified), `ucxUsage()` (tokens spent on Codex in this workflow, per
model — return it as `codexUsage`), `isCodexError(x)` and `ucxError(kind, message)`.

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
// No quote, backslash, control, format (bidi, zero-width, soft hyphen, tags), lone
// surrogate, separator other than the plain space, or variation selector reaches the
// relay's Bash command: they travel as %25 %5C %27 %uXXXX %UXXXXXX (same rule as the runner).
const UCX_INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zs}\p{Zl}\p{Zp}]/u
function ucxMustEscape(ch) {
  const c = ch.codePointAt(0)
  if (c === 0x0a || c === 0x20) return false
  if (c === 0x25 || c === 0x5c || c === 0x27) return true
  if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef)) return true
  return UCX_INVISIBLE.test(ch)
}
function ucxEncode(text) {
  let out = ''
  for (const ch of String(text)) {
    if (!ucxMustEscape(ch)) { out += ch; continue }
    const c = ch.codePointAt(0)
    out += c === 0x25 ? '%25' : c === 0x5c ? '%5C' : c === 0x27 ? '%27'
      : c > 0xffff ? '%U' + c.toString(16).toUpperCase().padStart(6, '0') : '%u' + c.toString(16).toUpperCase().padStart(4, '0')
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

// ── result authentication: HMAC-SHA256 in plain JS (the Workflow runtime has no crypto) ──
// The runner signs every result with a per-machine key; the helper fetches that key once
// per workflow through a relay whose context holds no untrusted text. A relay hijacked by
// reviewed content cannot compute an HMAC (the relay guard gives it no code), so it cannot
// pass its own answer off as Codex's.
const UCX_K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]
function ucxUtf8(str) {
  const out = []
  for (const ch of String(str)) {
    let c = ch.codePointAt(0)
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd                     // lone surrogate: what Node's UTF-8 encoder writes
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}
function ucxSha256(bytes) {
  const ror = (x, n) => (x >>> n) | (x << (32 - n))
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const m = bytes.slice()
  const bits = bytes.length * 8
  m.push(0x80)
  while (m.length % 64 !== 56) m.push(0)
  const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0
  m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const w = new Array(64)
  for (let i = 0; i < m.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = (m[i + 4 * t] << 24) | (m[i + 4 * t + 1] << 16) | (m[i + 4 * t + 2] << 8) | m[i + 4 * t + 3]
    for (let t = 16; t < 64; t++) {
      const s0 = ror(w[t - 15], 7) ^ ror(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = ror(w[t - 2], 17) ^ ror(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + UCX_K[t] + w[t]) | 0
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0
  }
  return H.flatMap(x => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255])
}
const ucxHex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('')
function ucxSha256Hex(text) { return ucxHex(ucxSha256(ucxUtf8(text))) }
function ucxHmacHex(keyHex, message) {
  let key = []
  for (let i = 0; i < keyHex.length; i += 2) key.push(parseInt(keyHex.slice(i, i + 2), 16))
  if (key.length > 64) key = ucxSha256(key)
  while (key.length < 64) key.push(0)
  const inner = ucxSha256(key.map(b => b ^ 0x36).concat(ucxUtf8(message)))
  return ucxHex(ucxSha256(key.map(b => b ^ 0x5c).concat(inner)))
}

// The key, fetched once per workflow by a relay that sees no untrusted text (the relay
// guard lets a relay read the key only if it never uploads or collects a job). keyCheck,
// the runner's hash of the key, catches a mis-copied key. Only a success is cached.
let ucxKeyPromise = null
function ucxKey(call, phase) {
  if (!ucxKeyPromise) {
    ucxKeyPromise = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const env = ucxEnvelope(await call('ULTRACODEX KEY', {
          agentType: UCX_RELAY, label: 'codex:key' + (attempt ? ':retry' : ''), phase, ...(attempt ? { model: 'opus' } : { effort: 'low' }),
        }))
        if (env && env.ok === true && /^[0-9a-f]{64}$/.test(String(env.key)) && ucxHash(env.key) === env.keyCheck) return env.key
      }
      return null
    })().then(key => { if (!key) ucxKeyPromise = null; return key })
  }
  return ucxKeyPromise
}

// Only a well-formed run id is ever put into another relay's prompt: a reply is untrusted.
const UCX_RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/
function ucxRunId(env) { return env && UCX_RUN_ID.test(String(env.runId)) ? env.runId : null }

// Tokens spent on Codex in this workflow, per model — returned by the shipped workflows as
// codexUsage so every run shows what the second opinion cost.
// Failed runs count too (a timed-out run still spent its tokens); their figures are the
// runner's report as relayed, not authenticated like a result.
const ucxLedger = {}
function ucxRecordUsage(prov, failed = false) {
  const model = (prov && prov.model) || 'unknown'
  const entry = ucxLedger[model] || (ucxLedger[model] = { runs: 0, failed: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 })
  entry.runs += 1
  if (failed) entry.failed += 1
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    const n = Number(((prov && prov.usage) || {})[k])
    if (Number.isFinite(n) && n > 0) entry[k] += n
  }
}
function ucxUsage() { return JSON.parse(JSON.stringify(ucxLedger)) }

function ucxEnvelope(raw) {
  if (raw && typeof raw === 'object') return raw.ultracodex === 1 ? raw : null
  const lines = String(raw ?? '').split(/\r?\n/).map(l => l.trim().replace(/^`+|`+$/g, '').trim())
  const parsed = []
  for (const line of lines) {
    if (!line.startsWith('{') || !line.includes('"ultracodex"')) continue
    try { const obj = JSON.parse(line); if (obj && obj.ultracodex === 1) parsed.push(obj) } catch (e) { /* not a runner line */ }
  }
  const env = [...parsed].reverse().find(o => o.page === undefined) || null
  if (env && env.paged) {
    // a large result arrives as a compact envelope plus `page` lines; stitch the body back
    const pages = []
    for (const o of parsed) if (o.page !== undefined && o.runId === env.runId && typeof o.data === 'string') pages[o.page] = o.data
    const body = Array.from({ length: env.paged.pages }, (_, i) => pages[i + 1])
    if (body.some(p => p === undefined)) return { ...env, __incompletePages: true }
    try {
      const whole = JSON.parse(body.join(''))
      const out = { ...env }
      delete out.paged
      if (whole.result !== undefined) out.result = whole.result
      else out.text = whole.text
      return out
    } catch (e) { return { ...env, __incompletePages: true } }
  }
  return env
}

function ucxBody(env) {
  return env.result !== undefined && env.result !== null ? JSON.stringify(env.result) : String(env.text ?? '')
}

// The result also travels back through the relay (the model transcribes the runner's
// line); resultHash proves it arrived unchanged, the mac proves the runner produced it.
function ucxResultIntact(env) {
  if (!env || env.ok !== true) return true
  if (env.__incompletePages || typeof env.resultHash !== 'string') return false
  return ucxHash(ucxBody(env)) === env.resultHash
}
function ucxResultAuthentic(env, key, taskText) {
  if (!env || env.ok !== true) return true
  return typeof env.mac === 'string' && !!key && ucxHmacHex(key, env.runId + '\n' + ucxSha256Hex(taskText) + '\n' + ucxBody(env)) === env.mac
}

// expected = { taskHash, text, key } of the request this reply must answer.
function ucxUnwrap(env, raw, expected = {}) {
  const { taskHash: expectedTaskHash, text: taskText, key } = expected
  if (raw && typeof raw === 'object' && raw.__ucxRejected !== undefined) {
    return ucxError('relay_failed', 'the relay agent call failed: ' + raw.__ucxRejected)
  }
  if (!env) {
    return raw == null
      ? ucxError('relay_failed', 'the relay agent returned nothing')
      : ucxError('relay_no_envelope', 'relay reply carried no runner line: ' + String(raw).slice(0, 200))
  }
  if (env.ok === true && env.__incompletePages) {
    return ucxError('relay_incomplete_result', 'the relay returned only part of a large (paged) result', env.runId, true)
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
    if (!key) {
      return ucxError('key_unavailable', 'the runner result key could not be fetched, so the result cannot be authenticated', env.runId, true)
    }
    if (!ucxResultAuthentic(env, key, taskText)) {
      return ucxError('unauthenticated_result', 'the result is not signed by this machine\'s runner — not trusted', env.runId)
    }
    const prov = { runId: env.runId, threadId: p.threadId, model: p.model, effort: p.effort, tier: p.tier,
      usage: p.usageTotal || p.usage, durationMs: p.durationMs, attempts: p.attempts, codexVersion: p.codexVersion, slotLost: p.slotLost || false }
    ucxRecordUsage(prov)
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
  const p = env.provenance || {}
  if (ucxRunId(env) && (p.usageTotal || p.usage)) ucxRecordUsage({ model: p.model, usage: p.usageTotal || p.usage }, true)
  return ucxError(e.kind || 'unknown', e.message || env.state, env.runId || null, Boolean(e.retryable))
}

function codexNode(task, opts = {}) {
  // orphanAfterSec 900: a collector may queue behind other agents before it resumes polling.
  const { schema = null, schemaPreset = null, tier = 'daily', kind = 'verify', model, effort, cwd, timeoutSec,
    maxAttempts = 2, orphanAfterSec = 900, workItems = 1, label, phase, meta } = opts
  if (typeof task !== 'string' || !task.trim()) throw new Error('codexNode: task must be a non-empty string')
  if (!UCX_TIER_MODEL[tier]) throw new Error('codexNode: tier must be light, daily or final')
  if (!UCX_KINDS.includes(kind)) throw new Error('codexNode: kind must be verify, ask or review (implementation is not a workflow node)')
  if (effort !== undefined && !UCX_EFFORTS.includes(effort)) throw new Error('codexNode: bad effort ' + effort)
  if (model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) throw new Error('codexNode: bad model ' + model)
  if (schema !== null && (typeof schema !== 'object' || Array.isArray(schema))) throw new Error('codexNode: schema must be an object')
  if (schema && schemaPreset) throw new Error('codexNode: give schema or schemaPreset, not both')
  if (schemaPreset && !UCX_PRESETS.includes(schemaPreset)) throw new Error('codexNode: bad schemaPreset ' + schemaPreset)
  if (timeoutSec !== undefined && !(Number.isInteger(timeoutSec) && timeoutSec >= 60)) throw new Error('codexNode: timeoutSec must be an integer >= 60')
  if (!(Number.isInteger(orphanAfterSec) && orphanAfterSec >= 60 && orphanAfterSec <= 3600)) throw new Error('codexNode: orphanAfterSec must be an integer 60..3600')
  if (!(Number.isInteger(workItems) && workItems >= 1 && workItems <= 256)) throw new Error('codexNode: workItems must be an integer 1..256')

  const text = ucxNormalize(task)
  // Workflow nodes are read-only and hermetic by construction; the runner refuses anything else from a relay.
  const header = { v: 1, tier, kind, sandbox: 'read-only', hermetic: true, maxAttempts, attached: true }
  if (model) header.model = model
  if (effort) header.effort = effort
  if (cwd) header.cwd = String(cwd).replace(/\\/g, '/')
  if (timeoutSec) header.timeoutSec = timeoutSec
  header.orphanAfterSec = orphanAfterSec
  if (workItems > 1) header.workItems = workItems                 // the runner scales the deadline for a batch
  if (schemaPreset) header.schemaPreset = schemaPreset
  if (label) header.label = String(label).replace(/[^\w .:/@#+=-]/g, '_').slice(0, 120)
  if (meta !== undefined) header.meta = meta
  header.taskHash = ucxHash(text)
  header.schemaHash = ucxHash(schema ? JSON.stringify(schema) : 'null')
  header.h = ucxHash(JSON.stringify(header))                       // last: covers every field above

  const frame = [JSON.stringify(header), '---ULTRACODEX-SCHEMA---', schema ? JSON.stringify(schema) : 'null',
    '---ULTRACODEX-TASK---', text].join('\n')
  // No separate marker line: relays tended to drop it. `part` uploads are always encoded.
  const lines = ucxEncode(frame).split('\n').flatMap(ucxWrap)
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
    const collect = (runId, suffix, strong) => call('ULTRACODEX COLLECT\nRUN_ID: ' + runId, {
      agentType: UCX_RELAY, label: relayLabel + ':' + suffix, phase, ...(strong ? { model: 'opus' } : { effort: 'low' }),
    })
    // The relay stopped while the run is still going: a collector resumes polling
    // (the supervisor tears the run down if nobody polls for orphanAfterSec).
    for (let round = 0; env && env.ok === null && ucxRunId(env) && round < 3; round++) {
      raw = await collect(env.runId, 'collect', false)
      env = ucxEnvelope(raw)
    }
    // A result garbled (or cut short) on the way back is fetched again: the runner keeps it.
    for (let round = 0; env && env.ok === true && ucxRunId(env) && !ucxResultIntact(env) && round < 2; round++) {
      raw = await collect(env.runId, 'recollect', round > 0)
      env = ucxEnvelope(raw)
    }
    // An intact result must also carry this machine's signature. A mac mangled in
    // transcription is fetched once more; a forged one fails again and is refused.
    let key = null
    if (env && env.ok === true && ucxResultIntact(env)) {
      key = await ucxKey(call, phase)
      if (key && ucxRunId(env) && !ucxResultAuthentic(env, key, text)) {
        const again = ucxEnvelope(await collect(env.runId, 'recollect', true))
        if (again && again.ok === true && ucxResultIntact(again)) env = again
      }
    }
    return ucxUnwrap(env, raw, { taskHash: header.taskHash, text, key })
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
  return codexNode(task, { schema: UCX_BATCH_VERDICTS, workItems: Math.min(256, Math.max(1, items.length)), ...opts }).then(res => {
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
- **Byte-exact both ways or rejected.** The request is normalized, percent-encoded (no quote,
  backslash or control character reaches the relay's Bash command), split into ≤1.6 KB parts with
  per-part hashes (the Windows command line breaks near 8 KB) and verified by the runner; the
  runner allocates the upload id. The result comes back with a `resultHash` and the request's
  `taskHash`: a garbled result is fetched again, a result for another request is refused
  (`relay_mismatch`). A result over ~24 KB comes back in pages (`page RUN K`) and is stitched
  and re-verified; a missing page is fetched again (`relay_incomplete_result` if it stays missing).
- **Signed by the runner.** Every result carries `mac` = HMAC-SHA256 under a per-machine key
  (`~/.ultracodex/key`) over the run id, the SHA-256 of the task and the body. The helper fetches
  the key once per workflow through a relay that sees no untrusted text (the relay guard gives
  the key only to a relay that never uploads or collects a job) and refuses anything unsigned
  (`unauthenticated_result`) — so a relay hijacked by reviewed content cannot substitute its own
  "verdict". A mac mangled in transcription is fetched once more.
- **Nothing vanishes.** A rejected relay call is a `relay_failed` node; the shipped workflows
  reconcile every requested dimension, lens, finding and candidate, and report what failed.
- **No slot is held by a blocked call.** Codex runs detached under the runner's supervisor, which
  owns the deadline and stops only the process tree it started. Each `wait` returns within two
  minutes, so the relay never hits the Bash timeout; if nobody polls a workflow node for 15
  minutes (`orphanAfterSec` 900 — a collector may queue behind other agents) the supervisor
  tears the run down (`abandoned`). Only well-formed run ids from a relay's reply ever reach
  another relay's prompt.
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
// batch.byId: Map(id → {refuted, confidence, reasoning}); batch.missing / batch.extras /
// batch.ambiguous (answered twice: neither answer used); on failure batch is a
// _codex_error (with .missing = every id) — treat all as unverified.
```

One batch reads the shared context once and costs one run instead of N; the runner scales
its deadline with N (×1.25 per 4 extra items, at most ×4). Give items positional ids
(`dimension:1`, …) — model-chosen ids collide, and duplicates make `codexBatchNode` throw.

## Cascade — cheap and broad first, astra last and narrow

```js
// sol verifies everything (batched), astra re-checks only what would block a merge
const first = await codexBatchNode(VERIFY, items, { tier: 'daily', kind: 'verify', cwd: CWD, label: 'codex:verify' })
const blocking = items.filter(i => ['critical', 'high'].includes(i.severity) && first.byId.get(i.id)?.refuted === false)
const gate = blocking.length
  ? await codexBatchNode(VERIFY + '\nBe the final, strictest check.', blocking, { tier: 'final', kind: 'verify', cwd: CWD, label: 'codex:final-gate' })
  : null
// astra refuting what sol confirmed → report it as DISPUTED for the owner, never drop it
return { ..., codexUsage: ucxUsage() }
```

The shipped `ultracodex:cross-review` (`finalGate`) and `ultracodex:codex-review` (`escalate`)
already do this.

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
relay-side `relay_corruption` · `relay_incomplete_upload` · `relay_incomplete_result` ·
`relay_gave_up` · `relay_failed` · `relay_no_envelope` · `relay_error` · `relay_mismatch` ·
`no_provenance` · `unauthenticated_result` · `key_unavailable` · `upload_busy` · `supervisor_lost`.

- Treat every one as **no data**. Exclude errored jurors from averages; never score them 0.
- Many errors in one run → stop and run `node <runner> preflight` (auth, catalog, CLI).
- `supervisor_lost` means the runner's supervisor died while Codex may still run: it is **not**
  stopped automatically — look at `node <runner> status` and ask the owner before stopping it.
