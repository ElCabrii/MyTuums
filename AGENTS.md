# Repository agent instructions

This file defines how agents work in MyTuums. Repository knowledge and change
routing live in [CONTEXT.md](CONTEXT.md).

## Workflow

1. Read [CONTEXT.md](CONTEXT.md), then follow its matching task branch to the
   owning workspace's `CONTEXT.md`. Discovery is complete when you can name the
   owner, source of truth, relevant invariants, and narrowest verification.
2. Inspect the implementation, configuration, tests, and working tree before
   editing. Preserve unrelated changes and use the existing architecture.
3. Make the smallest coherent change that solves the task. Keep public
   interfaces, dependencies, and infrastructure stable unless the task
   requires changing them.
4. Test observable behavior at the lowest practical layer. Update the owning
   context or deeper documentation when a public interface, architecture,
   invariant, workflow, deployment requirement, or security assumption changes.
5. Run the narrowest relevant checks while iterating, then `pnpm verify`. Fix
   failures introduced by the change and report any check that could not run.

## Repository guardrails

- Build UI from the configured shadcn preset. Add primitives with
  `pnpm --filter @my-tuums/web exec shadcn add <component>` and keep
  `apps/web/src/components/ui` generator-owned.
- Put shared client state in Jotai atoms under `apps/web/src/atoms`; put server
  state behind `jotai-tanstack-query` atoms. Hooks are for behavior that has no
  useful atom-shaped representation.
- Keep strict TypeScript, ESLint, and Oxlint anti-slop settings intact; resolve
  violations in code rather than weakening or suppressing rules.
- Never hand-format to satisfy Prettier. Run `pnpm format`; it is the only
  source of truth for formatting, and hand-matching its output wastes edits and
  still drifts.
- Regenerate generated artifacts with the commands listed in
  [CONTEXT.md](CONTEXT.md#generated-files).
- Keep non-production tooling on non-production databases and buckets. Database
  cleanup targets names ending in `_test`; E2E storage cleanup targets the dev
  or CI bucket.
- Apply schema changes through committed Drizzle migrations. Production runs
  migrations in the pre-deploy step.
- Keep credentials and `.env` contents out of source, logs, and reports.

## Tests

Full rules and the reasoning: [TESTING_STRATEGY.md](TESTING_STRATEGY.md).

- Do not add a test for every new function, and never for coverage. A test
  earns its place by protecting an invariant, a contract, a boundary, a
  security or data-integrity property, or a regression that actually happened.
- Test observable behavior. Not private helpers, call order, or mock
  interactions.
- Do not restate an assertion at a second layer. If a rule is pinned in
  `packages/auth/src/rules.ts`'s tests, do not re-prove it through a browser.
- Prefer the cheapest layer that can catch the failure:
  unit → `packages/api` integration → `e2e/tests/api` → a browser spec. Add a
  browser spec only for something that genuinely crosses the browser.
- Fixing a bug: reproduce it at the cheapest reliable level first, and name the
  issue in the test.
- No snapshots for structured behavior, no new fixture or factory until
  repeated setup justifies one, no retry to hide a flake.
- In `packages/api`, use `createTestUser`; reach for `createPasswordTestUser`
  only when a password being accepted or refused is the assertion.

## Completion

A change is complete when:

- the requested behavior works through its caller-visible interface;
- affected tests pass at the lowest relevant layer;
- relevant lint, typecheck, build, and documentation checks pass;
- `pnpm format` has been run. Formatting is checked by `pnpm format:check`,
  which `pnpm lint` does not cover, so a change that passes lint locally can
  still fail on formatting alone;
- `pnpm verify` passes. It is exactly what CI's `Verify` job runs;
- generated and documentation artifacts agree with their sources of truth;
- the final report lists changed behavior, verification run, and remaining
  blockers or risks.
