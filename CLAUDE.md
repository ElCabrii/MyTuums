# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (10.12.1), orchestrated by **Turborepo**. Node >= 22.

```bash
pnpm install
pnpm docker:up            # Postgres on :5432 (+ the server image; `docker compose up -d postgres` for DB only)
pnpm dev                  # all dev servers: web on :5173, server on :3001
pnpm build | lint | typecheck
```

**Do not run `pnpm docker:up` and `pnpm dev` at the same time.** Both put a
server on :3001 — the container binds `0.0.0.0`/`[::]` and the host process
binds `127.0.0.1` — so neither fails to start and everything *looks* fine.
What actually happens is that requests split between the two: the web app's
Vite proxy resolves `localhost` to `127.0.0.1` and reaches the host process,
while the browser following an OAuth redirect can resolve to `::1` and reach
the container. The container is also whatever image was last built, so it can
be running older code entirely.

The symptom is an OAuth sign-in dying at
`http://localhost:3001/login?error=state_mismatch` with "Not found": one
server wrote the state, the other read the callback and never saw it, then
redirected to its own origin — which serves no HTML. Nothing in that error
points at the port conflict. Use `docker compose up -d postgres` for the
database alone alongside `pnpm dev`; the full `docker:up` is for running the
stack *instead of* the dev servers.

Scoping to one workspace uses pnpm filters:

```bash
pnpm --filter @my-tuums/web dev
pnpm --filter @my-tuums/server build
pnpm --filter @my-tuums/db db:push
```

### Tests

Three layers, each runnable on its own. Vitest for unit and integration, Playwright for E2E.

```bash
pnpm db:test:setup   # once: creates and migrates mytuums_test
pnpm test            # everything Vitest runs (unit + integration)
pnpm test:unit       # pure logic + jsdom. NO database required
pnpm test:integration # oRPC procedures against real Postgres + real BetterAuth
pnpm test:e2e        # Playwright, full stack in a browser
pnpm test:e2e:ui     # same, in Playwright's UI mode
```

`packages/api/src/auth.int.test.ts` covers the hardened auth surface — 2FA enrolment, backup-code single use, the breached-password check, French error translation — against the **production** `auth` instance, deliberately: a test-only instance with a smaller plugin list would assert a configuration nothing ships. Two things it had to solve are worth knowing before writing more of them. The `secret` in a TOTP URI is **base32-encoded** while `createOTP` takes the raw secret, so feeding it straight back produces codes that look right and never verify. And verifying a second factor **rotates the session cookie**, so headers captured before the call stop authenticating after it — hence the `CookieJar` in that file rather than a captured `set-cookie` string (`Headers.get("set-cookie")` also joins multiple cookies into one unparseable value; `getSetCookie()` is the only correct read).

**Unit and integration are split by filename, not by directory**: `*.test.ts` is the `unit` Vitest project, `*.int.test.ts` is `integration`. `packages/api/vitest.config.ts` declares both, and only the integration project gets a `DATABASE_URL` — so a unit test that quietly starts needing a database fails instead of passing by accident. Keep that property: **do not import `@my-tuums/db`, `@my-tuums/auth`, `context.ts`, `router.ts`, `posts.ts` or `users.ts` from a `*.test.ts`**, because they evaluate `DATABASE_URL` at module scope and throw.

**Everything database-backed runs against `mytuums_test`, never the dev database.** `DATABASE_URL_TEST` overrides it; unset, it is *derived* from `DATABASE_URL` by suffixing the database name with `_test`, so a fresh clone needs no extra variable. `assertTestDatabase()` in `@my-tuums/db/testing` guards every destructive helper and refuses to run unless the name ends in `_test` — `packages/db/src/index.ts` reads the URL once at module load and hands out a process-wide singleton, so by the time a helper holds a `db` there is nothing left to inspect but the environment that produced it.

