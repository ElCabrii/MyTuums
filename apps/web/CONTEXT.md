# apps/web context

## Responsibility

The React 19 + Vite SPA: every page, every piece of client state, and all
translated copy. It talks to the API through the oRPC client and to
better-auth through its React client. In production the server serves this
app's build from the same origin.

## Start here

| File                     | Why                                                                |
| ------------------------ | ------------------------------------------------------------------ |
| `src/lib/store.ts`       | The one Jotai store, and why it is hydrated at module scope.       |
| `src/lib/orpc.ts`        | The oRPC client, the shared response types, the retry rule.        |
| `src/atoms/post-feed.ts` | The house style for a server-data atom family.                     |
| `src/routes/__root.tsx`  | App chrome, the session gate, and the no-flash first paint.        |
| `src/main.tsx`           | Where the single router, store and QueryClient are wired together. |

## Change map

| Intent                        | Primary                                                                 | Also touch                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a page                    | `src/routes/<name>.tsx` (thin wrapper)                                  | the page body in `src/components/`; `SIGNED_OUT_PATHS` if it must work signed out; a stub in `src/test/route-tree.tsx` (checked by the canonical inventory test in `route-tree.test.ts`)                   |
| Add client state              | `src/atoms/<concern>.ts`                                                | its `.test.ts` sibling                                                                                                                                                                                     |
| Read server data              | a new `atomWithQuery` / `atomWithInfiniteQuery` in `src/atoms/`         | `src/lib/query-definitions.ts`; `src/lib/orpc.ts` for response types                                                                                                                                       |
| Add a mutation with optimism  | `src/atoms/<concern>.ts`                                                | use `beginFollowPatch` / `beginPostPatch` in `src/lib/follow-cache.ts` / `post-cache.ts` — they own their cache inventory, cancellation and snapshot; roll back via `restoreFollowCaches` / `restorePosts` |
| Add a UI component            | `pnpm --filter @my-tuums/web exec shadcn add <component>`               | never hand-write into `src/components/ui`                                                                                                                                                                  |
| Add or change copy            | `messages/en.json`, `messages/fr.json`                                  | recompile; never touch `src/paraglide`                                                                                                                                                                     |
| Router-touching behaviour     | `src/hooks/`                                                            | never an atom — see the invariants                                                                                                                                                                         |
| Change an auth flow page      | `src/routes/` + `src/atoms/auth.ts`                                     | `src/lib/auth-validation.ts` (form policy only — the rules live in `@my-tuums/auth/rules`)                                                                                                                 |
| Change the legal consent gate | `src/atoms/legal-consent.ts`, `src/components/legal-consent-dialog.tsx` | `LEGAL_VERSION` in `@my-tuums/auth/rules`; `e2e/support/users.ts` seeds consent for every fixture                                                                                                          |
| Add a moderation surface      | `src/atoms/moderation.ts`, `src/components/moderation/`                 | `src/hooks/use-require-role.ts`                                                                                                                                                                            |

## Invariants

- **One Jotai store, one QueryClient, one router.** `src/lib/store.ts` is
  hydrated with `queryClientAtom` at module scope, never through
  `useHydrateAtoms` — that only applies on a component's first render, so any
  earlier read locks in the package's default client. Two QueryClients means
  two `MutationCache`s, and mutations sharing a `scope.id` silently stop
  serialising against each other.
- **Never wrap a page in its own Jotai `<Provider>`.** That creates a second
  store and breaks every session read.
- **Never import the router from an atom.** It cycles through `main.tsx`.
  Gates and redirects live in `src/hooks/`.
- **Atom families key on primitive strings only**, and never use
  `setShouldRemove`. Object params force a linear-scan `areEqual`; lazy removal
  can split a shared observer mid-scroll. Cleanup happens in
  `src/atoms/session-teardown.ts`, where nothing is mounted.
- **The conditional spreads in `src/lib/query-definitions.ts` are
  load-bearing.** oRPC embeds the whole input
  object in the query key; those spreads keep the global feed's key bare, and
  the optimistic sweeps match on exactly those prefixes. "Cleaning them up"
  forks every cache entry silently.
- **Sign-out clears the QueryClient and sweeps every family.** Cached rows
  carry viewer-relative fields (`viewerHasLiked`, `viewerIsFollowing`) under
  viewer-less keys. `src/atoms/session-teardown.ts` owns that whole inventory
  behind one call; a new viewer-owned family is added there, not in
  `signOutAtom`. Its lightweight coordinator clears the QueryClient
  synchronously, then dynamically imports each family for an independent,
  best-effort sweep so chunk loading cannot block sign-out.
