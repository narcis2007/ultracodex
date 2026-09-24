export const meta = {
  name: 'cross-review',
  description: 'Claude finds issues per dimension, Codex (GPT) adversarially verifies each against the code (sol@xhigh, then one astra@max gate on the confirmed high/critical ones), Claude writes the report. Fails closed.',
  whenToUse: 'Review a change with a second model family refuting the findings. args: { target, cwd, dimensions, verifyTier: daily|final, finalGate, fast, context, lessons, batch }',
  phases: [
    { title: 'Find', detail: 'one Claude finder per dimension' },
    { title: 'Verify', detail: 'Codex refutes each finding (sol@xhigh, or astra@max when verifyTier is final)' },
    { title: 'Final gate', detail: 'astra@max re-checks only the confirmed high/critical findings, in one run' },
    { title: 'Synthesize', detail: 'Claude writes the report; unverified and disputed findings are listed, never dropped' },
  ],
}

/*@@ULTRACODEX_HELPER@@*/

const A = args || {}
const TARGET = A.target || 'the changes on the current branch against its merge-base with main, plus any uncommitted changes'
const CWD = A.cwd || null
const DIMENSIONS = Array.isArray(A.dimensions) && A.dimensions.length
  ? A.dimensions
  : ['correctness', 'security', 'concurrency-and-state', 'error-handling-and-edge-cases']
const VERIFY_TIER = A.verifyTier === 'final' ? 'final' : 'daily'
// Cascade, astra last: sol verifies everything; astra re-checks only what would block a
// merge (confirmed high/critical), all in one run. Off with finalGate: false.
const FINAL_GATE = VERIFY_TIER === 'daily' && A.finalGate !== false
// fast: true → the Fast service tier for the astra nodes only (more usage, less waiting)
const FAST = A.fast === true ? { serviceTier: 'priority' } : {}
const GATE_SEVERITIES = ['critical', 'high']
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
// Every dimension ends as { dimension, findings, failed }: a finder or stage that dies is
// reported, never silently turned into "no findings".
const results = await pipeline(
  DIMENSIONS,
  d => agent(findPrompt(d), { label: 'find:' + d, phase: 'Find', schema: FINDINGS, agentType: UCX_READER })
    .then(review => review, e => ({ __failed: String((e && e.message) || e) })),
  async (review, d) => {
    if (!review || review.__failed) return { dimension: d, findings: [], failed: review ? review.__failed : 'the finder returned nothing' }
    // Ids are positional: model-chosen ids can collide (or be empty) and must never
    // cost a finding. The finder's own id is kept as sourceId.
    const findings = (review.findings || []).map((f, i) => ({ ...f, sourceId: f.id, id: d + ':' + (i + 1), dimension: d }))
    if (!findings.length) return { dimension: d, findings: [], failed: null }
    try {
      if (BATCH) {
        const batch = await codexBatchNode(VERIFY_INSTRUCTION,
          findings.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, detail: f.detail, failure_scenario: f.failure_scenario })),
          { tier: VERIFY_TIER, kind: 'verify', cwd: CWD || undefined, label: 'codex:' + d, phase: 'Verify', ...(VERIFY_TIER === 'final' ? FAST : {}) })
        return {
          dimension: d, failed: null,
          findings: findings.map(f => ({
            ...f,
            verdict: isCodexError(batch) ? batch
              : batch.ambiguous.includes(f.id) ? ucxError('ambiguous_verdict', 'Codex answered ' + f.id + ' more than once')
              : (batch.byId.get(f.id) || ucxError('missing_from_batch', 'Codex returned no verdict for ' + f.id)),
          })),
        }
      }
      const verified = await parallel(findings.map(f => () =>
        codexNode(VERIFY_INSTRUCTION + '\nFINDING (JSON):\n' + JSON.stringify(f),
          { schemaPreset: 'verdict', tier: VERIFY_TIER, kind: 'verify', cwd: CWD || undefined, label: 'codex:' + f.id, phase: 'Verify', ...(VERIFY_TIER === 'final' ? FAST : {}) })
          .then(v => ({ ...f, verdict: v }))))
      return { dimension: d, failed: null, findings: findings.map((f, i) => verified[i] || { ...f, verdict: ucxError('stage_failed', 'verification of ' + f.id + ' failed') }) }
    } catch (e) {
      // the finder worked: its findings stay visible, unverified
      const err = ucxError('stage_failed', 'verification stage failed: ' + String((e && e.message) || e))
      return { dimension: d, failed: null, findings: findings.map(f => ({ ...f, verdict: err })) }
    }
  },
)