`packages/api/src/rate-limit.ts` is a pure factory (`createRateLimiter`) with no singleton — the rate limiter lives on `Context.rateLimiter` instead, and `procedures.ts`'s `rateLimit()` middleware reads it from there. Production gets exactly one shared instance for the server's lifetime via `context.ts`'s `defaultRateLimiter`. Tests never see that instance at all: `testing/harness.ts` owns its own, and registers a `beforeEach` that swaps it for a fresh one before every test — automatically, for every file that imports the harness, with no boilerplate needed in the test files themselves. This is what makes exhausting a budget in one test (a thread deep enough to exercise `THREAD_ANCESTOR_MAX` alone exceeds the 15/min `write` budget) leave the next test's budget untouched. `contextFor(user, clientIp?, rateLimiter?)`'s third argument lets a test share one limiter across several calls on purpose — `procedures.int.test.ts` relies on this to test exhaustion itself. The integration project also sets `fileParallelism: false`: every file still shares one Postgres and one truncate helper, independent of rate limiting.

**`apps/web` tests need `src/paraglide/**` compiled first**, because `vitest.config.ts` deliberately omits the Paraglide and TanStack Router plugins (both rewrite `src/` on startup, underneath a running test process). The `test` script runs `pnpm paraglide` first, so this is only a trap if you invoke `vitest` directly. `src/test/setup.ts` shims `localStorage` (Node 22's undefined global shadows jsdom's working one) and `matchMedia` (jsdom has none, and `atoms/theme.ts` subscribes through it).

**Component tests use a top-level `<Provider store={freshStore}>` per test.** That is not a contradiction of "don't scope atoms with a nested `<Provider>`" below — that rule is about nesting one *inside the app's* tree, where reads resolve against an empty store. A per-test store is what stops optimistic like/follow state leaking between tests. `src/test/render.tsx` builds it, hydrates `queryClientAtom` the way `lib/store.ts` does, and mounts a **stub** memory router rather than depending on the generated `routeTree.gen.ts`. Its `vi.mock("@/lib/auth-client")` also stubs the whole `authClient` surface — `signIn.*`, `twoFactor.*`, `passkey.*`, `updateUser`, `listAccounts`. It used to be `{}`, which was fine while only `atoms/session.ts` reached this module; now that the auth atoms call those namespaces directly, an empty object turns any component rendering one into "cannot read properties of undefined" at call time. A new `authClient` namespace needs a stub here too.

**E2E runs on its own ports — server :3101, web :5273** — so `pnpm test:e2e` works beside a live `pnpm dev` or the docker container instead of fighting them for :3001. That is what `RPC_TARGET` in `apps/web/vite.config.ts` exists for; it defaults to :3001 and dev behaviour is unchanged.

**There are no `data-testid` attributes anywhere, on purpose.** E2E and component selectors come from roles, accessible names, labels and placeholders — `role="alert"` on the error banners, `aria-pressed` + `aria-label` on the like button, `aria-label` on the reply link, `htmlFor`/`id` pairs on the auth fields. Adding testids would be a step backwards from affordances that already have to be correct for screen readers.

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
- `packages/api` owns the router. `appRouter` (`router.ts`) composes `postRouter` and `userRouter` plus a single top-level `me`. `createContext` (`context.ts`) resolves the BetterAuth session from request headers and carries `{ db, session, clientIp }`.
- One file per router namespace: `posts.ts` → `postRouter`, `users.ts` → `userRouter` (which owns the whole follow graph, since `byUsername` and the follower lists share the same derived-count SQL).
- `apps/web/src/lib/orpc.ts` builds the typed client from `type AppRouter` — **the API contract is the TypeScript type, there is no codegen**. Adding a procedure makes it available on the client immediately; changing an input/output shape surfaces as a type error in the web app.

### Procedures and middleware

`packages/api/src/procedures.ts` exports the three building blocks: `publicProcedure`, `protectedProcedure` (throws `UNAUTHORIZED` unless `context.session.user` exists, and narrows `context.user`), and `rateLimit(policy)`. Every procedure should carry a rate limit from `RATE_LIMITS` in `rate-limit.ts` (`read` / `like` / `follow` / `write`). Tiers are mostly about cost, but `name` also namespaces the counter — `follow` is separate from `like` despite costing the same so that mass-follow spam can't lock someone out of liking. The limiter is an in-process fixed-window map — limits reset on deploy and multiply by replica count; that trade-off is documented at the top of `rate-limit.ts`.

