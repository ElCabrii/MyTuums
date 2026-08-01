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

- Routes live in `apps/web/src/routes`. Profile URLs use the literal-prefix syntax: `@{$username}.tsx` serves `/@alexmercer`. That route is a **layout** — it owns the profile header, follow button and counts, then renders `<Outlet />`; the body is `@{$username}.index.tsx` (the person's posts). The follower and following lists are *not* routes: the counts in the header are dialog triggers (`follow-list-dialog.tsx`), which mount `user-list.tsx` only while open. Adding a nested route without an `index` sibling makes the parent URL render a header with an empty body rather than a 404.
- **Generated, git-ignored, never edit:** `src/routeTree.gen.ts` and `src/paraglide/**`. They are produced by Vite plugins on `dev`/`build`. **A new route file does not exist to TypeScript until the tree is regenerated**, so run `dev` or `build` once before expecting `typecheck` to resolve a new `to=` target.
- Route tests are co-located and excluded from route generation by `routeFileIgnorePattern: "\\.test\\."` in `vite.config.ts`.
- No route uses search params. The home feed switch is the one piece of view state that could have been one, and deliberately isn't: it lives in `feedScopeAtom` (`src/lib/feed-scope.ts`), a Jotai `atomWithStorage`, so the choice persists across visits and `/` stays `/` — at the cost of a feed view nobody can link to. Reads sanitise the stored value (localStorage is user-editable), and `getOnInit: true` is required so the first render already has it, or the page mounts the global feed and immediately refetches.
- `Button` with `nativeButton={false} render={<Link/>}` is the app-wide idiom for link-buttons. Note it reports `role="button"`, not `role="link"` — Base UI applies button semantics to whatever it renders — so query it as a button in tests while still asserting on `href`.
- `vitest.config.ts` deliberately does *not* merge `vite.config.ts` — a test run must not re-run the route-tree and Paraglide generators. `globals: false`, so Testing Library cleanup is wired explicitly in `src/test/setup.ts`, which also shims `matchMedia` (jsdom has none) and `localStorage`, and clears storage between tests so persisted atoms don't leak across them.
- **The component test suites were deleted during the Jotai migration and are being redesigned from scratch**, not ported — the 59 originals module-mocked `@/lib/auth-client` to control session state, which the session atoms make inert. New suites should seed a `createStore()` and wrap in `<Provider store>` rather than mocking that module. Current coverage is the pure layers: cache helpers, atoms, validation, and `lib/format` / `lib/user`. The deleted suites remain in history at `95cff70^` if a specific assertion is worth revisiting.
- Dev proxies `/rpc` and `/api/auth` to `localhost:3001`; the oRPC link resolves its URL lazily against `window.location.origin` so the module stays importable outside a browser.

### State lives in atoms

Client state is Jotai, in `apps/web/src/atoms/*`. Server state is still TanStack Query, but reached through `jotai-tanstack-query` so queries compose into the atom graph. The pattern to copy is `atoms/profile.ts`; `atoms/theme.ts` is the reference for a persisted preference with a live external subscription.

**Reach for an atom before `useState`.** There is no `useState` left in this app, and new code should not add one back without a reason it can state. The default is an atom in `atoms/*`, because that is what lets a value be *derived* rather than recomputed: `homeFeedScopeAtom` folds the session-pending guard and the signed-out override that used to sit inline in `home-page.tsx`, and `followListDialogAtom` deleted an entire `useEffect` by holding the open dialog's *identity* instead of a per-instance boolean. State that stays local is state the next component has to re-derive by hand, which is how `header.tsx` ended up with its own subtly wrong copy of `initialsOf`.

The same goes for `useEffect`. Two remain, both deliberate: the redirect in `hooks/use-redirect-when-signed-in.ts` (it needs the router's `navigate`, and an atom importing the router would cycle through `main.tsx`) and the form reset-on-unmount in `login.tsx`/`register.tsx`. An effect that *synchronises* one piece of state to another is almost always a derived atom instead. External subscriptions belong in `onMount` (`systemThemeAtom`, `sessionAtom`); reactions to atom changes belong in `atomEffect` (`themeClassEffect`).

Component-local `useState` is still right for genuinely ephemeral, single-consumer UI state — but note that even the auth form fields, passwords included, are atoms here (`atoms/auth-form.ts`), bounded by a reset on unmount rather than by component lifetime.

- **`src/lib/store.ts` hydrates `queryClientAtom` at module scope, and must stay that way.** `queryClientAtom` defaults to its *own* `new QueryClient()`. `useHydrateAtoms` only applies on the first render of the component calling it, so any earlier read — a router loader, a `store.get()`, a test importing the atom — locks in that default and Jotai will not re-initialise it. Two clients means two `MutationCache`s, and `MutationCache.#scopes` is a private instance field, so mutation `scope` silently stops serialising: no error, no type failure, just two mutations that must run in order running concurrently. Verified both ways with a scratch script during the migration.
- **`atomFamily` comes from `jotai-family`, not `jotai/utils`** — the latter carries an explicit `@deprecated` and goes away in Jotai v3.
- **Family keys are primitive strings, always.** An object param forces an `areEqual` comparator, and passing one switches the family from a `Map` lookup to a linear scan over every param it has ever created, on every read. Where a family needs multiple params it encodes them (`atoms/post-feed.ts`, `atoms/user-list.ts`) and splits on the *first* delimiter so the round trip stays total.
- **No family uses `setShouldRemove`.** It is evaluated lazily at read time and cannot know whether an atom is mounted, so it can fire between two components' reads of the same param and hand them different atoms — splitting the observer that the family exists to share, and discarding an in-progress "Load more". Cleanup happens in `signOutAtom` instead, the one moment nothing is mounted.
- **Query input shapes are load-bearing.** oRPC embeds the whole input object in the query key, and `lib/post-cache.ts` / `lib/follow-cache.ts` sweep `orpc.post.list.key()` and the follower/following prefixes to patch optimistically. The conditional spreads (`...(authorId ? { authorId } : {})`, `...(scope === "following" ? { feed: scope } : {})`) are not tidiness — always passing `feed: "global"` forks every cache entry and the sweeps silently stop matching. Changes here want a `toEqual` check on `.queryKey` against the old shape.
- **Don't scope atoms with a nested `<Provider>`.** Jotai's `Provider` creates a fully *separate* store for its subtree, not a scoped slice — reads inside it (including `sessionAtom`) resolve against an empty store. The auth forms bound their lifetime with `atomWithReset` plus a reset returned as an effect cleanup (`atoms/auth-form.ts`).
- **Optimistic-mutation rollback goes on a mutation-level `onError` fed by `onMutate` context — never on a per-call `mutate(vars, { onError })`.** query-core stores per-call callbacks on the *observer* and fires them only when `hasListeners()` is true (`mutationObserver.ts:164`), and `atomWithMutation` subscribes its observer only in the result atom's `onMount`. The toggle actions in `atoms/like.ts` and `atoms/follow.ts` are write-only atoms read with `useSetAtom`, so nothing ever mounts them and a per-call `onError` would silently never run — a failed like would stick on screen forever. Mutation-level callbacks land on `mutation.options` and fire regardless. Verified empirically: fired from an unmounted write-only path, mutation-level `onError` runs, each queued mutation gets its own `onMutate` context, and the shared scope still serialises the pair.
- **`onMutate` is not delayed by a scoped queue.** It is awaited at `mutation.ts:222`; the queue gate is `retryer.start()` one line later. So the optimistic patch still lands on click, not a round trip later — which is what makes the point above viable. Keep `onMutate` synchronous (don't `await` the `cancelQueries`) so cancel + snapshot + patch stay one atomic block.
- **Read per-click state at callback time, not through the options factory's `get`.** `get(intentFamily(id))` inside an `atomWithMutation` factory would make intent a dependency and rebuild the mutation options on every click. `atoms/like.ts` and `atoms/follow.ts` read it off the module-scope `store` inside the callback instead. Values that genuinely should rebuild the options — `viewerIdAtom` in `atoms/follow.ts` — do go through the factory's `get`.
- **Mutation `scope.id` carries the entity id only.** `follow:${userId}`, `post-like:${postId}` — never the viewer. Viewer identity in the scope would fork the serialisation queue on sign-in, which is the exact race the scope exists to prevent.

### Import rules that bite

- Internal packages are consumed as raw TS with **ESM `.js` specifiers** (`./router.js`, `@my-tuums/db/schema`). Keep the `.js` extension on relative imports inside `packages/*` and `apps/server`.
- Import shared constants from **`@my-tuums/api/constants`**, never from the package root, in web code. The root pulls in `./router.js` → `@my-tuums/db`, whose module-level `DATABASE_URL` check throws in the browser.
- Because those packages ship `.ts`, the server bundle inlines them: `apps/server/tsup.config.ts` sets `noExternal: [/^@my-tuums\//]`. Node's type-stripping does not rewrite `.js` specifiers, so an unbundled server crashes at runtime.

### Lint

Root flat ESLint config with `recommendedTypeChecked` via `projectService`. `no-floating-promises`, `no-misused-promises`, and `require-await` are errors — that's the point of typed linting here (a real server crash came from a misused promise). In practice this means `void`-ing deliberate fire-and-forget calls, e.g. `onClick={() => void feed.refetch()}` and the sync `createServer` callback. Files outside any tsconfig `include` must be listed in `allowDefaultProject`.
