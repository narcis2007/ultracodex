export const meta = {
  name: 'judge-panel',
  description: 'Several Claude approaches plus one Codex approach, scored by a Claude+Codex jury; only candidates judged by the other model family are ranked. Claude synthesizes.',
  whenToUse: 'Design decisions with a wide solution space. args: { problem, angles: [{key, prompt}], cwd, codexCandidate }',
  phases: [
    { title: 'Generate', detail: 'Claude angles + one Codex candidate (sol@max)' },
    { title: 'Judge', detail: 'each candidate scored by a Claude juror and a Codex juror (sol@xhigh)' },
    { title: 'Synthesize', detail: 'winner plus the best ideas of the runners-up' },
  ],
}

/*@@ULTRACODEX_HELPER@@*/

const A = args || {}
if (!A.problem || typeof A.problem !== 'string') throw new Error('judge-panel: args.problem (string) is required')
const CWD = A.cwd || undefined
const ANGLES = Array.isArray(A.angles) && A.angles.length ? A.angles : [
  { key: 'simplest', prompt: 'Bias toward the simplest version that fully solves it and can ship first.' },
  { key: 'risk-first', prompt: 'Bias toward de-risking the hardest unknown first, even at some extra cost.' },
]

const SOLUTION = {
  type: 'object', additionalProperties: false, required: ['approach', 'plan', 'risks'],
  properties: { approach: { type: 'string' }, plan: { type: 'string' }, risks: { type: 'string' } },
}
const SCORE = {
  type: 'object', additionalProperties: false, required: ['score', 'rationale'],
  properties: { score: { type: 'number', description: '0..10' }, rationale: { type: 'string' } },
}
const task = extra => `PROBLEM:\n${A.problem}\n\n${extra}\nReturn the approach, a concrete plan, and its main risks.`

phase('Generate')
// Every requested candidate is accounted for; a failed generation is reported, not dropped.
const requested = [
  ...ANGLES.map(a => ({ author: 'claude:' + a.key, run: () => agent(task(a.prompt), { label: 'gen:' + a.key, phase: 'Generate', schema: SOLUTION })
    .then(s => (s ? { ...s, author: 'claude:' + a.key, family: 'claude' } : { __failed: 'the generator returned nothing' }), e => ({ __failed: String((e && e.message) || e) })) })),
  ...(A.codexCandidate === false ? [] : [{ author: 'codex', run: () => codexNode(task('Propose the approach you think is most robust.'),
    { schema: SOLUTION, tier: 'daily', kind: 'ask', cwd: CWD, label: 'gen:codex', phase: 'Generate' })
    .then(s => (isCodexError(s) ? { __failed: s ? s.kind + ': ' + s.message : 'no result' } : { approach: s.approach, plan: s.plan, risks: s.risks, author: 'codex', family: 'codex' })) }]),
]
const generated = await parallel(requested.map(r => r.run))
const failedGenerations = requested.map((r, i) => ({ author: r.author, out: generated[i] }))
  .filter(x => !x.out || x.out.__failed).map(x => ({ author: x.author, why: x.out ? x.out.__failed : 'stage failed' }))
const candidates = generated.filter(c => c && !c.__failed)
if (failedGenerations.length) log('⚠ candidates not generated: ' + failedGenerations.map(f => f.author + ' (' + f.why + ')').join('; '))
if (!candidates.length) return { status: 'incomplete', final: null, winner: null, ranking: [], failedGenerations, codexUsage: ucxUsage() }

phase('Judge')
const judgePrompt = c => `Score this approach 0..10 for the problem (correctness, risk, cost, time to value). Be strict.\nPROBLEM:\n${A.problem}\nAPPROACH (JSON):\n${JSON.stringify({ approach: c.approach, plan: c.plan, risks: c.risks })}`
const judgedRaw = (await parallel(candidates.map(c => () => parallel([
  () => agent(judgePrompt(c), { label: 'judge:claude:' + c.author, phase: 'Judge', schema: SCORE }),
  () => codexNode(judgePrompt(c), { schema: SCORE, tier: 'daily', kind: 'verify', cwd: CWD, label: 'judge:codex:' + c.author, phase: 'Judge' }),
]).then(([cl, cx]) => {
  const jurors = [
    // a score outside 0..10 (another scale, a typo) invalidates that juror instead of deciding the ranking
    cl && typeof cl.score === 'number' && cl.score >= 0 && cl.score <= 10 ? { family: 'claude', score: cl.score, rationale: cl.rationale } : null,
    !isCodexError(cx) && typeof cx.score === 'number' && cx.score >= 0 && cx.score <= 10 ? { family: 'codex', score: cx.score, rationale: cx.rationale } : null,
  ].filter(Boolean)
  // No candidate is ranked on its own family's opinion alone.
  const crossFamily = jurors.some(j => j.family !== c.family)
  return { candidate: c, jurors, avg: crossFamily ? jurors.reduce((s, j) => s + j.score, 0) / jurors.length : null }
}))))
// a candidate whose judging stage died is unranked, not forgotten
const judged = candidates.map((c, i) => judgedRaw[i] || { candidate: c, jurors: [], avg: null })

const ranked = judged.filter(j => j.avg !== null).sort((a, b) => b.avg - a.avg)
if (!ranked.length) {
  log('no candidate received a cross-family verdict — nothing is rankable')
  return { status: 'incomplete', final: null, winner: null, failedGenerations, ranking: judged.map(j => ({ author: j.candidate.author, jurors: j.jurors.map(x => x.family) })), codexUsage: ucxUsage() }
}

phase('Synthesize')
const final = await agent(`Write the final approach for the problem. Base it on the winner and graft the best ideas of the runners-up; say what you took from whom.
PROBLEM:\n${A.problem}
WINNER: ${JSON.stringify(ranked[0].candidate)}
RUNNERS-UP: ${JSON.stringify(ranked.slice(1).map(j => j.candidate))}
JURY NOTES: ${JSON.stringify(ranked.map(j => ({ author: j.candidate.author, avg: j.avg, jurors: j.jurors })))}`, { label: 'synthesize', phase: 'Synthesize' })

return {
  status: ranked.length === candidates.length && !failedGenerations.length ? 'complete' : 'partial',
  final,
  winner: ranked[0].candidate.author,
  failedGenerations,
  unranked: judged.filter(j => j.avg === null).map(j => j.candidate.author),
  ranking: ranked.map(j => ({ author: j.candidate.author, avg: Math.round(j.avg * 10) / 10, jurors: j.jurors.map(x => x.family + ':' + x.score) })),
  codexUsage: ucxUsage(),
}