Rate-limit identity is `user:<id>` when signed in, else `ip:<clientIp>`. `clientIp` only honours `X-Forwarded-For` when `TRUST_PROXY=true`, because the header is client-supplied and trusting it on a direct-to-internet server removes the limit rather than enforcing it.

### Auth

BetterAuth (`packages/auth`) with email/password plus the `username` plugin (3–20 chars, `[a-zA-Z0-9_-]`). The plugin stores a normalised lowercase `username` alongside the user-typed `displayUsername` — look ups must match on the normalised column (see `users.ts`), and `handleOf()` in `apps/web/src/lib/user.ts` is the shared rule for which one appears in a URL. Display code may prefer `displayUsername`, but anything feeding a route param must use the normalised handle or the `byUsername` cache fragments across casings.

`user.byUsername` returns an explicit column allowlist specifically so a public profile never leaks `email`; the follower lists spread the same const. Widen it deliberately — and note two of the columns the hardening pass added must stay out for a sharper reason than privacy: `twoFactorEnabled` tells an attacker which accounts a stolen password alone would open, and `lastLoginMethod` tells them which provider to phish.

BetterAuth serves `/api/auth/*` itself and has its own database-backed rate limiting, independent of the `/rpc` limiter above.

**`packages/auth` is one instance composed from several files**, not one file: `env.ts` (every variable it reads, none of them required), `social.ts` (`socialProviders` + `trustedProviders`), `email.ts` (the single `sendEmail` seam), `i18n.ts` (French error strings), `index.ts` (composition), `testing.ts` (a *separate* instance, below). Plugins registered: `username`, `twoFactor`, `passkey`, `oneTap`, `lastLoginMethod`, `haveIBeenPwned`, `i18n`.

Things here that look like details and are not:

- **Every OAuth provider is optional, and a *half*-configured one is a boot error.** `oauthCredentials()` registers a provider only when both its id and secret are present, so CI and a fresh clone work with none set. `apps/server/src/env.ts` then refuses to start on an id without a secret — otherwise the provider is silently absent, its button never renders, and nothing says why.
- **`account.accountLinking.trustedProviders` is a security control, not a convenience.** Auto-linking a social account to an existing user on an email match is account takeover when the provider doesn't verify the address. Google and Discord expose a trustworthy signal; **Twitch is deliberately excluded** and must be linked explicitly from `/settings/account`.
- **OAuth sign-up leaves `user.username` NULL.** The `username` plugin does not populate it and has no auto-generation option, yet every profile URL, follow list and `user.byUsername` lookup keys on that column. This is not worked around server-side — the web app treats it as an incomplete sign-up and gates it at `/welcome` (see `needsHandleAtom`). Nothing else in the app should learn to tolerate a handle-less session.
- **Rate limiting is on in every environment**, not BetterAuth's production-only default, with tighter `customRules` on the endpoints where a low ceiling *is* the control (credential guessing) or where the server would otherwise send mail on request. `AUTH_RATE_LIMIT=false` is the one escape hatch, used by the Playwright suite because it drives every sign-in from one IP.
- **Email is a seam, not a dependency.** `email.ts` uses Resend when `RESEND_API_KEY` is set, logs to the console in development, and *throws* in production — dropping a password-reset link silently is worse than failing loudly. TOTP two-factor, sign-up and sign-in all work with no email configured at all; email OTP, address verification and password reset do not.
- **`emailVerification` sends but `requireEmailVerification` is off.** Turning it on would lock out every account that predates verification existing.
- The BetterAuth **i18n plugin reads `PARAGLIDE_LOCALE`** — the same cookie the web app already sets. That is what makes server errors arrive translated, which in turn is why `lib/auth-error-message.ts`'s pass-through of unrecognised errors needed no change.

**`packages/auth/src/testing.ts` exports a second, test-only instance** (`@my-tuums/auth/testing`) carrying `testUtils()`. Those helpers mint sessions for arbitrary user ids and write user rows directly — exactly what auth exists to withhold — so they must never reach the production instance. It is a separate instance rather than a conditional spread because a non-static plugin array stops `ctx.test` being inferred at all. Both share the secret and the `session` table, so a fixture session resolves through the real request path.

### Database

Drizzle + postgres.js. Schema is split deliberately:

