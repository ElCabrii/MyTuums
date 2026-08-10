# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MyTuums — a Twitter-style social app (posts, likes, follows, profiles, auth). pnpm 10 + Turborepo monorepo on Node 22. TypeScript strict everywhere, React 19 + Vite web app, Postgres + Drizzle, hosted on Railway.

## Hard rules (user-set — do not override)

- **UI: shadcn only.** Use ShadCN's current preset as configured in `apps/web/components.json` (style `base-maia`, zinc, lucide icons). Never bring in another component library or hand-roll styled primitives. Add components with the shadcn CLI: `pnpm --filter @my-tuums/web exec shadcn add <component>`.
- **State: Jotai atoms, not hooks.** Client state lives in `apps/web/src/atoms/` as Jotai atoms (plain Jotai, `atomFamily`, `jotai-effect`, and `atomWithQuery`/`atomWithInfiniteQuery` from `jotai-tanstack-query` for server state). Do not reach for `useState`/`useEffect` unless there is no atom-shaped way to do it.
- **Strict TS and ESLint configs are deliberate.** Strict tsconfigs, typed linting, and the three enforced rules (`no-floating-promises`, `no-misused-promises`, `require-await`) exist to catch real bugs (see `eslint.config.mjs`). Fix the code — never weaken the configs to make a check pass.
- **E2E is slow — don't run it casually.** The Playwright suite (browser install, full auth flows, its own servers) takes a long time. Prefer `pnpm test:unit` / `pnpm test:integration` for most changes; CI always runs e2e on push anyway.

## Hosting: Railway

