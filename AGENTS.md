# AGENTS.md

Stable operating guidance for coding agents in this repository.

## Mission

- Keep Genesis reliable as a multi-entry session runtime (`Interactive / Print / JSON / RPC`).
- Optimize for correctness first, observability second, and iteration speed third.
- Prefer explicit system behavior over implicit fallbacks.

## First Principles

- Single authority: session truth must have one owner per concern, not competing sources.
- Clear boundaries: host wiring, runtime orchestration, and kernel provider plumbing stay decoupled.
- Deterministic failure: when prerequisites are missing, fail fast with explicit errors.
- Verifiable changes: every meaningful behavior change must be testable and observable.
- Reversible evolution: refactors should be incremental and low-blast-radius.

## Architectural Invariants

- `app-cli` is host-focused: process entry, TTY lifecycle, command wiring, debug plumbing.
- `app-runtime` owns session orchestration and stable runtime contracts.
- `kernel` is the authority for upstream session/provider core facts.
- `app-ui` owns presentation semantics and user-facing copy/layout behavior.
- `app-tui-core` owns terminal capability detection, frame/diff, and render mechanics.
- `app-tools` owns tool catalog, risk classification, permission policy, and audit.

## Design Rules

- Do not add unbounded compatibility layers by default.
- Do not silently downgrade critical flows (for example, "looks resumed" but not truly resumable).
- Prefer explicit guardrails:
  - detect invalid state early,
  - return actionable user-facing errors,
  - log structured debug events for diagnosis.
- Preserve user-visible behavior during refactors unless the change is intentional and documented.

## Runtime Safety Rules

- Treat resume/session continuity as a correctness feature, not a best-effort feature.
- Never cross-switch sessions implicitly unless safety conditions are explicit and test-covered.
- For asynchronous background persistence, avoid unhandled rejections and preserve host stability.
- For lifecycle edges (close, recover, fatal errors, queued turns), add regression tests before/with code changes.

## Refactor Strategy

- Change one capability slice at a time.
- Avoid mixing host entry changes, authority model rewrites, and rendering semantics in one patch.
- Keep `mode-dispatch.ts` shrinking toward orchestration-only responsibilities.
- Push presentation logic from `app-cli` to `app-ui` whenever feasible.

## Quality Gates

Run before finishing meaningful changes:

```bash
npm run check:lint
npm run check:types
```

Run focused tests for touched areas (examples):

```bash
npx vitest run packages/app-cli/src/test/mode-dispatch.test.ts
npx vitest run packages/app-cli/src/test/interactive-tty-workbench.test.ts
npm run test -w @pickle-pee/runtime -- src/test/create-app-runtime.test.ts
```

For session lifecycle/race-condition changes, include targeted regression tests in the same patch.

## Documentation Rules

- Keep architecture wording aligned between `README.md` and `README.en.md`.
- `README*` is external-facing narrative; `AGENTS.md` is execution policy.
- Use explicit, testable wording; avoid vague qualifiers.
- `technical-plan/` is gitignored; do not rely on it as commit-tracked evidence.

## Commit Rules

- Prefer small commits with one clear intent.
- Recommended prefixes:
  - `fix: ...`
  - `refactor: ...`
  - `test: ...`
  - `docs: ...`