- `packages/db/src/schema/auth.ts` is **generated** — `db:generate:auth` runs `@better-auth/cli generate` and then `scripts/patch-auth-schema.mjs`, which rewrites every `timestamp(...)` to `timestamptz`. Never hand-edit it; the next regeneration discards the edit. Change the patch script instead.
- `packages/db/src/schema/app.ts` holds app-owned tables (`post`, `post_like`, `follow`) so regeneration can't clobber them.

The generated half now also carries `two_factor` and `passkey`, plus `user.two_factor_enabled` and `user.last_login_method`. **Two hardcoded `TRUNCATE` lists have to name every table or rows leak silently between tests** — `packages/api/src/testing/harness.ts` and `e2e/support/db.ts`. Nothing fails when one is missed; tests just start seeing each other's data. Adding a plugin with a table means editing both.

Conventions worth preserving: table names are singular; every timestamp column is `withTimezone: true` (a bare `timestamp` makes Postgres write server-local time while Drizzle reads it back as UTC, shifting every post); app timestamps are also `precision: 3` (see below); `post_like` and `follow` are keyed by a composite primary key that *is* the uniqueness rule, which is what lets `like`/`unlike` and `follow`/`unfollow` be separate idempotent procedures instead of race-prone toggles. `follow` additionally carries a `follow_not_self` CHECK constraint — the handler's `BAD_REQUEST` is a courtesy on top of it, not the invariant.

A reply is a `post` with a `parent_id`, not a separate table. Two consequences worth knowing before touching either side:

- **Listing replies is a *mode* of `post.list` (`parentId`), not a `post.replies` procedure.** The web app's optimistic like sweep walks every cached `post.list` query by key prefix, so a separate procedure would sit outside it and likes on replies would silently stop updating. `includeReplies` is a second, independent axis: home timelines leave it off (and match the `post_created_idx` partial index on `parent_id is null`), a profile feed opts in.
- **`post.thread` returns the focused post plus its *ancestors* only** — never a first page of replies, which would give the same rows two cache homes. It walks `parent_id` upward in a recursive CTE collecting ids, then re-selects them through the shared `postSelection` so `likeCount`/`replyCount`/`viewerHasLiked` stay identical to every feed. The chain is capped at `THREAD_ANCESTOR_MAX`; `truncated` is read off the rows already fetched.

Feeds and follower lists are **keyset-paginated** with a base64url-encoded opaque cursor built by `createCursorCodec` in `packages/api/src/cursor.ts`. The codec is parameterised on the tie-breaker's schema because the type differs: posts break ties on a uuid `post.id`, while a `follow` row has no id of its own and breaks ties on the listed user's text `user.id`. Indexes in `app.ts` are ordered to match each cursor's `ORDER BY` — keep those in sync.

**`precision: 3` on the app tables' timestamps is load-bearing, not cosmetic.** Postgres defaults to microseconds; a JS `Date` — which is what Drizzle reads into, and all a JSON cursor can carry — holds only milliseconds. At the default precision a cursor built from `.340448` encodes `.340`, and the row-value comparison then excludes the stored row *and every other row in that millisecond*: a silent skip. Storing at the precision the consumer can represent makes the cursor round-trip exact. Any new keyset-paginated table needs the same.

### Web app

Vite + React 19 + TanStack Router (file-based) + TanStack Query + Tailwind v4 + shadcn (`style: base-maia`, components in `src/components/ui`) + Jotai + Paraglide i18n.