- **Like and follow serialise per entity.** One `scope` id per entity,
  per-entity intent atoms drop superseded responses, and rollback rides on
  mutation-level `onError` — per-call callbacks never fire for write-only
  atoms read with `useSetAtom`. `src/atoms/repost.ts` is the same contract again
  (the file points back at `src/atoms/like.ts` for the reasoning), with one
  addition: a successful repost invalidates the `post.list` queries, because a
  repost is a feed _event_ whose position is server-ordered.
- **Persisted atoms read `localStorage` as `unknown`, sanitise on read, and
  set `getOnInit: true`** — without it the first render flashes the default.
- **Exactly one effect owns each redirect.** Auth pages call
  `useRedirectWhenSignedIn` and never navigate on success themselves;
  double-navigation races were real bugs.
- **The legal consent gate decides everything itself.** `LegalConsentDialog`
  is mounted unconditionally in `__root.tsx`; it reads whether the viewer is
  signed in, whether their recorded `legalVersion` is current, and whether the
  current path is one of the legal documents. Re-stating any of that at the
  mount point lets the two halves drift, and the path check is what keeps an
  undismissable modal off the very pages it links to.
- **Callback URLs given to better-auth must be absolute**
  (`window.location.origin`). A relative one resolves against the API origin
  and dead-ends in dev.
- **`updateUser` goes through the auth client, never an oRPC procedure.**
  `packages/auth`'s database hooks are the single enforcement point for
  user-field rules.
- **Never edit `src/components/ui`.** Those are upstream shadcn primitives;
  add new ones with the CLI so regenerations stay clean.
- **`data-testid` is banned** across the app — the E2E suite locates
  structurally or by role.
- **`src/lib/document-head.ts` owns every SPA-rendered head tag; `index.html`
  owns only pre-JS fallbacks.** The static `[data-app-fallback]` tags restate
  `SITE_ORIGIN` and the brand copy by hand because that file cannot import
  TypeScript; `__root.tsx` removes them on mount so nothing is left with two
  owners. Open Graph URLs always point at the production origin
  (`SITE_ORIGIN`), never at the current host — change it together with
  `index.html`. Canonicals are per-URL, so `index.html` ships none: the server
  serves that file verbatim for every path and a static one would point every
  crawlable URL at the homepage. Each route's `head()` emits its own canonical
  via `pageHead`, and `fallbackHead()` deliberately emits no `links`.
  Data-dependent titles/descriptions go through
  `setDocumentHead`/`useDocumentHead`, which also update the Open Graph and
  Twitter mirrors.
- **`SIGNED_OUT_PATHS` decides whether any of this is externally visible.**
  The route heads are client-rendered, so only a signed-in, JS-rendering
  browser sees them; every main content route (`/`, `/discover`, `/search`,
  `/@{username}`, `/post/$postId`, `/moderation`, `/settings/account`) is
  absent from `SIGNED_OUT_PATHS`, so the server 302s every signed-out fetcher
  — search engines and non-JS unfurlers included — to `/login` before any of
  it could be served. The externally visible head today is the static
  fallback in `index.html` plus its Organization JSON-LD; what the per-route
  tags deliver is tab titles/descriptions (and mirrors) for signed-in users,
  not public unfurls.
- **`src/index.css` owns scrollbars globally.** Its Firefox properties and
  WebKit pseudo-elements style the viewport and every nested overflow surface
  from the existing theme variables, so components should not introduce their
  own scrollbar colors or dimensions.
- **Feed and list parameterisation lives in atoms.** `PostFeed` takes a
  `feedAtom` prop and never knows its own scope or author.
- **The quote composer is one root-mounted dialog, not a page.** Any card's
  Quote button sets `quoteDialogAtom` (the full post row — the dialog previews
  the embedded card from it), and `QuoteDialog` in `__root.tsx` is the only
  mounted instance, the same identity-atom shape as the delete confirmation.
  Its draft is in-memory: one dialog, bounded lifetime, nothing to evict from
  `localStorage`.
- **Permalink reply grouping reads the continuation embedded in each direct
  `post.list({ parentId })` page.** `ThreadReplyFeed` renders the flat direct
  page and its connected branch without recursive indentation;
  `replyContinuationAtom` resumes capped branches through the
  `continuationRootId` mode of the same procedure/cache prefix.

## Dependencies and boundaries

- Import exactly five workspace modules and no others:
  `@my-tuums/api/constants`, `@my-tuums/api/dimensions`,
  `@my-tuums/api/post-image`, `@my-tuums/api/roles`
  and `@my-tuums/auth/rules`. All five must stay free of `@my-tuums/db`, which
  throws at module load in a browser. The production bundle contains those
  five and nothing else from the packages — check a sourcemap's `sources` if
  you need to confirm it after a change.
