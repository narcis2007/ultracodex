# Implementation brief — template

Copy, fill in, save with the Write tool, and point the request's `taskFile` at it. Keep it
concrete: Codex does exactly what the brief says and verifies exactly what it lists.

~~~markdown
# Task: <one line>

## Goal
<What must be true when this is done — user-visible behaviour, not steps.>

## Context
- Repository: <name>, working directory is a dedicated worktree on branch `codex/<slug>`.
- Relevant code: <paths, modules, entry points>. Read them before changing anything.
- Background: <why this change, links to plans/issues, domain rules that must hold>.

## Scope
- In: <list>
- Out (do NOT touch): <list — e.g. migrations already applied, public API, unrelated files>

## House rules
- Follow AGENTS.md / CLAUDE.md in the repository (read them first).
- <formatting rules, e.g. "no repo-wide formatters; targeted edits only">
- <language/style constraints>
- Do not commit, push, create branches or modify git config. Leave all changes in the working tree.

## Acceptance criteria
1. <observable criterion>
2. <observable criterion>
3. Tests: <which tests must exist/pass; include the failure-path test>

## Verification — run these, in this order, and report each exit code
```bash
<exact commands, e.g.>
cargo fmt
cargo clippy --all-targets -j 1 -- -D warnings
CARGO_TARGET_DIR=<worktree>/target cargo test -j 1 -- --test-threads=2
```
Resource limits on this machine: <e.g. -j 1, one test binary at a time, no parallel builds>.

## Report
Return the structured report: status (complete / partial / blocked), a task list with a
reason for anything not done, files changed, every command run with its exit code, test counts,
open questions and risks. Do not claim a test passed unless you ran it in this session.
~~~

Tips:

- One goal per brief. Split large work into sequential briefs (resume the same session for
  follow-ups so Codex keeps its context).
- Name the traps you already know (e.g. strict `required` in schemas, time zones of third-party
  timestamps, contract shapes between UI and API) — Codex does not share your memory.
- Say what "done" looks like in commands, not adjectives.
