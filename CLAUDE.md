# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (10.12.1), orchestrated by **Turborepo**. Node >= 22.

```bash
pnpm install
pnpm docker:up            # Postgres on :5432 (+ the server image; `docker compose up -d postgres` for DB only)
pnpm dev                  # all dev servers: web on :5173, server on :3001
pnpm build | lint | typecheck | test
```

Scoping to one workspace uses pnpm filters:

```bash
pnpm --filter @my-tuums/web dev
pnpm --filter @my-tuums/server build
pnpm --filter @my-tuums/api test
```

### Tests

- `apps/web` — Vitest + jsdom + Testing Library. Single file / single test:
  `pnpm --filter @my-tuums/web test src/lib/format.test.ts`
  `pnpm --filter @my-tuums/web test -t "renders the composer"`
- `packages/api` — **integration** tests. They hit a real Postgres through `@my-tuums/db` and drive the real BetterAuth sign-up/session flow, so Postgres must be running and `.env` must exist (the script loads it via `dotenv -e ../../.env`). Same filtering flags apply.

### Database

All `db:*` scripts live in `packages/db` and load the root `.env`.

```bash
pnpm --filter @my-tuums/db db:push          # sync schema to DB (dev)
pnpm --filter @my-tuums/db db:generate      # emit a migration into packages/db/drizzle
pnpm --filter @my-tuums/db db:migrate
pnpm --filter @my-tuums/db db:studio
pnpm --filter @my-tuums/db db:generate:auth # regenerate the BetterAuth schema (see below)
```

`DATABASE_URL` in `.env` must use `localhost` — it is for host-side processes. The `server` container gets its own value pointing at the `postgres` service name, set in `docker-compose.yml`.

## Architecture

Monorepo: `apps/{web,server}` + `packages/{api,auth,db,tsconfig}`. The internal packages are **source-only** — their `exports` point directly at `.ts` files, nothing is pre-compiled.

### The request path

```
React (TanStack Query)  →  oRPC client  →  Vite proxy (dev)  →  node:http server :3001
                                                                 ├─ GET  /health      → SELECT 1
                                                                 ├─ /api/auth/*       → BetterAuth
                                                                 └─ /rpc/*            → appRouter
```

- `apps/server/src/index.ts` is a hand-rolled `node:http` server, not a framework. It routes those three prefixes, owns CORS (via the oRPC `CORSPlugin`), and implements graceful shutdown (drain HTTP → drain the Postgres pool → exit) on SIGTERM/SIGINT/`unhandledRejection`/`uncaughtException`.
- `packages/api` owns the router. `appRouter` (`router.ts`) composes `postRouter` and `userRouter`. `createContext` (`context.ts`) resolves the BetterAuth session from request headers and carries `{ db, session, clientIp }`.
- One file per router namespace: `posts.ts` → `postRouter`, `users.ts` → `userRouter` (which owns the whole follow graph, since `byUsername` and the follower lists share the same derived-count SQL).
- `apps/web/src/lib/orpc.ts` builds the typed client from `type AppRouter` — **the API contract is the TypeScript type, there is no codegen**. Adding a procedure makes it available on the client immediately; changing an input/output shape surfaces as a type error in the web app.

### Procedures and middleware

`packages/api/src/procedures.ts` exports the three building blocks: `publicProcedure`, `protectedProcedure` (throws `UNAUTHORIZED` unless `context.session.user` exists, and narrows `context.user`), and `rateLimit(policy)`. Every procedure should carry a rate limit from `RATE_LIMITS` in `rate-limit.ts` (`read` / `like` / `follow` / `write`). Tiers are mostly about cost, but `name` also namespaces the counter — `follow` is separate from `like` despite costing the same so that mass-follow spam can't lock someone out of liking. The limiter is an in-process fixed-window map — limits reset on deploy and multiply by replica count; that trade-off is documented at the top of `rate-limit.ts`.

Rate-limit identity is `user:<id>` when signed in, else `ip:<clientIp>`. `clientIp` only honours `X-Forwarded-For` when `TRUST_PROXY=true`, because the header is client-supplied and trusting it on a direct-to-internet server removes the limit rather than enforcing it.

### Auth

BetterAuth (`packages/auth`) with email/password plus the `username` plugin (3–20 chars, `[a-zA-Z0-9_-]`). The plugin stores a normalised lowercase `username` alongside the user-typed `displayUsername` — look ups must match on the normalised column (see `users.ts`), and `handleOf()` in `apps/web/src/lib/user.ts` is the shared rule for which one appears in a URL. Display code may prefer `displayUsername`, but anything feeding a route param must use the normalised handle or the `byUsername` cache fragments across casings.

`user.byUsername` returns an explicit column allowlist specifically so a public profile never leaks `email`; the follower lists spread the same const. Widen it deliberately — there is a test guarding it.

BetterAuth serves `/api/auth/*` itself and has its own database-backed rate limiting, independent of the `/rpc` limiter above.

### Database

Drizzle + postgres.js. Schema is split deliberately:

