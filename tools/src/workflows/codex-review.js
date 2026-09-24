export const meta = {
  name: 'codex-review',
  description: 'Adversarial code review by Codex (GPT) through several lenses, each finding then checked in the code by Claude; high/critical disagreements go to astra@max. Daily tier sol@max, final gate astra@max. Fails closed.',
  whenToUse: 'Second-model review of a branch/commit/uncommitted change. args: { cwd, base | commit | uncommitted, lenses, tier: light|daily|final, context, lessons, triage, escalate, fast }',
  phases: [
    { title: 'Review', detail: 'one Codex review per lens (read-only, hermetic)' },
    { title: 'Triage', detail: 'Claude checks each Codex finding against the code' },
    { title: 'Escalate', detail: 'astra@max settles the high/critical findings Claude refuted or could not settle, in one run' },
    { title: 'Report', detail: 'confirmed / disputed / refuted / needs-info / unverified' },
  ],
}

/*@@ULTRACODEX_HELPER@@*/

const A = args || {}
const CWD = A.cwd || null
const TIER = A.tier === 'final' ? 'final' : A.tier === 'light' ? 'light' : 'daily'
const TRIAGE = A.triage !== false
// Escalate disagreements, astra last (off with escalate: false; moot when astra reviewed)
const ESCALATE = TRIAGE && TIER !== 'final' && A.escalate !== false
// fast: true → the Fast service tier for the astra nodes only (more usage, less waiting)
const FAST = A.fast === true ? { serviceTier: 'priority' } : {}
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

// Claude also rates each finding's severity itself: Codex tends to rate findings above their
// real impact, and the report ranks and decides by Claude's rating (every change is shown).
const SEVERITIES = ['critical', 'high', 'medium', 'low']
const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'severity', 'severityReason', 'reasoning'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'needs_info'] },
    severity: { type: 'string', enum: SEVERITIES },
    severityReason: { type: 'string' },
    reasoning: { type: 'string' },
  },
}
const TRIAGE_SEVERITY = `Then rate its severity yourself (critical / high / medium / low) — Codex tends to rate findings higher than their real impact. Judge realistic impact times likelihood under the owner's context and threat model (above, when given): lower it when the failure needs conditions that practically never occur, when it is caught, logged or harmless, or when an existing control already covers it; keep or raise it when someone the threat model includes can trigger it at will. If your severity differs from Codex's, give the reason in severityReason (one sentence naming the precondition or the control); otherwise leave severityReason empty. For a refuted or needs-info finding, rate it as if it were real.`

phase('Review')
const lensResults = await pipeline(
  lensKeys,
  key => codexNode(lensTask(key), { schemaPreset: 'review', tier: TIER, kind: 'review', cwd: CWD || undefined, label: 'codex:' + key, phase: 'Review', ...(TIER === 'final' ? FAST : {}) }),
  async (review, key) => {
    if (isCodexError(review)) return { lens: key, error: review, findings: [] }
    // Positional ids: Codex-chosen ids can collide or be empty, and must never cost a
    // finding (or break the escalation batch). Codex's own id is kept as sourceId.
    const findings = (review.findings || []).map((f, i) => ({ ...f, sourceId: f.id, id: key + ':' + (i + 1), lens: key }))
    if (!TRIAGE) return { lens: key, verdict: review.verdict, summary: review.summary, findings }
    // A triage that fails keeps its finding, as needs_info — it is never dropped.
    const failedTriage = reason => ({ verdict: 'needs_info', reasoning: 'Claude triage failed (' + reason + ') — check this finding by hand', failed: true })
    const triaged = await parallel(findings.map(f => () =>
      agent(`A Codex reviewer reported this finding about ${SCOPE}${CWD ? ' in ' + CWD : ''}. Check it yourself against the code (read the file and its callers; run git if needed).${ucxWhere(CWD)}
Decide: "confirmed" (the defect is real and the failure scenario is reachable), "refuted" (it is not — explain why), or "needs_info" (it depends on something you cannot see).${CONTEXT}
${TRIAGE_SEVERITY}
FINDING (JSON): ${JSON.stringify(f)}`, { label: 'triage:' + f.id, phase: 'Triage', schema: TRIAGE_SCHEMA, agentType: UCX_READER })
        .then(t => ({ ...f, triage: t || failedTriage('no answer') }), e => ({ ...f, triage: failedTriage(String((e && e.message) || e)) }))))
    return { lens: key, verdict: review.verdict, summary: review.summary, findings: findings.map((f, i) => triaged[i] || { ...f, triage: failedTriage('stage failed') }) }
  },
)

