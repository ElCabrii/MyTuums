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

| Intent                       | Primary                                                         | Also touch                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a page                   | `src/routes/<name>.tsx` (thin wrapper)                          | the page body in `src/components/`; `SIGNED_OUT_PATHS` if it must work signed out                                                                                                                          |
| Add client state             | `src/atoms/<concern>.ts`                                        | its `.test.ts` sibling                                                                                                                                                                                     |
| Read server data             | a new `atomWithQuery` / `atomWithInfiniteQuery` in `src/atoms/` | `src/lib/query-definitions.ts`; `src/lib/orpc.ts` for response types                                                                                                                                       |
| Add a mutation with optimism | `src/atoms/<concern>.ts`                                        | use `beginFollowPatch` / `beginPostPatch` in `src/lib/follow-cache.ts` / `post-cache.ts` — they own their cache inventory, cancellation and snapshot; roll back via `restoreFollowCaches` / `restorePosts` |
| Add a UI component           | `pnpm --filter @my-tuums/web exec shadcn add <component>`       | never hand-write into `src/components/ui`                                                                                                                                                                  |
| Add or change copy           | `messages/en.json`, `messages/fr.json`                          | recompile; never touch `src/paraglide`                                                                                                                                                                     |
| Router-touching behaviour    | `src/hooks/`                                                    | never an atom — see the invariants                                                                                                                                                                         |
| Change an auth flow page     | `src/routes/` + `src/atoms/auth.ts`                             | `src/lib/auth-validation.ts` (form policy only — the rules live in `@my-tuums/auth/rules`)                                                                                                                 |
| Add a moderation surface     | `src/atoms/moderation.ts`, `src/components/moderation/`         | `src/hooks/use-require-role.ts`                                                                                                                                                                            |

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
  atoms read with `useSetAtom`.
- **Persisted atoms read `localStorage` as `unknown`, sanitise on read, and
  set `getOnInit: true`** — without it the first render flashes the default.
- **Exactly one effect owns each redirect.** Auth pages call
  `useRedirectWhenSignedIn` and never navigate on success themselves;
  double-navigation races were real bugs.
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
- **Feed and list parameterisation lives in atoms.** `PostFeed` takes a
  `feedAtom` prop and never knows its own scope or author.

## Dependencies and boundaries

- Import exactly four workspace modules and no others:
  `@my-tuums/api/constants`, `@my-tuums/api/dimensions`, `@my-tuums/api/roles`
  and `@my-tuums/auth/rules`. All four must stay free of `@my-tuums/db`, which
  throws at module load in a browser. The production bundle contains those
  four and nothing else from the packages — check a sourcemap's `sources` if
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
  `requireEmailVerification: false`.
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

| Command                                                               | Covers                |
| --------------------------------------------------------------------- | --------------------- |
| `pnpm --filter @my-tuums/web test`                                    | the unit suites       |
| `pnpm --filter @my-tuums/web exec vitest run src/atoms/theme.test.ts` | one file              |
| `pnpm --filter @my-tuums/web lint` / `typecheck`                      | this package alone    |
| `pnpm --filter @my-tuums/web build`                                   | the production bundle |

`src/test/render.tsx` provides `renderWithProviders`: a fresh store, a memory
router and a mocked auth client. `src/test/query-fixtures.ts` owns query-cache
seeding through `queryFixtures(queryClient)`; its error operations must be
awaited.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — state ownership, dev proxies.
- [docs/product.md](../../docs/product.md) — what each screen is supposed to do.
- [docs/security.md](../../docs/security.md) — the redirect guard and the gates.