- **`src/lib/auth-validation.ts` is a form adapter, not a rule book.** The
  handle bounds and charset, the date-of-birth parse and age comparison, the
  bio limit and every English rejection string come from
  `@my-tuums/auth/rules`, which is the same module `packages/auth`'s database
  hooks enforce from. What this file owns is what only a form knows: which
  fields are required, what gets trimmed, which violation surfaces first, and
  the rules with no server half at all (password length and confirmation, the
  two-factor box, the login fields). Restating a bound or a message here puts
  the client back out of step with the server it cannot see.
- The client mirrors pinned server settings: no session cookie cache,
  `requireEmailVerification: true`. Because verification is required, a
  password sign-up returns no session — `/register` navigates to
  `/verify-email` itself rather than waiting on `useRedirectWhenSignedIn`, and
  `/login` does the same on the `EMAIL_NOT_VERIFIED` outcome.
- In dev, Vite proxies `/rpc`, `/api/auth` and `/media` to the API on `:3001`.
- Only two `VITE_*` variables are read: `VITE_SOCIAL_PROVIDERS` and
  `VITE_GOOGLE_CLIENT_ID`. Both are inlined at build time — see
  [docs/operations.md](../../docs/operations.md).

## Generated files

| Path                   | Generator                                                             | If it is missing                        |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `src/routeTree.gen.ts` | the TanStack Router Vite plugin                                       | `tsc` cannot resolve a route            |
| `src/paraglide`        | the Paraglide Vite plugin, or `pnpm --filter @my-tuums/web paraglide` | `tsc` cannot resolve a message function |

Both are git-ignored, and both are why `lint` and `typecheck` depend on
`build` in `turbo.json`. The package's own `test` script compiles Paraglide
first.

## Verification

| Command                                                              | Covers                |
| -------------------------------------------------------------------- | --------------------- |
| `pnpm --filter @my-tuums/web test`                                   | the unit suites       |
| `pnpm --filter @my-tuums/web test:node` / `test:dom`                 | one Vitest project    |
| `pnpm --filter @my-tuums/web exec vitest run src/atoms/like.test.ts` | one file              |
| `pnpm --filter @my-tuums/web lint` / `typecheck`                     | this package alone    |
| `pnpm --filter @my-tuums/web build`                                  | the production bundle |

`src/test/render.tsx` provides `renderWithProviders`: a fresh store, a memory
router and a mocked auth client. The test harness is split across four modules
in `src/test/`:

- `render.tsx` — `renderWithProviders` only: it composes providers and renders,
  and is deliberately not a barrel. Factories, query fixtures and auth helpers
  are imported from their owning modules so dependency ownership stays greppable.
- `auth-fixture.ts` — the BetterAuth fake and the session-driving calls
  (`setTestSession`, `setTestSignedOut`, `patchTestSessionUser`,
  `setTestSocialProviders`). The fake is installed by `installTestAuthFixture()`,
  which both Vitest setups call during the setup phase — before any test module
  is evaluated. That is what removes the import-order convention:
  `src/atoms/session.ts` seeds `sessionAtom` from `sessionStore.get()` at its own
  import time, and the setup phase runs first, so a test can import a component
  that reaches `src/atoms/session.ts` before `@/test/render` without binding to
  the real BetterAuth session store.
- `route-tree.tsx` — the stub route tree. Its agreement with `src/routes/*.tsx`
  is one invariant with one canonical owner: the "test route inventory" test in
  `route-tree.test.ts`, which fails with the missing or stale route named in
  both directions. `buildTestRouter` only builds a router and asserts nothing.
- `factories.ts` — the `make*` domain builders and `createTestQueryClient`,
  with no side effects, importable from node-project tests.

`src/test/query-fixtures.ts` owns query-cache seeding through
`queryFixtures(queryClient)`; every key comes from the production
`*QueryOptions` helpers, and its error operations must be awaited.

The environment is decided by the two Vitest projects in `vitest.config.ts`,
not per-file docblocks: `*.test.ts` runs under Node (`test:node`) with a
setup that provides no browser global at all — no `window`, no `document`,
no `matchMedia`, no `localStorage`; only the BetterAuth fixture, since
persisted atoms degrade to in-memory storage without one. Tests that assert
persistence install their own in-memory `localStorage` via
`installInMemoryStorage()` from `src/test/memory-storage.ts`. `*.test.tsx`
and the
rare `*.dom.test.ts` exception (canvas, `document.head`, `window.location`)
run under jsdom (`test:dom`). A `.test.ts` that touches the document
fails loudly. When a rendered behaviour is owned by the atom or helper
underneath, the component test proves only its wiring — the four-state list
skeleton, for example, is owned by `paginated-state.test.tsx`, not restated
per consumer.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — state ownership, dev proxies.
- [docs/product.md](../../docs/product.md) — what each screen is supposed to do.
- [docs/security.md](../../docs/security.md) — the redirect guard and the gates.
