# Workflow templates — Codex blended in (Pattern A)

Two ways to use Codex nodes in a Workflow:

1. **Run a shipped workflow** (tested, no copy-paste). Invoke by name with `args`:

   | Workflow | What it does | Key args |
   | --- | --- | --- |
   | `ultracodex:cross-review` | Claude finders per dimension → Codex (sol@xhigh, batched) refutes each finding against the code → one astra@max run re-checks the confirmed high/critical ones → Claude report | `target`, `cwd`, `dimensions`, `verifyTier: 'daily'\|'final'`, `finalGate` (default on), `fast`, `context`, `lessons`, `batch` |
   | `ultracodex:codex-review` | Codex reviews through lenses (code, domain, security, tests, performance) → Claude checks each finding in the code → high/critical disagreements go to astra@max in one run → report | `cwd`, `base` \| `commit` \| `uncommitted`, `lenses`, `tier: 'light'\|'daily'\|'final'`, `escalate` (default on), `fast`, `context`, `lessons`, `triage` |
   | `ultracodex:crosscheck` | one Codex attempt to refute one load-bearing claim (astra@max) | `claim`, `evidence`, `cwd`, `tier`, `fast` |
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
`codexBatchNode`), `serviceTier` (`'priority'` = Fast: more usage, less waiting), `label`,
`phase`, `meta`. It resolves to the parsed object
(provenance in the non-enumerable `_codex`), the final text (no schema), or
`{ _codex_error: true, kind, message, retryable, runId }`. Always test with `isCodexError(x)`.

Also in the block: `codexBatchNode(instruction, items, opts)` (N small items, one Codex run,
id integrity enforced, deadline scaled to N), `ucxPartition(items, verdictOf)` (fail-closed
confirmed / refuted / unverified), `ucxUsage()` (tokens spent on Codex in this workflow, per
model — return it as `codexUsage`), `isCodexError(x)`, `ucxError(kind, message)`,
`UCX_READER` (the confined agent type for Claude stages that read code) and `ucxWhere(cwd)`
— append it to the prompt of every Claude stage that reads the repository at `cwd`: a Claude
stage works in the session's directory, not in the workflow's `cwd`.

<!-- BEGIN ULTRACODEX HELPER (generated from tools/src/helper.js) -->

