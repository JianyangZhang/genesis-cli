# AGENTS.md

This file gives coding agents stable, repo-specific operating guidance.

## Purpose

- Use this as the default project context for any coding agent session.
- Keep this file concise, actionable, and updated with current repo reality.
- Treat `README.md` as external-facing narrative; treat this file as execution guidance.

## Project Identity

- Genesis is a multi-entry session runtime (`Interactive / Print / JSON / RPC`).
- Primary architecture direction:
  - `app-cli` converges toward host-only concerns (process entry, TTY lifecycle, debug wiring).
  - `app-runtime` owns shared session orchestration and stable runtime contracts.
  - `kernel` is the authority source for session/provider core facts.

## Package Boundaries

- `packages/app-cli`: host wiring, mode hosting, TTY lifecycle, debug plumbing.
- `packages/app-tui-core`: terminal capability/modeling, frame/patch/composer rendering mechanics.
- `packages/app-ui`: presentation semantics (slash commands, resume browser UX, formatters, footer content).
- `packages/app-runtime`: session facade, event normalization, recent-session catalog, governance/planning integration.
- `packages/app-tools`: tool catalog, risk classification, permission policy, audit.
- `packages/kernel`: provider wiring and upstream session plumbing.

## Quality Gates

Run these before finishing meaningful changes:

```bash
npm run check:lint
npm run check:types
```

Run focused tests for changed areas (examples):

```bash
npx vitest run packages/app-cli/src/test/mode-dispatch.test.ts
npx vitest run packages/app-cli/src/test/interactive-tty-workbench.test.ts
npm run test -w @pickle-pee/runtime -- src/test/create-app-runtime.test.ts
```

## Refactor Rules

- Prefer incremental, reversible refactors.
- Move one capability slice at a time; avoid changing host entry, authority source, and rendering semantics in a single step.
- Keep behavior stable while shrinking `mode-dispatch.ts`.
- Push product copy/theme/layout semantics away from `app-cli` and into `app-ui` where possible.
- Protect authority merge behavior with regression tests when touching recent-session paths.

## Documentation Rules

- If architecture wording changes, keep `README.md` and `README.en.md` aligned.
- `technical-plan/` is ignored by git in this repo; do not assume its edits are commit-tracked.
- Use explicit wording; avoid vague qualifiers in architecture claims.

## Preferred Commit Style

- Use small commits with clear scope.
- Suggested prefixes:
  - `refactor: ...`
  - `fix: ...`
  - `test: ...`
  - `docs: ...`
