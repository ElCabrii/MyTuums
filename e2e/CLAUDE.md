# CLAUDE.md

This file guides Claude Code when working in `e2e` — the Playwright suite that proves the whole MyTuums stack over real HTTP: the real server, real Postgres, and (when `S3_*` is configured) the real Storage Bucket. It is its own workspace package (see `pnpm-workspace.yaml`) so it can depend on `@my-tuums/db` and `@my-tuums/api` without pulling Playwright into the root manifest.

## Layout

The config defines three projects over `testDir: ./tests`:

- `setup` — signs up the fixture accounts (alice/bob) once via the real auth endpoint and saves their cookies to `.auth/*.json`.
- `api` — transport-level contract (health, CORS, security headers, the oRPC error envelope, compression, rate limiting). No browser; `baseURL` is the server.
- `chromium` — the browser journeys, signed in as alice by default; specs override `storageState` per-file to go signed out or to use the `bobPage`/`signedOutPage` fixtures.

## Key files

- `playwright.config.ts` — the projects, both `webServer` entries with `stackEnv` (test DB, `BETTER_AUTH_URL`, blanked `RESEND_API_KEY`, `AUTH_RATE_LIMIT=false`, all-or-nothing `S3_*`), and the `E2E` constants (ports 3101/5273, storage-state paths) every other module imports.
- `global-setup.ts` — truncates every table once per run, and is the canonical example of the `DATABASE_URL` fix-up (see below).
- `support/users.ts` — `ALICE`/`BOB` fixture accounts, `uniqueUser()` for throwaway accounts, `dateOfBirthUnder15()`.
- `support/db.ts` — seeding helpers (`createUser`, `seedPosts`, `seedReply`, `seedFollow`, `seedLike`, `getUserId`, `passwordResetTokenFor`) plus `setUserRole` (direct row update — the admin plugin's endpoints are 404'd, so this is the only way a spec gets a moderator fixture), `truncateAll()` and the bucket purge.
- `support/fixtures.ts` — the extended `test` handle: `bobPage`, `signedOutPage`, and `db`.
- `support/post-card.ts` — structural post-card locators (`postCardWithText`, like/reply controls); there is a no-`data-testid` policy, so this is where the deepest-div heuristic lives.
- `tests/auth.setup.ts` — the `setup` project: signs up alice/bob over HTTP (through `E2E.webUrl`, so the session cookie is scoped to the origin the browser will use) and writes their storage state. Alice is also promoted to `moderator` here (via `setUserRole`, idempotent for `--project setup` re-runs) — she is the suite's moderator fixture.
- `tests/api/*.spec.ts` — transport-level specs; `tests/specs/*.spec.ts` — browser journeys. `moderation.spec.ts` walks report → queue → remove → appeal as alice (moderator) and bob, and deliberately stops at "appeal submitted": the `appealReview` reviewer-exclusion invariant means overturning needs a second moderator fixture, so uphold/overturn stay covered by `moderation.int.test.ts`.

## Load-bearing decisions — do not break

- **`workers: 1`.** Every spec shares one Postgres and one in-process server rate limiter; parallel workers would 429 one another and fight over fixtures. Consequence: the database is truncated exactly once (in `global-setup.ts`), so specs must seed unique content and never assume a clean database.
- **Storage state is cookies only.** `auth.setup.ts` captures it via an `APIRequestContext`, which has no page and therefore no localStorage. Any spec asserting "nothing stored" must use a fresh `browser.newContext` explicitly.
- **The `DATABASE_URL` fix-up.** `@my-tuums/db` reads `DATABASE_URL` at module scope, and the `e2e` script loads `../.env` (the dev database) into `process.env`. `global-setup.ts` and `support/db.ts` therefore re-derive the `_test` URL *before* a dynamic `import("@my-tuums/db")` — a static import would hoist above the fix-up and hit the dev database. `assertTestDatabase()` guards every destructive helper: the target database name must end in `_test`.
- **The `S3_*` group is all-or-nothing**, forwarded from the ambient env; upload specs skip themselves when it is absent. `truncateAll()` deletes uploaded objects by prefix — never point the suite at the production bucket (see `.env.example`).
- **`RESEND_API_KEY` is blanked** in `stackEnv`: fixture sign-ups must never fire live Resend calls (it once exhausted a real quota and raced the /welcome session wait). Reset/verification tokens are read from the DB instead (`passwordResetTokenFor`).
- **Locators are structural or accessibility-based** (`getByRole`, `getByLabel`, `getByTitle`) — `data-testid` is banned across the app.
- **The `setup` project's file must live under `tests/`**: `testMatch` only filters files the `testDir` scan already found.
- `@my-tuums/api` is a dependency (for the destructive-storage cleanup in `support/db.ts`); `@my-tuums/db` and `@my-tuums/auth` are devDependencies. Specs deliberately mirror `THREAD_ANCESTOR_MAX` rather than importing it — see the comment in `tests/specs/thread.spec.ts`.

## Commands

- `pnpm --filter @my-tuums/e2e e2e` (root alias `pnpm test:e2e`) — the suite. Needs a Postgres (docker or local) and, for the upload specs, the dev bucket's `S3_*` values in `.env`. CI runs it on push with the ci bucket.
- `pnpm --filter @my-tuums/e2e e2e:ui` — the Playwright UI runner; `e2e:report` — reopen the last HTML report.
- `pnpm --filter @my-tuums/e2e lint` / `typecheck` — ESLint and `tsc --noEmit` for this package alone.