```js
// ── ultracodex helper v0.3.2 ───────────────────────────────────────────────────
// Generated from tools/src/helper.js in the ultracodex repo — edit the source, then
// `npm run build`. Needs the ultracodex plugin (its `codex-relay`, `codex-key` and
// `codex-reader` agents + runner).
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
const UCX_VERSION = '0.3.2'
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

// ── authentication: HMAC-SHA256 in plain JS (the Workflow runtime has no crypto) ──
// The helper fetches the per-machine key and a fresh nonce once per workflow through the
// key agent (a separate agent type whose prompt holds no untrusted text), signs every
// request it builds and announces it through the key agent — the runner starts nothing
// else a relay uploads — and accepts only results the runner signed for that very request.
// A relay hijacked by reviewed content can neither start a job of its own nor pass off an
// answer as Codex's.
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

// The runner key and this workflow's nonce, fetched once by the key agent: its own agent
// type, so the relay guard never lets a job relay read the key, and its prompt holds no
// task text. keyCheck (the runner's hash of key and nonce) catches a mis-copied answer.
// Only a success is cached.
const UCX_KEY_AGENT = 'ultracodex:codex-key'
let ucxKeyPromise = null
let ucxKeyFailure = ''
let ucxNodeSeq = 0
function ucxKey(call, phase) {
  if (!ucxKeyPromise) {
    ucxKeyPromise = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await call('ULTRACODEX KEY', {
          agentType: UCX_KEY_AGENT, label: 'codex:key' + (attempt ? ':retry' : ''), phase, ...(attempt ? { model: 'opus' } : { effort: 'low' }),
        })
        const env = ucxEnvelope(raw)
        if (env && env.ok === true && /^[0-9a-f]{64}$/.test(String(env.key)) && /^[0-9a-f]{32}$/.test(String(env.nonce))
          && ucxHash(env.key + ':' + env.nonce) === env.keyCheck) return { key: env.key, nonce: env.nonce }
        ucxKeyFailure = raw && raw.__ucxRejected !== undefined ? 'the key agent call failed: ' + raw.__ucxRejected
          : env && env.ok === false ? 'the runner refused: ' + ((env.error && env.error.message) || env.state)
            : 'the key agent returned no valid key line'
      }
      return null
    })().then(auth => { if (!auth) ucxKeyPromise = null; return auth })
  }
  return ucxKeyPromise
}

// Each request is announced to the runner, by digest, through the same key agent before a
// relay uploads it: the runner starts a relayed job only for an announced request, so no
// party that saw untrusted text — a relay, a reader agent, a Codex job — can start one of
// its own, even with the key. The runner echoes the digest back; a mis-copied one is retried.
async function ucxExpect(call, phase, digest, label) {
  let why = 'the key agent returned no confirmation'
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await call('ULTRACODEX EXPECT\nDIGEST: ' + digest, {
      agentType: UCX_KEY_AGENT, label: label + ':expect' + (attempt ? ':retry' : ''), phase, ...(attempt ? { model: 'opus' } : { effort: 'low' }),
    })
    const env = ucxEnvelope(raw)
    if (env && env.ok === true && env.expected === digest) return null
    why = raw && raw.__ucxRejected !== undefined ? 'the key agent call failed: ' + raw.__ucxRejected
      : env && env.ok === false ? 'the runner refused: ' + ((env.error && env.error.message) || env.state)
        : env && env.ok === true ? 'the key agent announced another digest' : 'the key agent returned no confirmation'
  }
  return why
}

// Claude stages that read reviewed code run as this confined agent type (Read, Grep, Glob,
// read-only git): whatever the code tells them, they can neither sign nor announce a request.
const UCX_READER = 'ultracodex:codex-reader'
// A Claude stage works in the session's directory, not in the workflow's `cwd`: append this
// to its prompt so it reads the right repository (measured: a report stage without it ran
// git in the session directory and could not see the change).
function ucxWhere(cwd) {
  return cwd ? '\nTHE REPOSITORY is ' + cwd + ' — your own working directory may be another one, so run git there as git -c safe.bareRepository=explicit -C "' + cwd + '" <command> and read its files by absolute path.' : ''
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

// Page data travels percent-encoded (the runner's encodePageText): %25 %5C %27 %22 %uXXXX %UXXXXXX.
function ucxDecode(text) {
  return String(text).replace(/%(25|5C|27|22|u[0-9A-F]{4}|U[0-9A-F]{6})/g, (m, c) =>
    c === '25' ? '%' : c === '5C' ? String.fromCharCode(0x5c) : c === '27' ? String.fromCharCode(0x27) : c === '22' ? '"'
      : c[0] === 'u' ? String.fromCharCode(parseInt(c.slice(1), 16)) : String.fromCodePoint(parseInt(c.slice(1), 16)))
}

// The last runner line of a relay's reply (a malformed reply is "no envelope", never a
// thrown error). A large result arrives as a compact envelope plus `page` lines; `store`
// ({ runId, pages }) keeps the hash-verified pages of every reply for one node, so a
// re-collect only has to bring the pages the earlier replies got wrong.
const UCX_MAX_PAGES = 400
function ucxEnvelope(raw, store = null) {
  try {
    if (raw && typeof raw === 'object') return raw.ultracodex === 1 ? raw : null
    const lines = String(raw ?? '').split(/\r?\n/).map(l => l.trim().replace(/^`+|`+$/g, '').trim())
    const parsed = []
    for (const line of lines) {
      if (!line.startsWith('{') || !line.includes('"ultracodex"')) continue
      try { const obj = JSON.parse(line); if (obj && obj.ultracodex === 1) parsed.push(obj) } catch (e) { /* not a runner line */ }
    }
    const env = [...parsed].reverse().find(o => o.page === undefined) || null
    if (!env || !env.paged || env.ok !== true) return env
    if (env.paged.tooLarge) return { ...env, __tooLarge: true }
    const total = env.paged.pages
    // bounds first: an absurd count must neither allocate nor throw
    if (!Number.isInteger(total) || total < 1 || total > UCX_MAX_PAGES) return { ...env, __incompletePages: true }
    const hashes = Array.isArray(env.paged.hashes) && env.paged.hashes.length === total && env.paged.hashes.every(h => /^[0-9a-f]{8}$/.test(String(h)))
      ? env.paged.hashes : null
    // pages are only kept across replies when each one can be verified on its own
    const pages = hashes && store ? (store.runId === env.runId ? store.pages : (store.runId = env.runId, store.pages = new Map())) : new Map()
    for (const o of parsed) {
      if (o.page === undefined || o.runId !== env.runId || typeof o.data !== 'string' || !Number.isInteger(o.page) || o.page < 1 || o.page > total) continue
      if (!hashes || ucxHash(o.data) === hashes[o.page - 1]) pages.set(o.page, o.data)   // a garbled page is dropped
    }
    const body = []
    for (let k = 1; k <= total; k++) {
      if (!pages.has(k)) return { ...env, __incompletePages: true }
      body.push(pages.get(k))
    }
    const joined = body.join('')
    const whole = JSON.parse(env.paged.enc === 'pct' ? ucxDecode(joined) : joined)
    const out = { ...env }
    delete out.paged
    if (whole && typeof whole === 'object' && 'result' in whole) out.result = whole.result
    else if (whole && typeof whole === 'object' && 'text' in whole) out.text = whole.text
    else return { ...env, __incompletePages: true }
    return out
  } catch (e) {
    return null
  }
}

// What an answer must look like for its request: an object `result` when a schema was
// given, a string `text` otherwise — never both, never another type. Returns the signed
// { kind, body } or null.
function ucxPayload(env, wantsResult) {
  if (!env || env.ok !== true) return null
  if (wantsResult) {
    if (env.text !== undefined || !env.result || typeof env.result !== 'object' || Array.isArray(env.result)) return null
    return { kind: 'result', body: JSON.stringify(env.result) }
  }
  if (env.result !== undefined || typeof env.text !== 'string') return null
  return { kind: 'text', body: env.text }
}

// The result also travels back through the relay (the model transcribes the runner's
// line): resultHash proves it arrived unchanged, the mac proves the runner produced it for
// exactly this request (nonce, model, cwd, schema, task — all in the request digest).
function ucxResultIntact(env, wantsResult) {
  if (!env || env.ok !== true) return true
  if (env.__incompletePages || env.__tooLarge || typeof env.resultHash !== 'string') return false
  const payload = ucxPayload(env, wantsResult)
  return !!payload && ucxHash(payload.body) === env.resultHash
}
function ucxResultAuthentic(env, auth, digest, wantsResult) {
  if (!env || env.ok !== true) return true
  const payload = ucxPayload(env, wantsResult)
  return !!payload && !!auth && typeof env.mac === 'string'
    && ucxHmacHex(auth.key, 'ucx-result\n' + env.runId + '\n' + digest + '\n' + payload.kind + '\n' + payload.body) === env.mac
}

// expected = { taskHash, digest, auth, wantsResult } of the request this reply must answer.
function ucxUnwrap(env, raw, expected = {}) {
  const { taskHash: expectedTaskHash, digest, auth, wantsResult } = expected
  if (raw && typeof raw === 'object' && raw.__ucxRejected !== undefined) {
    return ucxError('relay_failed', 'the relay agent call failed: ' + raw.__ucxRejected)
  }
  if (!env) {
    return raw == null
      ? ucxError('relay_failed', 'the relay agent returned nothing')
      : ucxError('relay_no_envelope', 'relay reply carried no runner line: ' + String(raw).slice(0, 200))
  }
  if (env.ok === true && env.__tooLarge) {
    return ucxError('result_too_large', 'the result is larger than ' + UCX_MAX_PAGES + ' pages', env.runId)
  }
  if (env.ok === true && env.__incompletePages) {
    return ucxError('relay_incomplete_result', 'the relay returned only part of a large (paged) result', env.runId, true)
  }
  if (env.ok === true && !ucxResultIntact(env, wantsResult)) {
    return ucxError('relay_corruption', 'the result changed on its way back through the relay (hash or shape mismatch)', env.runId, true)
  }
  if (env.ok === true) {
    const p = env.provenance || {}
    if (!p.threadId || !(p.usage && p.usage.output_tokens > 0)) {
      return ucxError('no_provenance', 'result has no Codex thread id / token usage — not trusted', env.runId)
    }
    if (expectedTaskHash && p.taskHash !== expectedTaskHash) {
      return ucxError('relay_mismatch', 'the result belongs to a different request (taskHash ' + p.taskHash + ')', env.runId)
    }
    if (!auth) {
      return ucxError('key_unavailable', 'the runner key could not be fetched, so the result cannot be authenticated', env.runId, true)
    }
    if (!ucxResultAuthentic(env, auth, digest, wantsResult)) {
      return ucxError('unauthenticated_result', 'the result is not signed by this machine\'s runner for this request — not trusted', env.runId)
    }
    const prov = { runId: env.runId, threadId: p.threadId, model: p.model, effort: p.effort, tier: p.tier,
      usage: p.usageTotal || p.usage, durationMs: p.durationMs, attempts: p.attempts, codexVersion: p.codexVersion, slotLost: p.slotLost || false }
    ucxRecordUsage(prov)
    if (wantsResult) {
      Object.defineProperty(env.result, '_codex', { value: prov, enumerable: false })
      return env.result
    }
    return env.text
  }
  if (env.state === 'receiving') {
    return ucxError('relay_incomplete_upload', 'the relay uploaded ' + env.received + '/' + env.total + ' parts', null, true)
  }
  if (env.ok === null) {
    return ucxError('relay_gave_up', 'run ' + env.runId + ' is still ' + env.state + ' (collect: wait ' + env.runId + ')', env.runId, true)
  }
  const e = env.error || {}
  const p = env.provenance || {}
  // a run stopped mid-turn (deadline, cancel) reports no tokens: still counted, as a failed run
  if (ucxRunId(env) && p.model) ucxRecordUsage({ model: p.model, usage: p.usageTotal || p.usage || {} }, true)
  return ucxError(e.kind || 'unknown', e.message || env.state, env.runId || null, Boolean(e.retryable))
}

function codexNode(task, opts = {}) {
  // orphanAfterSec 900: a collector may queue behind other agents before it resumes polling.
  const { schema = null, schemaPreset = null, tier = 'daily', kind = 'verify', model, effort, cwd, timeoutSec,
    maxAttempts = 2, orphanAfterSec = 900, workItems = 1, serviceTier, label, phase, meta } = opts
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
  if (serviceTier !== undefined && !['default', 'priority'].includes(serviceTier)) throw new Error('codexNode: serviceTier must be default or priority')

  const text = ucxNormalize(task)
  const wantsResult = Boolean(schema || schemaPreset)
  // Workflow nodes are read-only and hermetic by construction; the runner refuses anything else from a relay.
  const base = { v: 1, tier, kind, sandbox: 'read-only', hermetic: true, maxAttempts, attached: true }
  if (model) base.model = model
  if (effort) base.effort = effort
  if (cwd) base.cwd = String(cwd).replace(/\\/g, '/')
  if (timeoutSec) base.timeoutSec = timeoutSec
  base.orphanAfterSec = orphanAfterSec
  if (workItems > 1) base.workItems = workItems                     // the runner scales the deadline for a batch
  if (serviceTier) base.serviceTier = serviceTier
  if (schemaPreset) base.schemaPreset = schemaPreset
  if (label) base.label = String(label).replace(/[^\w .:/@#+=-]/g, '_').slice(0, 120)
  if (meta !== undefined) base.meta = meta
  const schemaText = schema ? JSON.stringify(schema) : 'null'
  const relayLabel = label || 'codex'
  const weight = (model || UCX_TIER_MODEL[tier]) === 'gpt-6-astra' ? 2 : 1
  // agent() may reject (runtime error, exhausted budget): that is a failed node, never a vanished one.
  const call = async (prompt, callOpts) => {
    try { return await agent(prompt, callOpts) } catch (e) { return { __ucxRejected: String((e && e.message) || e) } }
  }

  return ucxGate(async () => {
    try {
      // The request is signed before it leaves: the runner starts only requests this helper built.
      const auth = await ucxKey(call, phase)
      if (!auth) return ucxError('key_unavailable', 'no request can be signed: ' + ucxKeyFailure, null, true)
      const header = { ...base, nonce: auth.nonce + '.' + (++ucxNodeSeq) }
      header.taskHash = ucxHash(text)
      header.schemaHash = ucxHash(schemaText)
      header.h = ucxHash(JSON.stringify(header))                   // transport check: every field above
      const digest = ucxSha256Hex(JSON.stringify(header) + '\n' + schemaText + '\n' + text)
      const frame = [JSON.stringify({ ...header, rmac: ucxHmacHex(auth.key, 'ucx-request\n' + digest) }),
        '---ULTRACODEX-SCHEMA---', schemaText, '---ULTRACODEX-TASK---', text].join('\n')
      const refused = await ucxExpect(call, phase, digest, relayLabel)
      if (refused) return ucxError('register_failed', 'the request could not be announced to the runner: ' + refused, null, true)
      // No separate marker line: relays tended to drop it. `part` uploads are always encoded.
      const lines = ucxEncode(frame).split('\n').flatMap(ucxWrap)
      const parts = ucxParts(lines)
      const delim = ucxDelimiter(lines)
      const partHashes = parts.map(p => ucxHash(p.join('\n')))    // the runner refuses a part that differs
      // The runner allocates the upload id on part 1 ("part new"), so identical requests from
      // different workflows or sessions can never share (or clear) each other's upload.
      const startPrompt = [
        'ULTRACODEX START', 'PARTS: ' + parts.length, 'DELIMITER: ' + delim,
        'Part 1: node <runner> part new 1 ' + parts.length + ' <hash of part 1> — it prints the upload id.' +
          ' Parts k = 2..' + parts.length + ': node <runner> part <upload id> k ' + parts.length + ' <hash of part k>.' +
          " Each with <<'" + delim + "' + the part lines + " + delim + '. Resend a part the runner answers with part_rejected.',
        // The line count is a hint only: a part cut mid-sentence can still pull a relay on into
        // the next part (measured: Sonnet did so even with the count), which the runner absorbs
        // by keeping the prefix that matches the part's hash.
        ...parts.flatMap((p, i) => ['=====' + delim + ' PART ' + (i + 1) + '/' + parts.length + ' ' + partHashes[i] + ' ' + p.length + ' LINES=====', ...p, '=====' + delim + ' END=====']),
      ].join('\n')

      let raw = null, env = null
      const pageStore = { runId: null, pages: new Map() }
      for (let attempt = 0; attempt < 2; attempt++) {              // a corrupted copy is retried once, by a stronger relay
        raw = await call(startPrompt, {
          agentType: UCX_RELAY, label: relayLabel + (attempt ? ':retry' : ''), phase, ...(attempt ? { model: 'opus' } : { effort: 'low' }),
        })
        env = ucxEnvelope(raw, pageStore)
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
        env = ucxEnvelope(raw, pageStore)
      }
      // A result garbled (or cut short) on the way back is fetched again: the runner keeps it.
      for (let round = 0; env && env.ok === true && !env.__tooLarge && ucxRunId(env) && !ucxResultIntact(env, wantsResult) && round < 2; round++) {
        raw = await collect(env.runId, 'recollect', round > 0)
        env = ucxEnvelope(raw, pageStore)
      }
      // An intact result must also carry this machine's signature for this request. A mac
      // mangled in transcription is fetched once more; a forged one fails again and is refused.
      if (env && env.ok === true && ucxResultIntact(env, wantsResult) && ucxRunId(env) && !ucxResultAuthentic(env, auth, digest, wantsResult)) {
        const again = ucxEnvelope(await collect(env.runId, 'recollect', true), pageStore)
        if (again && again.ok === true && ucxResultIntact(again, wantsResult)) env = again
      }
      return ucxUnwrap(env, raw, { taskHash: header.taskHash, digest, auth, wantsResult })
    } catch (e) {
      // never let one node's surprise abort the whole workflow: it is a failed node
      return ucxError('helper_error', 'codexNode failed unexpectedly: ' + String((e && e.message) || e))
    }
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
  runner allocates the upload id, and a relay copy that runs on into the next part (measured:
  a part cut mid-sentence pulls Sonnet and Opus alike on) keeps just the prefix that matches
  its hash. The result comes back with a `resultHash` and the request's
  `taskHash`: a garbled result is fetched again, a result for another request is refused
  (`relay_mismatch`). A result over ~24 KB comes back in percent-encoded, individually hashed pages
  (`page RUN K`); good pages are kept across replies, the body is stitched and re-verified, and
  a missing or garbled page is fetched again (`relay_incomplete_result` if it stays missing).
- **Signed both ways.** Once per workflow the helper's key agent (`ultracodex:codex-key`, a
  separate agent type whose prompt holds no task text; job relays can never read the key)
  fetches the per-machine key and a fresh nonce. Every request is signed, and announced to
  the runner through the key agent (`expect`, `register_failed` if that fails), before any
  relay sees it — the runner starts nothing else a relay uploads (`unregistered_request`) —
  and every result must carry the runner's MAC over the run, the full request digest (nonce,
  model, cwd, schema, task) and the payload type (`unauthenticated_result` otherwise). A
  relay hijacked by reviewed content can neither start a job of its own nor pass off an
  answer, an older run's answer or a retyped payload as Codex's; a party that read the key
  (a Codex job can) still cannot start one. A MAC mangled in transcription is fetched once
  more.
- **Confined readers.** Claude stages that read the reviewed code — finders, triage, jurors,
  synthesis — pass `agentType: UCX_READER` (`ultracodex:codex-reader`: Read, Grep, Glob and
  read-only git through the plugin's guard). Content that hijacks such a stage can run
  nothing and write nothing; do the same in custom scripts, and use a writing agent type only
  for stages that must write (implementation, fixes) and never for ones that just read.
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
  d => agent(`Review the branch in ${CWD} for ${d} issues. Concrete findings only.`, { label: 'find:' + d, phase: 'Find', schema: FINDINGS, agentType: UCX_READER }),
  (review, d) => parallel(((review && review.findings) || []).map(f => () =>
    codexNode(`Adversarially verify this finding against the code; refuted=true unless the code confirms it.\n${JSON.stringify(f)}`,
      { schemaPreset: 'verdict', tier: 'daily', kind: 'verify', cwd: CWD, label: 'codex:' + d + ':' + f.id, phase: 'Verify' })
      .then(v => ({ ...f, dimension: d, verdict: v })))),
)
const part = ucxPartition(results.flat())
if (part.unverified.length) log(`⚠ ${part.unverified.length} findings UNVERIFIED — incomplete`)
phase('Synthesize')
const report = await agent(`Report CONFIRMED: ${JSON.stringify(part.confirmed)}\nUNVERIFIED (say so up top): ${JSON.stringify(part.unverified.map(f => f.title))}`, { label: 'synthesize', agentType: UCX_READER })
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
      { label: 'find:r' + rounds, schema: FINDINGS, agentType: UCX_READER })
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
`no_provenance` · `unauthenticated_result` · `unauthenticated_request` · `unregistered_request` ·
`register_failed` · `key_unavailable` · `key_invalid` · `nonce_reused` · `result_too_large` ·
`upload_busy` · `helper_error` · `supervisor_lost`.

- Treat every one as **no data**. Exclude errored jurors from averages; never score them 0.
- Many errors in one run → stop and run `node <runner> preflight` (auth, catalog, CLI).
- `supervisor_lost` means the runner's supervisor died while Codex may still run: it is **not**
  stopped automatically — look at `node <runner> status` and ask the owner before stopping it.