// Every requested lens is accounted for: a lens whose stage died is a failed lens.
const lenses = lensKeys.map((key, i) => lensResults[i] || { lens: key, error: ucxError('stage_failed', 'the review stage for this lens failed'), findings: [] })
const failedLenses = lenses.filter(l => l.error)
const findings = lenses.flatMap(l => l.findings)
const failedTriages = findings.filter(f => f.triage && f.triage.failed)
if (failedLenses.length) log('⚠ ' + failedLenses.length + '/' + lensKeys.length + ' Codex lenses failed — the review is INCOMPLETE')

// A high/critical Codex finding that Claude refuted or could not settle is where the two
// families disagree on something that matters: gpt-6-astra reads the code and decides, in
// one run. astra refuting it settles it; astra upholding it makes it DISPUTED (the owner
// decides — never silently dropped); a failed escalation leaves it unresolved (needs-info)
// and the review incomplete.
const escalation = { ran: false, checked: 0, upheld: 0, settled: 0, failed: 0 }
const contested = ESCALATE
  ? findings.filter(f => ['critical', 'high'].includes(f.severity) && f.triage && ['refuted', 'needs_info'].includes(f.triage.verdict))
  : []
if (contested.length) {
  phase('Escalate')
  escalation.ran = true
  escalation.checked = contested.length
  let batch
  try {
    batch = await codexBatchNode(`You are the final judge between two reviewers. Each item below is a defect a Codex reviewer reported about ${SCOPE} in your working directory; a Claude reviewer then doubted it (claude_triage says why).
Read the cited code and its callers yourself. Set refuted=true if the defect is not real or its failure scenario is unreachable; refuted=false only when the code confirms it.
confidence is 0..1. reasoning must cite what you read and answer the doubt.`,
      contested.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, evidence: f.evidence, failure_scenario: f.failure_scenario, claude_triage: f.triage.reasoning })),
      { tier: 'final', kind: 'verify', cwd: CWD || undefined, label: 'codex:escalate', phase: 'Escalate', ...FAST })
  } catch (e) {
    batch = ucxError('stage_failed', 'the escalation failed: ' + String((e && e.message) || e))
  }
  for (const f of contested) {
    const v = isCodexError(batch) ? batch
      : batch.ambiguous.includes(f.id) ? ucxError('ambiguous_verdict', 'astra answered ' + f.id + ' more than once')
        : (batch.byId.get(f.id) || ucxError('missing_from_batch', 'astra returned no verdict for ' + f.id))
    if (isCodexError(v)) { escalation.failed++; f.escalation = { error: v.kind } }
    else { f.escalation = v; if (v.refuted === true) escalation.settled++; else escalation.upheld++ }
  }
  if (escalation.failed) log('⚠ the astra escalation could not check ' + escalation.failed + '/' + contested.length + ' findings — they stay unresolved and the review is INCOMPLETE')
  if (escalation.upheld) log('⚠ ' + escalation.upheld + ' finding(s) DISPUTED: Claude doubted them, gpt-6-astra upheld them')
}
// bucket = triage verdict, moved by the escalation. A contested finding whose escalation
// failed is unresolved — needs-info, never quietly left refuted.
const bucketOf = f => {
  const e = f.escalation
  if (e && e.error) return 'needs_info'
  if (e) return e.refuted === true ? 'refuted' : 'disputed'
  return f.triage.verdict
}
// Without triage nothing is confirmed: Codex's findings are reported as untriaged.
const by = v => (TRIAGE ? findings.filter(f => f.triage && bucketOf(f) === v) : [])
const confirmed = by('confirmed'), refuted = by('refuted'), needsInfo = by('needs_info'), disputed = by('disputed')
const untriaged = TRIAGE ? [] : findings
const whyRefuted = f => (f.escalation && !f.escalation.error ? 'gpt-6-astra: ' + f.escalation.reasoning : f.triage.reasoning)
// Confirmed findings carry Claude's own severity from triage; Codex's stays as codexSeverity
// and every change is listed. (The escalation above still keys on Codex's severity: a
// high/critical finding Claude refuted gets its astra tiebreak whatever Claude rated it.)
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const rated = f => ({
  ...f,
  severity: f.triage && SEVERITIES.includes(f.triage.severity) ? f.triage.severity : f.severity,
  codexSeverity: f.severity,
  severityReason: (f.triage && f.triage.severityReason) || '',
})
const confirmedRated = confirmed.map(rated).sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9))
const severityChanges = confirmedRated.filter(f => f.severity !== f.codexSeverity)
  .map(f => ({ id: f.id, title: f.title, codex: f.codexSeverity, claude: f.severity, why: f.severityReason }))

