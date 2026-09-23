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

/*@@ULTRACODEX_HELPER@@*/

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
// Every dimension ends as { dimension, findings, failed }: a finder or stage that dies is
// reported, never silently turned into "no findings".
const results = await pipeline(
  DIMENSIONS,
  d => agent(findPrompt(d), { label: 'find:' + d, phase: 'Find', schema: FINDINGS })
    .then(review => review, e => ({ __failed: String((e && e.message) || e) })),
  async (review, d) => {
    if (!review || review.__failed) return { dimension: d, findings: [], failed: review ? review.__failed : 'the finder returned nothing' }
    const findings = (review.findings || []).map((f, i) => ({ ...f, id: d + ':' + (f.id || i), dimension: d }))
    if (!findings.length) return { dimension: d, findings: [], failed: null }
    if (BATCH) {
      const batch = await codexBatchNode(VERIFY_INSTRUCTION,
        findings.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, detail: f.detail, failure_scenario: f.failure_scenario })),
        { tier: VERIFY_TIER, kind: 'verify', cwd: CWD || undefined, label: 'codex:' + d, phase: 'Verify' })
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
        { schemaPreset: 'verdict', tier: VERIFY_TIER, kind: 'verify', cwd: CWD || undefined, label: 'codex:' + f.id, phase: 'Verify' })
        .then(v => ({ ...f, verdict: v }))))
    return { dimension: d, failed: null, findings: findings.map((f, i) => verified[i] || { ...f, verdict: ucxError('stage_failed', 'verification of ' + f.id + ' failed') }) }
  },
)

const dims = DIMENSIONS.map((d, i) => results[i] || { dimension: d, findings: [], failed: 'the review stage failed' })
const failedDims = dims.filter(x => x.failed)
const all = dims.flatMap(x => x.findings)
const part = ucxPartition(all)
if (failedDims.length) log('⚠ ' + failedDims.length + '/' + DIMENSIONS.length + ' dimensions were NOT reviewed: ' + failedDims.map(x => x.dimension).join(', '))
if (part.unverified.length) log('⚠ ' + part.unverified.length + '/' + all.length + ' findings UNVERIFIED — the result is incomplete')

phase('Synthesize')
const report = await agent(`Write a code-review report for ${TARGET}${WHERE}.
${failedDims.length ? 'At the very top, state that these dimensions were NOT reviewed (their finder failed): ' + JSON.stringify(failedDims.map(x => ({ dimension: x.dimension, why: x.failed }))) : ''}
CONFIRMED findings (a second model family could not refute them) — rank by severity, give file:line, the failure scenario and a fix:
${JSON.stringify(part.confirmed)}
UNVERIFIED findings (the Codex verifier failed — state this plainly at the top; they are neither confirmed nor refuted):
${JSON.stringify(part.unverified.map(f => ({ id: f.id, title: f.title, file: f.file, why: f.verdict && f.verdict.kind })))}
REFUTED count: ${part.refuted.length} (list their titles briefly at the end).`, { label: 'synthesize', phase: 'Synthesize' })

return {
  status: failedDims.length || part.status === 'incomplete' ? 'incomplete' : 'complete',
  failedDimensions: failedDims.map(x => ({ dimension: x.dimension, why: x.failed })),
  report,
  confirmed: part.confirmed,
  refuted: part.refuted.map(f => ({ id: f.id, title: f.title, reasoning: f.verdict.reasoning })),
  unverified: part.unverified.map(f => ({ id: f.id, title: f.title, error: f.verdict && f.verdict.kind })),
}
