# ultracodex (plugin)

Blend Codex headless (`codex exec`) nodes into Claude Code's Workflow (ultracode)
orchestration. Provides the **`codex-workflow`** skill.

This is the plugin directory. For full documentation, installation, and the
mental model, see the [repository README](../../README.md).

## Contents

- `skills/codex-workflow/SKILL.md` — Pattern A mental model, the `codexNode`
  relay helper, routing rules, concurrency/cost guidance, preflight.
- `skills/codex-workflow/references/codex-headless.md` — `codex exec` reference,
  model tiers & reasoning effort (GPT-5.6: Sol/Terra/Luna, `low`→`max`, plus
  `ultra` on Sol/Terra),
  sandbox tiers, output extraction, gotchas, escalation patterns.
- `skills/codex-workflow/references/workflow-templates.md` — the canonical
  `codexNode` helper plus four complete, copy-paste blended Workflow scripts
  (cross-model review, judge panel, cross-check, loop-until-dry) and batch-node /
  large-payload variants.

## Prerequisites

- Claude Code with the Workflow tool (ultracode).
- Codex CLI installed and authenticated (`codex login`).

## Local testing

```bash
claude --plugin-dir .            # from this directory
claude plugin validate .         # validate plugin.json + skill frontmatter
```