- `packages/db/src/schema/auth.ts` is **generated** — `db:generate:auth` runs `@better-auth/cli generate` and then `scripts/patch-auth-schema.mjs`, which rewrites every `timestamp(...)` to `timestamptz`. Never hand-edit it; the next regeneration discards the edit. Change the patch script instead.
- `packages/db/src/schema/app.ts` holds app-owned tables (`post`, `post_like`, `follow`) so regeneration can't clobber them.

Conventions worth preserving: table names are singular; every timestamp column is `withTimezone: true` (a bare `timestamp` makes Postgres write server-local time while Drizzle reads it back as UTC, shifting every post); app timestamps are also `precision: 3` (see below); `post_like` and `follow` are keyed by a composite primary key that *is* the uniqueness rule, which is what lets `like`/`unlike` and `follow`/`unfollow` be separate idempotent procedures instead of race-prone toggles. `follow` additionally carries a `follow_not_self` CHECK constraint — the handler's `BAD_REQUEST` is a courtesy on top of it, not the invariant.

Feeds and follower lists are **keyset-paginated** with a base64url-encoded opaque cursor built by `createCursorCodec` in `packages/api/src/cursor.ts`. The codec is parameterised on the tie-breaker's schema because the type differs: posts break ties on a uuid `post.id`, while a `follow` row has no id of its own and breaks ties on the listed user's text `user.id`. Indexes in `app.ts` are ordered to match each cursor's `ORDER BY` — keep those in sync.

**`precision: 3` on the app tables' timestamps is load-bearing, not cosmetic.** Postgres defaults to microseconds; a JS `Date` — which is what Drizzle reads into, and all a JSON cursor can carry — holds only milliseconds. At the default precision a cursor built from `.340448` encodes `.340`, and the row-value comparison then excludes the stored row *and every other row in that millisecond*: a silent skip. Storing at the precision the consumer can represent makes the cursor round-trip exact. Any new keyset-paginated table needs the same.

### Web app

Vite + React 19 + TanStack Router (file-based) + TanStack Query + Tailwind v4 + shadcn (`style: base-maia`, components in `src/components/ui`) + Jotai + Paraglide i18n.

- Routes live in `apps/web/src/routes`. Profile URLs use the literal-prefix syntax: `@{$username}.tsx` serves `/@alexmercer`. That route is a **layout** — it owns the profile header, follow button, counts and tabs, then renders `<Outlet />`; the tab bodies are `@{$username}.index.tsx` (posts), `.followers.tsx` and `.following.tsx`. Adding a nested route without an `index` sibling makes the parent URL render a header with an empty body rather than a 404.
- **Generated, git-ignored, never edit:** `src/routeTree.gen.ts` and `src/paraglide/**`. They are produced by Vite plugins on `dev`/`build`. **A new route file does not exist to TypeScript until the tree is regenerated**, so run `dev` or `build` once before expecting `typecheck` to resolve a new `to=` target.
- Route tests are co-located and excluded from route generation by `routeFileIgnorePattern: "\\.test\\."` in `vite.config.ts`.
- Search params are used on `/` only (`validateSearch` for `?feed=`), hand-written rather than schema-validated because `zod` is deliberately not a dependency of `apps/web`.
- `Button` with `nativeButton={false} render={<Link/>}` is the app-wide idiom for link-buttons. Note it reports `role="button"`, not `role="link"` — Base UI applies button semantics to whatever it renders — so query it as a button in tests while still asserting on `href`.
- `vitest.config.ts` deliberately does *not* merge `vite.config.ts` — a test run must not re-run the route-tree and Paraglide generators. `globals: false`, so Testing Library cleanup is wired explicitly in `src/test/setup.ts`.
- Dev proxies `/rpc` and `/api/auth` to `localhost:3001`; the oRPC link resolves its URL lazily against `window.location.origin` so the module stays importable outside a browser.

### Import rules that bite

- Internal packages are consumed as raw TS with **ESM `.js` specifiers** (`./router.js`, `@my-tuums/db/schema`). Keep the `.js` extension on relative imports inside `packages/*` and `apps/server`.
- Import shared constants from **`@my-tuums/api/constants`**, never from the package root, in web code. The root pulls in `./router.js` → `@my-tuums/db`, whose module-level `DATABASE_URL` check throws in the browser.
- Because those packages ship `.ts`, the server bundle inlines them: `apps/server/tsup.config.ts` sets `noExternal: [/^@my-tuums\//]`. Node's type-stripping does not rewrite `.js` specifiers, so an unbundled server crashes at runtime.

### Lint

Root flat ESLint config with `recommendedTypeChecked` via `projectService`. `no-floating-promises`, `no-misused-promises`, and `require-await` are errors — that's the point of typed linting here (a real server crash came from a misused promise). In practice this means `void`-ing deliberate fire-and-forget calls, e.g. `onClick={() => void feed.refetch()}` and the sync `createServer` callback. Files outside any tsconfig `include` must be listed in `allowDefaultProject`.