phase('Report')
const report = await agent(`Write the final review report for ${SCOPE}${CWD ? ' in ' + CWD : ''}.${ucxWhere(CWD)}
${failedLenses.length ? 'At the very top, state that these lenses FAILED and were not reviewed: ' + JSON.stringify(failedLenses.map(l => ({ lens: l.lens, error: l.error.kind, message: l.error.message }))) : ''}
Per-lens Codex verdicts: ${JSON.stringify(lenses.filter(l => !l.error).map(l => ({ lens: l.lens, verdict: l.verdict, summary: l.summary })))}
CONFIRMED findings, ranked by "severity" — Claude's own rating after checking the code; "codexSeverity" is what Codex said. Where they differ, show "Codex: <codexSeverity> → <severity>" with the severityReason. For each: file:line, failure scenario, fix: ${JSON.stringify(confirmedRated)}
${disputed.length ? 'DISPUTED findings (Claude doubted them, the gpt-6-astra escalation upheld them — present both sides and say the owner must decide): ' + JSON.stringify(disputed.map(f => ({ id: f.id, title: f.title, file: f.file, line: f.line, severity: f.severity, claude: f.triage.reasoning, astra: f.escalation.reasoning }))) : ''}
${untriaged.length ? 'UNTRIAGED Codex findings (triage was off — present them as unverified claims, not as confirmed defects): ' + JSON.stringify(untriaged) : ''}
NEEDS-INFO findings (say what must be checked; those with an "escalation.error" are high/critical findings Claude doubted whose gpt-6-astra tiebreak FAILED — say so plainly, they are unresolved): ${JSON.stringify(needsInfo)}
REFUTED findings (one line each, with the reason): ${JSON.stringify(refuted.map(f => ({ id: f.id, title: f.title, why: whyRefuted(f) })))}
End with a one-line overall verdict that follows these ratings: "do not ship" when a confirmed or disputed finding is critical/high, or a critical/high one is still unresolved (needs-info); "ship after fixes" when the worst is medium; "ship" when only low ones remain.`, { label: 'report', phase: 'Report', agentType: UCX_READER })

if (failedTriages.length) log('⚠ ' + failedTriages.length + ' findings could not be triaged — kept as needs-info')

return {
  // an enabled escalation that could not settle every contested finding leaves the review incomplete
  status: failedLenses.length || failedTriages.length || escalation.failed ? 'incomplete' : 'complete',
  tier: TIER,
  report,
  lenses: lenses.map(l => ({ lens: l.lens, verdict: l.verdict || null, error: l.error ? l.error.kind : null })),
  confirmed: confirmedRated, severityChanges, disputed, needsInfo, untriaged,
  refuted: refuted.map(f => ({ id: f.id, title: f.title, why: whyRefuted(f) })),
  escalation: ESCALATE ? escalation : null,
  codexUsage: ucxUsage(),
}
