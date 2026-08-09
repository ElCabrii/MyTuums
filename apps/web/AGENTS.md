# AGENTS.md

Guidance for Claude Code when working in `apps/web` — the MyTuums SPA.

## What this is

The React 19 + Vite client: TanStack Router file routes (`src/routes/`), shadcn UI (`src/components/ui/`, style base-maia / zinc / lucide), Paraglide i18n (`messages/` compiled to generated `src/paraglide/`), and Jotai for all client state. It talks to the API through the oRPC client and to BetterAuth through its React client; the server serves this built SPA in production (one origin is a requirement — see root AGENTS.md).

## Key files

- `src/main.tsx` — entrypoint: the single router (created from the generated `routeTree.gen.ts`), wrapped in the single Jotai store and the single QueryClient.
- `src/lib/store.ts` — the ONE Jotai store, hydrated with `queryClientAtom` at module scope. Two QueryClients would silently split mutation `scope` serialisation.
- `src/lib/query-client.ts` — the ONE QueryClient every atom query runs on.
- `src/lib/orpc.ts` — the oRPC client (absolute `/rpc` URL, CSRF header) + `createTanstackQueryUtils`; also the shared response types (`Post`, `Thread`, `Profile`, …) and `retryUnlessClientError` (no retries for 4xx).
- `src/lib/auth-client.ts` — the BetterAuth client; the one cast that types the session store's `additionalFields`; `socialProviders` (mirrors the server's `VITE_SOCIAL_PROVIDERS`); `shouldOfferOneTap`.
- `src/lib/session-sync.ts` — `waitFor*` / `refreshSession`: closes the gap between an auth call resolving and the session store catching up (the e2e-documented sign-out race). `refreshSession` goes through the store's `refetch`, never `getSession()` (which doesn't touch the store).
- `src/lib/redirect.ts` — `sanitizeRedirect`, the open-redirect guard for the `?redirect=` param.
- `src/lib/auth-validation.ts` — pure validation rules; the English strings are shared byte-for-byte with the server (`packages/auth`), so server rejections land on the same translated copy.
- `src/lib/auth-error-message.ts` — `localizeAuthError`/`localizeOAuthError`: translate known strings, pass everything else through verbatim.
- `src/lib/post-cache.ts` / `follow-cache.ts` — the optimistic like/follow sweep helpers covering both cache shapes (`post.list` infinite feeds + `post.thread`).
- `src/lib/media.ts` — browser-side image re-encode: a display WebP variant plus the untouched original; server sniffs the bytes, this is the cooperative path.
- `src/lib/returning-visitor.ts` — the first-party "has had a session" cookie One Tap keys on.
- `src/atoms/` — all client state, one module per concern: auth flows, session derivations (incl. the client mirror of the role ordering), theme/locale, feed/thread/profile queries, like/follow/post/reply mutations, moderation (queue/case/report/block/appeal mutations + dialog identity atoms, `atoms/moderation.ts`), settings forms. Families key on primitive strings; mutation atoms wrap oRPC procedures.
- `src/hooks/` — the router-touching gates and redirects atoms must never do (`use-require-signed-in`, `use-require-handle`, `use-redirect-when-signed-in`, `use-one-tap`). `use-require-role` gates the `/moderation` route client-side; the server re-checks every procedure.
- `src/test/` — `setup.ts` (jsdom `localStorage`/`matchMedia` shims) and `render.tsx` (`renderWithProviders`: fresh store + memory router + mocked auth client + cache seeding; the `seedInfiniteError` helpers must be awaited).

### src/routes/ and src/components/

