# e2e — agent guide

## Responsibility

Playwright coverage of the whole stack over real HTTP: the real server, the
real Postgres, and — when the `S3_*` group is present — a real bucket. Its own
workspace package so Playwright never enters the root manifest.

The suite is slow (browser install, real sign-ups, two servers). Reach for
`pnpm test:unit` or `pnpm test:integration` first; CI runs this on every push
regardless. Add a spec here only for a journey no cheaper layer can prove.

## Start here

| File                   | Why                                                                            |
| ---------------------- | ------------------------------------------------------------------------------ |
| `playwright.config.ts` | The three projects, both `webServer` entries, `stackEnv`, the `E2E` constants. |
| `global-setup.ts`      | The once-per-run truncate, and the canonical `DATABASE_URL` fix-up.            |
| `support/db.ts`        | Every seeding helper, plus `truncateAll()` and the bucket purge.               |
| `support/fixtures.ts`  | The extended `test` handle: `bobPage`, `signedOutPage`, `db`.                  |
| `tests/auth.setup.ts`  | How alice and bob come to exist, and how alice becomes the moderator.          |

## Change map

| Intent                              | Primary                                         | Also touch                                        |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Add a browser journey               | `tests/specs/<name>.spec.ts`                    | `support/db.ts` if it needs new seed data         |
| Add a transport-level assertion     | `tests/api/<name>.spec.ts`                      | — (no browser, no auth state)                     |
| Add a fixture account or seed shape | `support/users.ts`, `support/db.ts`             | `tests/auth.setup.ts` when it needs storage state |
| Add a page-scoped locator helper    | `support/post-card.ts` or a new `support/` file | —                                                 |
| Change ports or stack env           | `playwright.config.ts`                          | `../docs/operations.md`                           |
| Add a shared browser context        | `support/fixtures.ts`                           | —                                                 |

## Invariants

- **`workers: 1`.** Every spec shares one Postgres and one in-process server
  rate limiter; parallel workers 429 each other and fight over fixtures, and
  the failure surfaces three specs away from its cause. Consequence: the
  database is truncated exactly once, in `global-setup.ts`, so specs must seed
  content unique enough to find and must never assume an empty database.
- **Re-derive the `_test` database URL before importing `@my-tuums/db`.** That
  package reads `DATABASE_URL` at module scope, and the `e2e` script loads the
  repo `.env` — the _dev_ database. A static import hoists above the fix-up and
  connects to the wrong database; `global-setup.ts` and `support/db.ts` both
  use dynamic `import()` after the assignment. `assertTestDatabase()` is the
  backstop: it refuses any database whose name does not end in `_test`.
- **Never point the suite at the production bucket.** `truncateAll()` deletes
  uploaded objects by prefix on every run. Use the `dev` bucket locally; CI
  uses the `ci` bucket.
- **The `S3_*` group is all-or-nothing.** `apps/server/src/env.ts` refuses to
  boot on a partial group, so `s3Env()` forwards all of it or none; upload
  specs skip themselves when it is absent (fork pull requests included).
- **`RESEND_API_KEY` is blanked in `stackEnv`.** `webServer.env` merges over
  `process.env`, so a developer with a real key had every fixture sign-up
  firing a live send — which exhausts the quota and slows sign-up enough to
  race the session-store wait on `/welcome`. Blanked rather than deleted,
  because merging cannot remove a key; `packages/auth` treats `""` as absent
  and logs the message, which is where reset and verification links are read.
- **`AUTH_RATE_LIMIT=false` in `stackEnv` only.** One IP drives the whole run,
  which is exactly the shape better-auth's `customRules` exist to stop. The
  app's own `/rpc` limiter stays on and has its own spec.
- **Locators are structural or accessibility-based.** `data-testid` is banned
  across the app; use `getByRole`/`getByLabel`/`getByTitle`, or a helper in
  `support/`. `postCardWithText` documents the deepest-div heuristic that
  stands in for a missing role.
- **Storage state is cookies only.** `auth.setup.ts` captures it through an
  `APIRequestContext`, which has no page and therefore no `localStorage`. A
  spec asserting "nothing stored" must open a fresh `browser.newContext`.
- **The setup project's file must live under `tests/`.** `testMatch` only
  filters files the `testDir` scan already found; it cannot reach outside it.
- **Fixture sign-up goes through `E2E.webUrl`, not `E2E.serverUrl`.** The
  session cookie has no explicit `Domain`, so it is scoped to the host that
  received the request — which must be the origin the browser will later use.

## Dependencies and boundaries

- `@my-tuums/api` is a dependency (destructive storage cleanup in
  `support/db.ts`); `@my-tuums/db` and `@my-tuums/auth` are devDependencies.
- Specs mirror shared constants rather than importing them where importing
  would make the spec agree with the code by construction — see the note on
  `THREAD_ANCESTOR_MAX` in `tests/specs/thread.spec.ts`.
- `setUserRole` writes the row directly. The better-auth admin plugin's
  endpoints are 404'd by the server, so this is the only way a spec gets a
  moderator; alice is promoted in `tests/auth.setup.ts`.
- `moderation.spec.ts` stops at "appeal submitted" on purpose: reviewing an
  appeal excludes the moderator who took the action, so uphold and overturn
  need a second moderator fixture and stay covered by
  `packages/api/src/moderation.int.test.ts`.

## Generated files

`.auth/*.json` (storage state), `test-results/`, `playwright-report/` — all
git-ignored, all rebuilt by a run.

## Verification

| Command                                                        | Covers                      |
| -------------------------------------------------------------- | --------------------------- |
| `pnpm test:e2e`                                                | the whole suite             |
| `pnpm --filter @my-tuums/e2e e2e -- tests/specs/theme.spec.ts` | one spec                    |
| `pnpm --filter @my-tuums/e2e e2e:ui`                           | the interactive runner      |
| `pnpm --filter @my-tuums/e2e e2e:report`                       | reopen the last HTML report |
| `pnpm --filter @my-tuums/e2e lint` / `typecheck`               | this package alone          |

Needs a reachable Postgres (`pnpm docker:up` or a local one) and, for the
upload specs, the dev bucket's `S3_*` values in `.env`.

## Further reading

- [docs/architecture.md](../docs/architecture.md) — what the stack this suite
  drives actually looks like.
- [docs/operations.md](../docs/operations.md) — ports, buckets, environments.
- [.github/AGENTS.md](../.github/AGENTS.md) — how CI runs this job.