const dims = DIMENSIONS.map((d, i) => results[i] || { dimension: d, findings: [], failed: 'the review stage failed' })
const failedDims = dims.filter(x => x.failed)
const all = dims.flatMap(x => x.findings)
const part = ucxPartition(all)
if (failedDims.length) log('⚠ ' + failedDims.length + '/' + DIMENSIONS.length + ' dimensions were NOT reviewed: ' + failedDims.map(x => x.dimension).join(', '))
if (part.unverified.length) log('⚠ ' + part.unverified.length + '/' + all.length + ' findings UNVERIFIED — the result is incomplete')

// Final gate: every confirmed high/critical finding gets astra's verdict too. Agreement
// keeps it confirmed; an astra refutation makes it DISPUTED (the owner decides, it is never
// silently dropped); a gate that fails leaves sol's verdict standing, marked, and the review incomplete.
let confirmed = part.confirmed
const disputed = []
const gate = { ran: false, checked: 0, upheld: 0, disputed: 0, failed: 0 }
const gated = FINAL_GATE ? part.confirmed.filter(f => GATE_SEVERITIES.includes(f.severity)) : []
if (gated.length) {
  phase('Final gate')
  gate.ran = true
  gate.checked = gated.length
  let batch
  try {
    batch = await codexBatchNode(VERIFY_INSTRUCTION + '\nA first verifier could not refute these; they would block a merge. Be the final, strictest check.',
      gated.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, detail: f.detail, failure_scenario: f.failure_scenario })),
      { tier: 'final', kind: 'verify', cwd: CWD || undefined, label: 'codex:final-gate', phase: 'Final gate', ...FAST })
  } catch (e) {
    batch = ucxError('stage_failed', 'the final gate failed: ' + String((e && e.message) || e))
  }
  const gateOf = f => isCodexError(batch) ? batch
    : batch.ambiguous.includes(f.id) ? ucxError('ambiguous_verdict', 'astra answered ' + f.id + ' more than once')
      : (batch.byId.get(f.id) || ucxError('missing_from_batch', 'astra returned no verdict for ' + f.id))
  confirmed = part.confirmed.map(f => {
    if (!gated.includes(f)) return f
    const v = gateOf(f)
    if (isCodexError(v)) { gate.failed++; return { ...f, finalGate: { error: v.kind } } }
    if (v.refuted === true) { gate.disputed++; disputed.push({ ...f, finalGate: v }); return null }
    gate.upheld++
    return { ...f, finalGate: v }
  }).filter(Boolean)
  if (gate.failed) log('⚠ the astra final gate could not check ' + gate.failed + '/' + gated.length + ' findings — they stay confirmed on sol\'s verdict and the review is INCOMPLETE')
  if (gate.disputed) log('⚠ ' + gate.disputed + ' finding(s) DISPUTED: sol confirmed, astra refuted')
}

phase('Synthesize')
const report = await agent(`Write a code-review report for ${TARGET}${WHERE}.
${failedDims.length ? 'At the very top, state that these dimensions were NOT reviewed (their finder failed): ' + JSON.stringify(failedDims.map(x => ({ dimension: x.dimension, why: x.failed }))) : ''}
${gate.failed ? 'At the top, state that the gpt-6-astra final gate FAILED for ' + gate.failed + ' finding(s) (those with finalGate.error): they are confirmed by gpt-6-sol only, and the review is incomplete.' : ''}
CONFIRMED findings (a second model family could not refute them; finalGate, when present, is gpt-6-astra's verdict on top of gpt-6-sol's) — rank by severity, give file:line, the failure scenario and a fix:
${JSON.stringify(confirmed)}
${disputed.length ? 'DISPUTED findings (gpt-6-sol confirmed them, the gpt-6-astra final gate refuted them — present both reasonings and say the owner must decide):\n' + JSON.stringify(disputed.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, sol: f.verdict.reasoning, astra: f.finalGate.reasoning }))) : ''}
UNVERIFIED findings (the Codex verifier failed — state this plainly at the top; they are neither confirmed nor refuted):
${JSON.stringify(part.unverified.map(f => ({ id: f.id, title: f.title, file: f.file, why: f.verdict && f.verdict.kind })))}
REFUTED count: ${part.refuted.length} (list their titles briefly at the end).`, { label: 'synthesize', phase: 'Synthesize', agentType: UCX_READER })

return {
  // an enabled final gate that could not check every blocking finding leaves the review incomplete
  status: failedDims.length || part.status === 'incomplete' || gate.failed ? 'incomplete' : 'complete',
  failedDimensions: failedDims.map(x => ({ dimension: x.dimension, why: x.failed })),
  report,
  confirmed,
  disputed: disputed.map(f => ({ id: f.id, title: f.title, severity: f.severity, sol: f.verdict.reasoning, astra: f.finalGate.reasoning })),
  refuted: part.refuted.map(f => ({ id: f.id, title: f.title, reasoning: f.verdict.reasoning })),
  unverified: part.unverified.map(f => ({ id: f.id, title: f.title, error: f.verdict && f.verdict.kind })),
  finalGate: FINAL_GATE ? gate : null,
  codexUsage: ucxUsage(),
}
