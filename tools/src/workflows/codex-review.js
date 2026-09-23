export const meta = {
  name: 'codex-review',
  description: 'Adversarial code review by Codex (GPT) through several lenses, each finding then checked in the code by Claude. Daily tier sol@max, final gate astra@max. Fails closed.',
  whenToUse: 'Second-model review of a branch/commit/uncommitted change. args: { cwd, base | commit | uncommitted, lenses, tier: daily|final, context, lessons, triage }',
  phases: [
    { title: 'Review', detail: 'one Codex review per lens (read-only, hermetic)' },
    { title: 'Triage', detail: 'Claude checks each Codex finding against the code' },
    { title: 'Report', detail: 'confirmed / refuted / needs-info / unverified' },
  ],
}

/*@@ULTRACODEX_HELPER@@*/

const A = args || {}
const CWD = A.cwd || null
const TIER = A.tier === 'final' ? 'final' : A.tier === 'light' ? 'light' : 'daily'
const TRIAGE = A.triage !== false
const CONTEXT = A.context ? '\nWHAT THE CHANGE IS FOR / DOMAIN RULES (from the owner):\n' + A.context : ''
const LESSONS = A.lessons ? '\nBefore reviewing, read ' + A.lessons + ' — a checklist of defect classes this project keeps producing — and check the change against every item.' : ''
const SCOPE = A.commit
  ? 'the changes introduced by commit ' + A.commit + ' (git show ' + A.commit + ')'
  : A.uncommitted
    ? 'the uncommitted changes (git status, git diff, git diff --cached, and untracked files)'
    : 'the changes on the current branch against ' + (A.base || 'main') + ' (git diff ' + (A.base || 'main') + '...HEAD), plus any uncommitted changes'

const LENSES = {
  code: 'CODE lens — correctness, edge cases, error handling, resource and lifecycle handling, concurrency and ordering, API/contract mismatches between caller and callee (headers, bodies, query params), and tests that cannot fail or silently skip.',
  domain: 'DOMAIN lens — business rules and invariants, data integrity across writes, idempotency and retries of external effects, time zones and clocks, money/quantities, what the user sees versus what is true, and irreversible actions guarded only by assumptions.',
  security: 'SECURITY lens — authentication/authorization gaps, injection, path traversal, secrets, unsafe deserialization, SSRF, tenant isolation, and trust in third-party input.',
  tests: 'TESTS lens — missing coverage of the risky paths, assertions that pass for the wrong reason, tests that depend on shared global state or neighbours, and behaviour changes with no test.',
  performance: 'PERFORMANCE lens — unbounded work or memory, N+1 queries, missing indexes, hot-path allocations, blocking calls in async code, and timeouts/pool settings.',
}
const lensKeys = (Array.isArray(A.lenses) && A.lenses.length ? A.lenses : ['code', 'domain']).filter(k => LENSES[k])
if (!lensKeys.length) throw new Error('codex-review: no known lens in args.lenses (use code, domain, security, tests, performance)')

const lensTask = key => `You are reviewing ${SCOPE} in your working directory. Be adversarial and concrete.
${LENSES[key]}
Read the diff, then the surrounding code of every changed hunk. Report only real defects, each with file, line, evidence from the code, a reachable failure scenario and a recommendation.
Do not report style nits unless they hide a defect. Give each finding a short unique id. Use verdict "blocked" only for defects that must not ship.${CONTEXT}${LESSONS}`

const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'needs_info'] },
    reasoning: { type: 'string' },
  },
}

phase('Review')
const lensResults = await pipeline(
  lensKeys,
  key => codexNode(lensTask(key), { schemaPreset: 'review', tier: TIER, kind: 'review', cwd: CWD || undefined, label: 'codex:' + key, phase: 'Review' }),
  async (review, key) => {
    if (isCodexError(review)) return { lens: key, error: review, findings: [] }
    const findings = (review.findings || []).map(f => ({ ...f, id: key + ':' + f.id, lens: key }))
    if (!TRIAGE) return { lens: key, verdict: review.verdict, summary: review.summary, findings }
    // A triage that fails keeps its finding, as needs_info — it is never dropped.
    const failedTriage = reason => ({ verdict: 'needs_info', reasoning: 'Claude triage failed (' + reason + ') — check this finding by hand', failed: true })
    const triaged = await parallel(findings.map(f => () =>
      agent(`A Codex reviewer reported this finding about ${SCOPE}${CWD ? ' in ' + CWD : ''}. Check it yourself against the code (read the file and its callers; run git if needed).
Decide: "confirmed" (the defect is real and the failure scenario is reachable), "refuted" (it is not — explain why), or "needs_info" (it depends on something you cannot see).
FINDING (JSON): ${JSON.stringify(f)}`, { label: 'triage:' + f.id, phase: 'Triage', schema: TRIAGE_SCHEMA })
        .then(t => ({ ...f, triage: t || failedTriage('no answer') }), e => ({ ...f, triage: failedTriage(String((e && e.message) || e)) }))))
    return { lens: key, verdict: review.verdict, summary: review.summary, findings: findings.map((f, i) => triaged[i] || { ...f, triage: failedTriage('stage failed') }) }
  },
)

// Every requested lens is accounted for: a lens whose stage died is a failed lens.
const lenses = lensKeys.map((key, i) => lensResults[i] || { lens: key, error: ucxError('stage_failed', 'the review stage for this lens failed'), findings: [] })
const failedLenses = lenses.filter(l => l.error)
const findings = lenses.flatMap(l => l.findings)
const failedTriages = findings.filter(f => f.triage && f.triage.failed)
const by = v => findings.filter(f => (TRIAGE ? f.triage && f.triage.verdict === v : v === 'confirmed'))
const confirmed = by('confirmed'), refuted = TRIAGE ? by('refuted') : [], needsInfo = TRIAGE ? by('needs_info') : []
if (failedLenses.length) log('⚠ ' + failedLenses.length + '/' + lensKeys.length + ' Codex lenses failed — the review is INCOMPLETE')

phase('Report')
const report = await agent(`Write the final review report for ${SCOPE}.
${failedLenses.length ? 'At the very top, state that these lenses FAILED and were not reviewed: ' + JSON.stringify(failedLenses.map(l => ({ lens: l.lens, error: l.error.kind, message: l.error.message }))) : ''}
Per-lens Codex verdicts: ${JSON.stringify(lenses.filter(l => !l.error).map(l => ({ lens: l.lens, verdict: l.verdict, summary: l.summary })))}
CONFIRMED findings (rank by severity; file:line, failure scenario, fix): ${JSON.stringify(confirmed)}
NEEDS-INFO findings (say what must be checked): ${JSON.stringify(needsInfo)}
REFUTED by triage (one line each, with the reason): ${JSON.stringify(refuted.map(f => ({ id: f.id, title: f.title, why: f.triage.reasoning })))}
End with a one-line overall verdict: ship / ship after fixes / do not ship.`, { label: 'report', phase: 'Report' })

if (failedTriages.length) log('⚠ ' + failedTriages.length + ' findings could not be triaged — kept as needs-info')

return {
  status: failedLenses.length || failedTriages.length ? 'incomplete' : 'complete',
  tier: TIER,
  report,
  lenses: lenses.map(l => ({ lens: l.lens, verdict: l.verdict || null, error: l.error ? l.error.kind : null })),
  confirmed, needsInfo,
  refuted: refuted.map(f => ({ id: f.id, title: f.title, why: f.triage.reasoning })),
}