- Hosted on Railway, **always in a European region**. The Railway MCP plugin is available in this session — use it for deploys, logs, variables, etc.
- Three environments: `production` (the app: server, Postgres, and its own bucket), and `dev` + `ci` (**buckets only** — Postgres and the monorepo run locally; Railway's dev/ci environments never run the app).
- Local `.env` S3 values point at the **dev environment's bucket**; CI uses the ci bucket. The E2E suite deletes objects by prefix during cleanup, so never point any non-production tooling at the production bucket.
- Deploys build `apps/server/Dockerfile` (multi-stage: tsup bundle, Vite web build, migrations). Railway must pass `VITE_SOCIAL_PROVIDERS` and `VITE_GOOGLE_CLIENT_ID` as Docker build ARGs or the OAuth buttons silently don't ship (CI asserts this). Migrations run as a pre-deploy step (`apps/server/src/migrate.ts` + SQL in `packages/db/drizzle`).

## Commands

Copy `.env.example` → `.env` first — it is the single source of env for every host-side process (all scripts load it via `dotenv -e ../../.env`; Vite reads it via `envDir`).

- `pnpm docker:up` — full stack via docker-compose: Postgres on :5432 + the server image on :3001. The stack applies pending migrations first (a one-shot `migrate` service running the same runner Railway uses pre-deploy), so a fresh clone's first boot works. Host-side processes use `localhost` in `DATABASE_URL`; the compose `server` service uses the `postgres` hostname.
- `pnpm dev` — host-side dev: API on :3001, Vite web on :5173 (proxying `/rpc`, `/api/auth`, `/media` to the API). **Port conflict note:** `pnpm dev` and `docker compose up` both occupy 3001/5173 — run one or the other, not both.
- `pnpm build` / `pnpm lint` / `pnpm typecheck` — turbo across the workspace.
- `pnpm test:unit` — vitest unit suites (pure logic; must pass with no DB reachable — that's what keeps the unit/integration split honest).
- `pnpm db:test:setup && pnpm test:integration` — API integration suites against real Postgres (run `pnpm docker:up` first, or use the local `DATABASE_URL`).
- `pnpm test:e2e` — Playwright (slow, see above); `pnpm test:e2e:ui` for the UI runner. Uses its own ports (API :3101, web :5273) so it runs beside a live dev stack.
- `pnpm db:generate` — new migration from schema changes; `pnpm db:push` — apply it; `pnpm db:promote` — grant a moderator/staff/admin role for the moderation bootstrap (root aliases into `@my-tuums/db`). The rest of the Drizzle toolbox is package-level: `pnpm --filter @my-tuums/db db:migrate` (apply), `db:studio` (browse), `db:generate:auth` (regenerate `src/schema/auth.ts` via the BetterAuth CLI + `scripts/patch-auth-schema.mjs`), and `db:check` (the schema-drift check CI runs).

Single test:

- `pnpm --filter @my-tuums/api exec vitest run src/posts.int.test.ts` (same pattern for web: `pnpm --filter @my-tuums/web exec vitest run src/atoms/foo.test.ts` — if `src/paraglide` doesn't exist yet, the web package's `test` script compiles it first).
- E2E: `pnpm --filter @my-tuums/e2e e2e -- tests/specs/theme.spec.ts`.

## Per-package documentation

Each package — and the CI directory — carries its own `AGENTS.md`: the authoritative deep-dive for that subtree (key-files map, load-bearing decisions, package commands). The Architecture section below is the summary; the per-package files are the detail.

- `apps/server/AGENTS.md` — the HTTP server: routing tree, env validation, graceful shutdown.
- `apps/web/AGENTS.md` — the SPA: atoms/lib/hooks, routes & components, load-bearing client decisions.
- `packages/api/AGENTS.md` — the oRPC contract: procedures, rate limiting, cursors, S3 storage.
- `packages/auth/AGENTS.md` — the better-auth composition: pinned settings, providers, email, testing.
- `packages/db/AGENTS.md` — schema, TLS rule, migrations, test helpers.
- `e2e/AGENTS.md` — the Playwright suite: projects, fixtures, stack env, invariants.
- `.github/AGENTS.md` — CI/CD pipeline.

## Architecture

### One origin is a requirement, not a preference

In production the API serves the built SPA (`WEB_DIST` set by the Dockerfile), because `apps/web/src/lib/orpc.ts` resolves `/rpc` against `window.location.origin` and uploaded images are stored as relative `/media/<key>` paths. In dev, Vite proxies `/rpc`, `/api/auth`, and `/media` to :3001; the browser follows the `/media` 302 to a presigned bucket URL itself.

### apps/server — the HTTP server

- `src/env.ts`: zod-validated env; a _partial_ OAuth pair or S3 group refuses to boot (`superRefine`). `parseEnv` throws but never exits — only the real entrypoint `src/index.ts` turns a bad env into `process.exit(1)`. One caveat: `@my-tuums/db` evaluates `DATABASE_URL` at module scope and throws when it is unset (packages/db/src/index.ts), which runs before `parseEnv` ever does — so that single variable is reported by the module-scope throw rather than by `parseEnv`'s unified report.
- `src/request-handler.ts`: the routing tree (health → `/api/auth` (better-auth) → `/rpc` (oRPC) → `/media` (session required, checked before the key is parsed) → page gate → static SPA), unit-tested with stand-ins; `src/index.ts` wires the real dependencies, plus deliberate graceful shutdown that drains the DB pool. The page gate enforces the same sign-in requirement as the client's `useRequireSignedIn`, sharing its allowlist (`SIGNED_OUT_PATHS` in `@my-tuums/api/constants`) so the two can't drift into a redirect loop. Between `/media` and the page gate, no anonymous request ever reaches user content (issue #36 closed every procedure; a leaked media key is the one thing this doesn't retroactively fix — see the load-bearing note in `apps/server/AGENTS.md`). Observability: every request gets an `x-request-id` (generated at the top of the routing tree — the header is the handoff), one JSON access-log line per finished request (`src/observability.ts`, pathname only — never the raw URL), and Sentry behind `SENTRY_DSN` when set (`src/sentry.ts`); the id rides the oRPC `Context.requestId` so API-layer errors tag the same id.
- Bundled with tsup: source-only workspace packages (`@my-tuums/{api,auth,db}`) get inlined; real npm deps stay external.

### packages/api — the oRPC contract

- `src/router.ts` defines `appRouter` (`me`, `post`, `user`, `search`, `moderation`); `posts.ts`/`users.ts`/`search.ts`/`moderation.ts` hold the procedures, all built from `protectedProcedure` in `procedures.ts` over drizzle queries — there is no anonymous surface (issue #36).
- `Context` (`{ db, session, rateLimiter, storage }`) threads the rate limiter and S3 storage through every procedure — never module globals — so tests can substitute fakes.
- `rateLimit(policy)` middleware keys on `user:<id>` — every caller is a signed-in user, so there is no anonymous fallback to key on.
- Feeds are keyset-paginated on `(created_at, id)` (`cursor.ts`); like/reply counts are derived subqueries, not denormalized columns.
- `storage.ts`/`media.ts`: S3 presigned-upload abstraction; `dimensions.ts` parses WebP dimensions.
- Test split by filename: `*.test.ts` (unit, no I/O) vs `*.int.test.ts` (real Postgres + sessions; shared harness in `src/testing/harness.ts`, `fileParallelism: false`).

### packages/auth — better-auth

- Plugins: username, twoFactor, passkey, oneTap, lastLoginMethod, haveIBeenPwned, i18n. `trustedOrigins: [webOrigin]`.
- Social providers register only when both halves of a credential pair exist (`social.ts`); email goes through Resend with a console fallback in dev and a loud failure in prod.
- The `i18n` plugin reads the `PARAGLIDE_LOCALE` cookie — the same cookie the web app sets — so one locale governs both client copy and server error messages.
- Better-auth's own rate limiting is stored in Postgres; the E2E stack sets `AUTH_RATE_LIMIT=false` because one IP drives the whole suite.
- Some settings are deliberately pinned and load-bearing (see the comments in `src/index.ts`): `requireEmailVerification: false`, `revokeSessionsOnPasswordReset: true`, no session cookie cache, upload-only fields marked `input: false`.

### apps/web — the SPA

- TanStack Router with file routes in `src/routes/`. The route tree (`routeTree.gen.ts`) and Paraglide output (`src/paraglide/**`) are **generated and git-ignored** by the Vite plugins — build or dev must run before typecheck can resolve them (CI builds first, for this reason).
- One Jotai store (`src/lib/store.ts`) is hydrated with the single `QueryClient` at module scope (never `useHydrateAtoms`); every atom file wraps the `orpc` utils via `jotai-tanstack-query`, with `atomFamily` string keys for structural dedup (`atoms/post-feed.ts` is the house style).
- i18n: Paraglide messages live in `apps/web/messages/`, compiled to `src/paraglide`; edit messages and recompile — never hand-edit generated files.
- shadcn components in `src/components/ui/`; `@/` aliases to `src`.

### packages/db — drizzle + postgres.js

- Connection requires TLS for dotted hostnames but not loopback (`src/index.ts`); `closeDb`/`pingDb` serve shutdown and `/health`.
- Schema split: hand-written `src/schema/app.ts` + generated `src/schema/auth.ts`. Migrations live in `drizzle/` (committed; the Docker image ships them for the pre-deploy step).
- `src/testing.ts`: `resolveTestDatabaseUrl()` (derives `DATABASE_URL_TEST` by suffixing `_test`) and `assertTestDatabase()` — destructive helpers refuse to run against a database whose name doesn't end in `_test`.

### e2e — Playwright

- Projects: `setup` (signs up alice/bob once via HTTP, saves cookie state), `api` (transport-level: health, CORS, error envelope, rate limiting — no browser), `chromium` (browser specs, signed in as alice; `bobPage`/`signedOutPage` fixtures cover the rest).
- Single worker, `global-setup.ts` truncates the test database, and upload specs skip themselves when no S3 env (dev bucket) is present.

### CI (`.github/workflows/ci.yml`)

`check` (build → lint → typecheck; turbo cache persisted via actions/cache), `unit` (deliberately no Postgres), `integration` (Postgres service; `db:check` catches schema drift), `e2e` (Postgres + ci-bucket S3 secrets, 60-min cap), `docker` (builds the image, asserts the VITE_* ARGs landed in the bundle and the migration runner/SQL shipped, then BOOTS it with its real CMD against a Postgres service and probes /health, /login and the page gate). The production smoke check (`smoke.yml`) re-runs those probes against the live `mytuums.com` every 6 hours — the standing replacement for a post-deploy check, since CI never deploys.

## Env gotchas

- `S3_BUCKET` is the bucket's **globally unique** name (e.g. `mytuums-dev-media-xxxx`), not the display name. `S3_ENDPOINT` must be the **public** endpoint from the Railway Credentials tab (`https://t3.storageapi.dev` as of writing) — `storage.railway.internal` only resolves inside Railway's network.
- `VITE_SOCIAL_PROVIDERS` must agree with the providers that have credentials server-side — the browser cannot see server env, so the two lists are kept in agreement by hand.
- `BETTER_AUTH_SECRET` must be ≥ 32 chars of real randomness.
- `DATABASE_URL_TEST` is optional; when unset it is derived from `DATABASE_URL` with a `_test` suffix.