- Routes live in `apps/web/src/routes`. Profile URLs use the literal-prefix syntax: `@{$username}.tsx` serves `/@alexmercer`. That route is a **layout** — it owns the profile header, follow button and counts, then renders `<Outlet />`; the body is `@{$username}.index.tsx` (the person's posts). The follower and following lists are *not* routes: the counts in the header are dialog triggers (`follow-list-dialog.tsx`), which mount `user-list.tsx` only while open. Adding a nested route without an `index` sibling makes the parent URL render a header with an empty body rather than a 404.
- `/post/$postId` is the thread page: the ancestor chain and focused post come from `threadAtomFamily` (`atoms/thread.ts` → `post.thread`), while the replies below it are an ordinary `postFeedAtom({ parentId })` page off `post.list`, so they share the feed cache the like sweep already covers. The reply box reuses `composer-form.tsx` with an in-memory `replyDraftAtomFamily` — deliberately *not* persisted like `composerDraftAtom`, because a family of `localStorage` keys would accumulate one per post ever replied to with nothing able to evict them.
- `/discover` is a **stub** — `routes/discover.tsx` renders `null`, but the header, footer and the signed-in empty state already link to it. Deleting it breaks those `to=` targets; it is a feature gap, not an artefact.
- **`/welcome` is the handle gate, and it is load-bearing.** A social sign-up arrives signed in with `user.username` null, which this app cannot render — no profile URL, unfollowable, and `header.tsx` used to fall through its `user && handle` branch and show "Log in"/"Register" to someone already signed in. `useRequireHandle` (mounted in `__root.tsx`, so no future route can forget it) holds such a session at `/welcome` until it claims one; the legal pages are exempt, because a sign-up gate that hides the terms is its own problem. `claimHandleAtom` waits for the session store to actually carry the new handle before returning — navigating any earlier means `useRequireHandle` reads a still-null username and bounces straight back.
- `/two-factor` is the sign-in challenge. It is reached because `signInAtom` **returns** the outcome (`"two-factor"`) and the route navigates — *not* via the plugin's `onTwoFactorRedirect`/`twoFactorPage`, which respectively cannot reach the router without cycling through `main.tsx` and force a full document reload that would discard the Jotai store mid-sign-in. Note there is no session at all during the challenge: BetterAuth discards the pending one, so `isSignedInAtom` stays false and `useRedirectWhenSignedIn` is what finally fires on success.
- `/settings/account` owns two-factor enrolment, passkeys, linked accounts and sign-out. It is a flat `settings.account.tsx` with **no `settings.tsx` layout** — that would make `/settings` render a chrome with an empty body rather than 404, the same trap `@{$username}.tsx` documents above. Its only entry point is the profile page's Settings button (previously a dead "Edit Profile"); the header still has no account menu.
- **Google One Tap lives on its own auth client** (`lib/one-tap.ts`). `oneTapClient`'s `getActions` does not satisfy `BetterAuthClientPlugin` in better-auth 1.6.25, and because the client's whole surface is inferred from its plugin array's element type, including it — or casting it in place — erased `signIn.email`, `passkey.*`, `twoFactor.*` and `session.user.username` from `authClient` all at once. Keep `lib/auth-client.ts`'s array strictly typed; put anything that won't satisfy the interface behind its own client.
- The legal pages (`/privacy`, `/terms`, `/mentions-legales`) are thin routes over components in `components/legal/`. `/privacy` and `/terms` pick a French or English body off `getLocale()`; `/mentions-legales` is French-only on purpose — it is the LCEN legal notice, a filing addressed to French readers and authorities, not app copy. These components are now the **only** copy of that text — a parallel Markdown set under `legal/` at the repo root was removed, so edit the components directly. Two things it recorded still need a human before launch: the domain assumption, and that the anonymous-publisher clause holds only while the hosting account carries the publisher's real identity.
- **Generated, git-ignored, never edit:** `src/routeTree.gen.ts` and `src/paraglide/**`. They are produced by Vite plugins on `dev`/`build`. **A new route file does not exist to TypeScript until the tree is regenerated**, so run `dev` or `build` once before expecting `typecheck` to resolve a new `to=` target.
- No route uses search params. The home feed switch is the one piece of view state that could have been one, and deliberately isn't: it lives in `feedScopeAtom` (`src/lib/feed-scope.ts`), a Jotai `atomWithStorage`, so the choice persists across visits and `/` stays `/` — at the cost of a feed view nobody can link to. Reads sanitise the stored value (localStorage is user-editable), and `getOnInit: true` is required so the first render already has it, or the page mounts the global feed and immediately refetches.
- `src/components/ui` carries only the primitives something imports — today `avatar`, `button`, `dialog`, `dropdown-menu`, `input`. Unused shadcn output was removed rather than kept "for later" — `npx shadcn add <name>` puts it back in one command, and an unused component still has to be maintained (the i18n pass had to translate a `sheet.tsx` nothing rendered).
- `Button` with `nativeButton={false} render={<Link/>}` is the app-wide idiom for link-buttons. Note it reports `role="button"`, not `role="link"` — Base UI applies button semantics to whatever it renders.
- Dev proxies `/rpc` and `/api/auth` to `localhost:3001`; the oRPC link resolves its URL lazily against `window.location.origin` so the module stays importable outside a browser.

### i18n

English and French, via Paraglide. Messages are `apps/web/messages/{en,fr}.json`, keyed in `snake_case`; the Vite plugin compiles them into `src/paraglide/**` (generated, git-ignored) and code reads them as `m.some_key()`. `project.inlang/settings.json` uses the v2 vocabulary — `baseLocale`/`locales`, and `pathPattern` interpolating `{locale}`, not the older `sourceLanguageTag`/`languageTag` spelling. **A new key must exist in *both* catalogues**; a missing one compiles to the key name rather than failing the build. Nothing flags the reverse either — a key no code calls compiles happily into both bundles, so orphans have to be pruned by hand (`grep -o 'm\.[a-z0-9_]*' -r src --exclude-dir=paraglide` against the catalogue keys).

- **Keys are flat, prefixed by domain, and the two files are byte-for-byte parallel.** The prefixes are the structure: `app_` (document metadata and branding), `common_`, `nav_`, `user_`, `theme_`, `locale_`, `footer_`/`legal_`, `auth_` (with `auth_field_*` for form labels and placeholders), `validation_`, `welcome_`, `twofa_`, `passkey_`, `settings_`, `feed_`, `post_`, `reply_`, `thread_`, `follow_` (with `follow_list_*` for the dialog), `profile_`. Groups are separated by a blank line and appear in that order in **both** catalogues, so a diff of `en.json` against `fr.json` lines up. Add a key to its group in both files, not at the end.
- **Flat keys are deliberate — do not nest the JSON.** Paraglide only reaches a nested key through bracket notation (`m["nav.home"]()`), which breaks the `m.some_key()` idiom, the `plugin-m-function-matcher` module in `project.inlang/settings.json`, and the orphan grep below. Paraglide's own docs recommend flat.
- **Two English words that mean different things get two keys.** `feed_following` (the home timeline tab) and `follow_following` (the follow-button state / dialog title) currently hold the same string on purpose — they are separate so a translator can diverge them without breaking the other.
- **Locale resolution is `["cookie", "globalVariable", "baseLocale"]` — there is no URL segment.** `/privacy` is the same URL in both languages, which is the same trade `feedScopeAtom` makes: the choice persists (a `PARAGLIDE_LOCALE` cookie) at the cost of a per-language URL nobody can link to or index.
- **`setLocale()` reloads the document by default**, and the footer switcher lets it. That is what makes reading `getLocale()` directly at render time safe in the legal pages — no component has to update in place when the locale changes, so none of this needs to be a reactive atom.
- Document metadata is the one thing the message catalogue can't reach on its own, so `localeDocumentEffect` (`atoms/locale.ts`) syncs `<html lang>`, `document.title` and the meta description. It is an `atomEffect` mounted in `__root.tsx` next to `themeClassEffect`, and depends on no atoms — it runs once per document load, which is sufficient precisely because switching locale reloads.
- **Validation strings stay English at the source.** `lib/auth-validation.ts` returns them verbatim as its single source of truth; `lib/auth-error-message.ts` maps the known ones to translated messages at the render boundary and **passes anything unrecognised straight through**, so a server error surfaces as itself instead of being swallowed by a lookup miss. That pass-through is also what lets the BetterAuth i18n plugin (`packages/auth/src/i18n.ts`) translate server errors with no client change at all — they arrive already French and fall through the lookup untouched.
- `validateUsername` is shared by `/register` and `/welcome` rather than duplicated. Two copies of "3 to 20 characters" would eventually disagree, at which point one form accepts a handle the other rejects and both look broken.

### State lives in atoms

Client state is Jotai, in `apps/web/src/atoms/*`. Server state is still TanStack Query, but reached through `jotai-tanstack-query` so queries compose into the atom graph. The pattern to copy is `atoms/profile.ts`; `atoms/theme.ts` is the reference for a persisted preference with a live external subscription.

**Reach for an atom before `useState`.** There is currently **no `useState` anywhere in `apps/web/src`** — the last one (`isFocused` in `composer-form.tsx`) went away with that component's focus ring. New code should not add one back without a reason it can state. The default is an atom in `atoms/*`, because that is what lets a value be *derived* rather than recomputed: `homeFeedScopeAtom` folds the session-pending guard and the signed-out override that used to sit inline in `home-page.tsx`, and `followListDialogAtom` deleted an entire `useEffect` by holding the open dialog's *identity* instead of a per-instance boolean. State that stays local is state the next component has to re-derive by hand, which is how `header.tsx` ended up with its own subtly wrong copy of `initialsOf`.

The same goes for `useEffect`. Two kinds remain, both deliberate: **redirects**, which need the router's `navigate` and so cannot be atoms (an atom importing the router would cycle through `main.tsx`) — `use-redirect-when-signed-in.ts`, `use-require-handle.ts`, `use-one-tap.ts`, plus the guards in `welcome.tsx` and `settings.account.tsx`; and the **form reset-on-unmount** in `login.tsx`/`register.tsx`/`welcome.tsx`. An effect that *synchronises* one piece of state to another is almost always a derived atom instead. External subscriptions belong in `onMount` (`systemThemeAtom`, `sessionAtom`); reactions to atom changes belong in `atomEffect` (`themeClassEffect`).

**Several BetterAuth client calls resolve before the session they changed is visible.** `signOut()` and `updateUser()` both trigger a separate, un-awaited `/get-session` refetch, so for a moment afterwards `sessionAtom` — and everything derived from it — is confidently stale. That is not theoretical: it is the bug `e2e/tests/specs/auth.spec.ts` documented for a while, where signing out and navigating to `/login` read a still-`true` `isSignedInAtom` and bounced you back to the profile you had just left. `lib/session-sync.ts`'s `waitForSession` closes the gap, and `signOutAtom`/`claimHandleAtom` both await it before resolving. Anything else that mutates the session should too.

Component-local `useState` would still be right for genuinely ephemeral, single-consumer UI state — but note that even the auth form fields, passwords included, are atoms here (`atoms/auth-form.ts`), bounded by a reset on unmount rather than by component lifetime.

- **`src/lib/store.ts` hydrates `queryClientAtom` at module scope, and must stay that way.** `queryClientAtom` defaults to its *own* `new QueryClient()`. `useHydrateAtoms` only applies on the first render of the component calling it, so any earlier read — a router loader, a `store.get()`, any module importing the atom — locks in that default and Jotai will not re-initialise it. Two clients means two `MutationCache`s, and `MutationCache.#scopes` is a private instance field, so mutation `scope` silently stops serialising: no error, no type failure, just two mutations that must run in order running concurrently. Verified both ways with a scratch script during the migration.
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
- **`apps/web` depends on `zod` directly, and that line is load-bearing even though no `src/` file imports it.** `better-call` (under `better-auth`) takes `zod` as a *peer*, so pnpm instantiates it per workspace against whatever `zod` that workspace can see. `shadcn` — a real dependency here, imported by `src/index.css` as `@import "shadcn/tailwind.css"`, not by any TS file — brings zod 3, and without an explicit zod in `apps/web` the peer resolved to it. That gave `apps/web` a `better-call` structurally incompatible with `packages/auth`'s, and the symptom is maximally misleading: dozens of errors at call sites saying `signIn.email`, `twoFactor` or `session.user.username` do not exist, with nothing pointing at a dependency. Pinning `zod: catalog:` in `apps/web` resolves the peer to zod 4 and collapses it back to one instance. **`ls node_modules/.pnpm/better-call@*` must show exactly one entry.**

### Lint

Root flat ESLint config with `recommendedTypeChecked` via `projectService`. `no-floating-promises`, `no-misused-promises`, and `require-await` are errors — that's the point of typed linting here (a real server crash came from a misused promise). In practice this means `void`-ing deliberate fire-and-forget calls, e.g. `onClick={() => void feed.refetch()}` and the sync `createServer` callback. Files outside any tsconfig `include` must be listed in `allowDefaultProject`.