- Routes are thin `createFileRoute` wrappers — the page bodies live in `src/components/`. `routeTree.gen.ts` is generated + git-ignored; build/dev must run before typecheck can resolve routes. Moderation routes: `/moderation` (queue/audit/team tabs, `components/moderation/`), `/appeal` (the app's one signed-out page — the HMAC capability link from the moderation email, or a signed-in author's removed-post stub), and the blocked-users section on `/settings/account`.
- Layouts: `__root.tsx` (app chrome + session gate, load-bearing — see below) and `@{$username}.tsx` (profile chrome; the body is the nested `@{$username}.index.tsx` tab). Deliberately no `settings.tsx` layout: a layout without an index sibling makes `/settings` render empty chrome instead of 404.
- `__root.tsx` mounts the theme/locale/session effects, the `useRequireHandle` and `useRequireSignedIn` gates, and renders nothing (static `#app-splash` in index.html stays up) until the first `/get-session` lands — that is the fix for the signed-out flash. New pages need no per-route gates; the header renders only for a real session, and `/welcome` keeps it (handle-less session).
- Signed-in gate: any non-auth URL redirects a signed-out visitor to `/login?redirect=<path>`; `redirect` is sanitized in `lib/redirect.ts`. In production this is enforced twice — `apps/server/src/request-handler.ts` gates the initial page load with a real session check, and `useRequireSignedIn` covers everything the server can't see: client-side navigation and a session going stale mid-visit. Both read the same allowlist, `SIGNED_OUT_PATHS` from `@my-tuums/api/constants` — never duplicate it locally, or the two gates can disagree and loop. Auth pages call `useRedirectWhenSignedIn` and never navigate on success themselves — exactly one effect owns every redirect (double-navigation races were real bugs; see register.tsx and welcome.tsx comments).
- Auth pages: `/login`, `/register`, `/forgot-password`, `/reset-password`, `/two-factor`, `/welcome` (handle + date-of-birth claim for incomplete sessions, then a one-time skippable 2FA offer). Search params arriving from external redirects (`?error=`, `?token=`, `?redirect=`) are narrowed to strings and never trusted.
- Pages: home feed (`/`, home-page.tsx), thread (`/post/$postId`, thread-page.tsx), profile + posts tab, `/settings/account` (a flat page of `components/settings/` sections — composition, not layout), legal pages (`/privacy`, `/terms`, `/mentions-legales` — localized like everything else, prose lives in the message catalogs; the French text of `/mentions-legales` stays the legally authoritative LCEN filing), and `/discover` (a deliberate stub rendering null so nav links have a target).
- Component map: structural (header, footer, home-page, profile-layout, thread-page), post chrome (post-card, post-feed, composer-form + post-composer/reply-composer bindings), social (follow-button, follow-list-dialog, user-list), settings sections, legal (legal-document wrapper + one component per document, each reading the message catalogs), brand icons, and small controls (segmented-control, mode-toggle, user-avatar, profile-message, not-found-page, sign-in-options, footer-locale-menu).
- Gotchas: never edit `src/components/ui/**` — upstream shadcn primitives; add new ones via `pnpm --filter @my-tuums/web exec shadcn add <component>` so regenerations stay clean. Feed/list parameterisation lives entirely in atoms — `PostFeed` takes a `feedAtom` prop and never knows its own scope/author. Auth errors on settings/account all funnel through one `authErrorAtom` banner owned by the page.

## Connecting to the monorepo

- oRPC contract: `packages/api` (`@my-tuums/api`); shared constants (`POST_PAGE_SIZE`, `IMAGE_LIMITS`, `BIO_MAX_LENGTH`, …) come from `@my-tuums/api/constants`, image dimension parsing from `@my-tuums/api/dimensions`.
- Auth server: `packages/auth` — the client mirrors its pinned settings (no session cookie cache, `requireEmailVerification: false`).
- Generated and git-ignored: `src/routeTree.gen.ts` and `src/paraglide/` — build or dev must run before typecheck can resolve them.
- In dev, Vite proxies `/rpc`, `/api/auth` and `/media` to the API on :3001.

## Load-bearing decisions — do not break

- One Jotai store, one QueryClient, one router; atoms never create their own.
- Atoms for state, `atomEffect` for reactions. Never import the router from an atom (import cycle through `main.tsx`) — router-touching hooks live in `src/hooks/`.
- oRPC embeds the whole input object in query keys: the conditional spreads in `atoms/post-feed.ts` / `atoms/user-list.ts` keep the global feed key bare, and the optimistic sweeps depend on those exact prefixes. "Cleaning up" those spreads forks every cache entry silently.
- Atom families key on primitive strings only (object params force a linear-scan `areEqual`), and never `setShouldRemove` (lazy evaluation can split a shared observer mid-scroll). Cleanup happens in the sign-out sweep (`atoms/sign-out-sweep.ts`) where nothing is mounted.
- Like/follow: one `scope` id per entity serialises mutations; per-entity intent atoms drop superseded responses; rollback rides on mutation-level `onError` (per-call callbacks never fire for write-only atoms read with `useSetAtom`).
- Persisted atoms (`theme`, `feed-scope`, composer draft) read `localStorage` as `unknown`, sanitise on read, and need `getOnInit: true` to avoid a first-render flash.
- Sign-out clears the QueryClient and sweeps every family: cached data carries viewer-relative fields (`viewerHasLiked`, `viewerIsFollowing`) under viewer-less query keys.
- Form fields are module-scoped atoms reset on unmount; never wrap a page in its own Jotai `<Provider>` — that creates a separate store and breaks session reads.
- Callback URLs given to BetterAuth must be absolute (`window.location.origin`); a relative one resolves against the API origin and dead-ends in dev.
- `updateUser` calls go through the auth client, never an oRPC procedure — `packages/auth`'s database hook is the single enforcement point for user-field rules.

## Commands

- Single test: `pnpm --filter @my-tuums/web exec vitest run src/atoms/foo.test.ts` (the package's `test` script compiles `src/paraglide` first if it's missing).
- `pnpm test:unit` / `pnpm lint` / `pnpm typecheck` from the repo root (turbo).
- Add a component: `pnpm --filter @my-tuums/web exec shadcn add <component>`.
