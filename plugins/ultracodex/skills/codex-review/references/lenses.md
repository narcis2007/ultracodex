# Review lenses

Paste one lens per Codex review run (the `ultracodex:codex-review` workflow uses the same
texts). Always add the scope sentence, the owner's context and, if present, the lessons file.

Common preamble:

> You are reviewing SCOPE in your working directory. Be adversarial and concrete. Read the
> diff, then the surrounding code of every changed hunk (callers, callees, tests). Report only
> real defects, each with file, line, evidence from the code, a reachable failure scenario and a
> recommendation. No style nits unless they hide a defect. Use verdict "blocked" only for
> defects that must not ship.

## code

Correctness, edge cases, error handling, resource and lifecycle handling, concurrency and
ordering, and API/contract mismatches between caller and callee — headers, request bodies,
query parameters and their exact string forms. Tests that cannot fail, skip silently, or pass
because of shared global state. Behaviour changes with no test.

## domain

Business rules and invariants; data integrity across multi-step writes; idempotency and
retries of external effects (one claim per effect, owner-fenced leases longer than the work they
guard); clocks and time zones (database time vs process time, third-party timestamps without a
zone); money and quantities; what the user sees versus what is actually known (a screen must not
assert what a cache cannot prove); permanent vs transient failure classes; irreversible actions
guarded only by assumptions.

## security

Authentication and authorization gaps (including tenant/organization isolation), injection,
path traversal (URL path segments reaching object keys or the filesystem), secrets in code or
logs, unsafe deserialization and parsers exposed to third-party content (sizes from headers,
unbounded bodies, XML entities, unchecked arithmetic), SSRF, and trust in client-supplied data.

## tests

Coverage of the risky paths; assertions that pass for the wrong reason; tests that depend on
neighbours or shared process-global state (unique identities per test); concurrency tests that
would not fail if the guarded write were removed (prove with a mutation); tests that are
skipped in CI because a dependency is missing.

## performance

Unbounded work or memory, N+1 queries, missing indexes for new query shapes, allocations on hot
paths, blocking calls in async code, connection-pool and keep-alive settings for internal
services, and timeouts that do not add up to the leases or deadlines they sit under.
