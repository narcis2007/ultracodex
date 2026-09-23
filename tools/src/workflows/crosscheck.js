export const meta = {
  name: 'crosscheck',
  description: 'One load-bearing claim, one Codex (GPT) attempt to refute it — astra@max by default. An errored cross-check is never a pass.',
  whenToUse: 'Before acting on a risky conclusion. args: { claim, evidence, cwd, tier: final|daily|light, fast }',
  phases: [{ title: 'Cross-check', detail: 'Codex tries to refute the claim' }],
}

/*@@ULTRACODEX_HELPER@@*/

const A = args || {}
if (!A.claim || typeof A.claim !== 'string') throw new Error('crosscheck: args.claim (string) is required')
const TIER = ['light', 'daily', 'final'].includes(A.tier) ? A.tier : 'final'

phase('Cross-check')
const verdict = await codexNode(`Another model concluded the claim below. Try hard to REFUTE it.
Check it against the code and data in your working directory where relevant (read the files; run read-only commands).
Set refuted=false only if the evidence is airtight; otherwise refuted=true. confidence is 0..1; reasoning must cite what you checked.
CLAIM:
${A.claim}${A.evidence ? '\nEVIDENCE OFFERED:\n' + A.evidence : ''}`,
  { schemaPreset: 'verdict', tier: TIER, kind: 'verify', cwd: A.cwd || undefined, label: 'codex:crosscheck', phase: 'Cross-check', ...(A.fast === true && TIER === 'final' ? { serviceTier: 'priority' } : {}) })

const ok = !isCodexError(verdict)
return {
  status: ok ? 'complete' : 'incomplete',
  trustworthy: ok && verdict.refuted === false,
  verdict: ok ? { refuted: verdict.refuted, confidence: verdict.confidence, reasoning: verdict.reasoning, codex: verdict._codex } : verdict,
  codexUsage: ucxUsage(),
}
