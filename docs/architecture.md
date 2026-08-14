# Architecture

How the workspaces fit together and what actually happens at runtime. For
"where do I make this change", start from [AGENTS.md](../AGENTS.md); for
behaviour and vocabulary, [product.md](product.md).

## Workspace ownership and dependency direction

**Source of truth:** `pnpm-workspace.yaml`, each package's `package.json`,
`turbo.json`

Dependencies point one way. `apps/web` and `apps/server` are leaves; nothing
imports them.

```
apps/web ──▶ packages/api (browser-safe subpaths only)
apps/server ──▶ packages/api ──▶ packages/auth ──▶ packages/db
            └─▶ packages/auth ─────────────────────┘
            └─▶ packages/db
e2e ──▶ packages/api, packages/auth, packages/db
```

`packages/api`, `packages/auth` and `packages/db` are **source-only**: they
export `.ts` from `exports` and have no build step. Consumers compile them
(`apps/web` through Vite) or inline them (`apps/server` through tsup, because
Node's type-stripping cannot rewrite the `.js` specifiers those packages
ship). Only `apps/server`'s own declared dependencies stay external in the
bundle.

`apps/web` may import `@my-tuums/api/constants` and `@my-tuums/api/dimensions`
and nothing else from that package. Those two subpaths must stay free of
`@my-tuums/db`, which reads `DATABASE_URL` at module scope and throws in a
browser.

## Development topology

**Source of truth:** `apps/web/vite.config.ts`, `docker-compose.yml`,
`e2e/playwright.config.ts`

`pnpm dev` runs two processes: the API on `:3001` and Vite on `:5173`. The
browser talks to Vite, which proxies three prefixes to the API:

| Prefix      | Target                         | Note                                                                            |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `/rpc`      | `RPC_TARGET` (default `:3001`) | `changeOrigin: true`                                                            |
| `/api/auth` | same                           | same                                                                            |
| `/media`    | same                           | the 302 is **not** followed by the proxy — the browser follows it to the bucket |

Vite's `envDir` is the monorepo root, so the single `.env` feeds Vite and every
`dotenv -e ../../.env` script alike.

`pnpm docker:up` occupies the same two ports with the production image, so run
one or the other. The E2E stack deliberately uses `:3101` / `:5273` so it can
run beside a live dev stack.

## Production topology — one origin

**Source of truth:** `apps/server/Dockerfile`, `apps/server/src/static-files.ts`,
`apps/web/src/lib/orpc.ts`

In production there is no proxy and no second origin. The Docker image sets
`WEB_DIST=/app/apps/web/dist` and the same Node process serves the SPA, the
auth endpoints, the RPC API and media redirects.

This is a requirement, not a packaging preference: `apps/web/src/lib/orpc.ts`
resolves `/rpc` against `window.location.origin`, and uploaded images are
stored as relative `/media/<key>` paths. Split the two across origins and RPC
and every image break together.

## HTTP route order and access gates

**Source of truth:** `apps/server/src/request-handler.ts`

Every request is given an `x-request-id` **before** any branch runs — that is
what puts it on responses written by the injected handlers too. Then, in
order:

| #   | Match                     | Gate                                            |
| --- | ------------------------- | ----------------------------------------------- |
| 1   | `GET /health` (exact)     | none — probes skip session and RPC matching     |
| 2   | `/api/auth/admin/*`       | always 404 — see below                          |
| 3   | `/api/auth*`              | better-auth's own handler                       |
| 4   | `/rpc*`                   | Content-Length cap, then oRPC                   |
| 5   | `/media/*`                | GET/HEAD only, then **session**, then key       |
| 6   | extension-less GET/HEAD   | page gate: session unless on `SIGNED_OUT_PATHS` |
| 7   | static files              | `apps/server/src/static-files.ts`               |
| 8   | 404, then a catch-all 500 | logged with the request id                      |

Ordering facts that are load-bearing:

- **`/api/auth/admin/*` 404s before the auth pass-through.** The better-auth
  admin plugin gates on its own `adminRoles` option, which cannot express this
  app's moderator/staff/admin hierarchy. Blocking it keeps `/rpc` the only
  path to a moderation action, so the hierarchy and the audit log are the only
  enforcement surface.
- **The `/rpc` body cap runs before oRPC buffers.** oRPC buffers a multipart
  body while routing, which is before auth, rate limiting or any payload
  check. Chunked bodies carry no Content-Length and are bounded at the same
  ceiling by oRPC's `BodyLimitPlugin`, wired in `apps/server/src/index.ts`.
- **`/media`'s session check runs before the key is parsed.** An anonymous
  caller must not learn which keys are well-formed by watching the response
  differ. The rejection carries `Cache-Control: no-store` so a cached 401
  cannot keep an image broken after sign-in.
- **The page gate sits after every API prefix**, so it needs no copy of the
  routing decisions above it. It reads `SIGNED_OUT_PATHS` from
  `packages/api/src/constants.ts` — the same set the client gate reads. Two
  copies would let the gates disagree and loop a visitor forever.
- **`hasValidSession` fails open.** A database blip degrades to "the client
  gate decides" and "images keep loading", never to a mass sign-out.

## oRPC context

**Source of truth:** `packages/api/src/context.ts`, `packages/api/src/procedures.ts`,
`packages/api/src/router.ts`

`createContext` builds one `Context` per request carrying `db`, `session`,
`rateLimiter`, `storage` and `requestId`. The rate limiter and the storage
client are threaded on the context, never imported as module globals, so tests
substitute fakes and one suite's limiter state cannot bleed into another's.

The router's top-level groups:

<!-- docs:check=router-groups -->

- `me` — the caller's own session user
- `post` — `create`, `list`, `thread`, `like`, `unlike`
- `user` — `byUsername`, `uploadImage`, `removeImage`, `follow`, `unfollow`, `followers`, `following`
- `search` — `typeahead`, `users`, `posts`
- `moderation` — reports, blocks, the queue, the staff actions, the audit log, appeals

There is deliberately no RPC-level health check; liveness is plain HTTP at
`/health`.

Procedures are built from four gates in `packages/api/src/procedures.ts`:
`protectedProcedure` (session required), `moderatorProcedure`,
`staffProcedure`, `adminProcedure` — plus `baseProcedure`, used by exactly one
procedure (`moderation.appealOpen`). See [security.md](security.md).

## Client state ownership — Jotai and TanStack Query

**Source of truth:** `apps/web/src/lib/store.ts`, `apps/web/src/lib/query-client.ts`,
`apps/web/src/main.tsx`, `apps/web/src/atoms`

One store, one QueryClient, one router — created at module scope, never inside
a component:

- `apps/web/src/lib/query-client.ts` exports the single `QueryClient`.
- `apps/web/src/lib/store.ts` exports the single Jotai store, hydrated with
  `queryClientAtom` at module scope rather than through `useHydrateAtoms`. Two
  QueryClients would silently split mutation `scope` serialisation.
- Every server-data atom wraps the oRPC utils through `jotai-tanstack-query`.
  `apps/web/src/atoms/post-feed.ts` is the house style.
- Router-touching work (gates, redirects) lives in `apps/web/src/hooks`, never
  in an atom: importing the router from an atom creates a cycle through
  `main.tsx`.

oRPC embeds the whole input object in query keys, so the conditional spreads in
the feed and user-list atoms are what keep the global feed's key bare — and the
optimistic like/follow sweeps in `apps/web/src/lib/post-cache.ts` match on
those exact prefixes.

## Auth and sessions

**Source of truth:** `packages/auth/src/index.ts`, `packages/auth/src/social.ts`,
`packages/auth/src/env.ts`, `apps/web/src/lib/auth-client.ts`

One better-auth instance serves the whole app, mounted at `/api/auth` by
`apps/server/src/index.ts`. Plugins: username, twoFactor, passkey, oneTap,
lastLoginMethod, admin, i18n. `trustedOrigins` is `[webOrigin]` only.

Session resolution goes through `auth.api.getSession` on every request — there
is deliberately no session cookie cache, because a revoked session must stop
authenticating immediately.

**Build-time versus runtime OAuth configuration** is the subtlety worth
knowing. The server registers a provider only when _both_ halves of its
credential pair exist (`packages/auth/src/social.ts`). The browser cannot read
server env, so the button list comes from `VITE_SOCIAL_PROVIDERS`, which Vite
inlines into the bundle **at build time** — inside the Docker build, via
`ARG`. The two lists are kept in agreement by hand and asserted from both
sides by CI. See [operations.md](operations.md).

## Media — upload, retrieval, reconciliation

**Source of truth:** `packages/api/src/profile-media.ts`,
`packages/api/src/image.ts`, `packages/api/src/storage.ts`,
`packages/api/src/media.ts`, `packages/api/src/reconcile-media.ts`

- **Lifecycle.** `user.uploadImage` and `user.removeImage` are thin
  procedures over `packages/api/src/profile-media.ts`, which owns the whole
  avatar/banner lifecycle: minting the object pair, the locked database
  swap, and the best-effort cleanup of superseded objects. The ordering is
  load-bearing — prepare/write the new objects, atomically swap the row
  references under `FOR UPDATE`, then delete the old objects — and it lives
  in exactly one place, so the two procedures cannot drift. Its interface
  accepts the bare database handle rather than a transaction handle, making
  the swap transaction the outermost commit before cleanup begins. A failed
  write or a rolled-back swap leaves the profile untouched and the fresh
  objects orphaned for reconciliation; a failed cleanup is swallowed and the
  stale objects are reaped the same way.
- **Upload.** `user.uploadImage` accepts bytes, sniffs the actual type rather
  than trusting the declared one (`sniffImageType`), parses dimensions from the
  header (`packages/api/src/dimensions.ts`), and enforces per-slot byte and
  megapixel bounds. The display variant and the untouched original share one
  uuid, distinguished by an `.orig` infix. The row is written **before** the
  old object is deleted.
- **Retrieval.** The stored value is a relative `/media/<key>` path. The
  server requires a session, then `createMediaResolver` returns a presigned
  URL and a cache budget; the response is a 302 with
  `Cache-Control: private, max-age=<secondsUntilWindowEnd()>`. Presigned URLs
  are **windowed** (`MEDIA_SIGNING_WINDOW_MS`, 30 minutes): byte-identical
  within a window, which is what makes browser caching work, and why the
  redirect must not be cached past the window's end.
- **Reconciliation.** `pnpm --filter @my-tuums/api reconcile:media` deletes
  objects no row points at. It lists the bucket **before** reading the `user`
  rows — the reverse order would treat an upload that landed between the two
  steps as an orphan and delete an object whose row points at it.

## Moderation — report, action, audit, appeal

**Source of truth:** `packages/api/src/moderation.ts`,
`packages/api/src/moderation-queue.ts`, `packages/api/src/moderation-appeals.ts`,
`packages/api/src/moderation-actions.ts`, `packages/db/src/schema/app.ts`

1. **Report.** `moderation.report` writes a row keyed
   `(reporterId, targetType, targetId)`. A repeat report refreshes the
   timestamp and keeps the first reason, so a resolved case reopens.
2. **Queue.** `moderation.queue` merges unresolved report groups with open
   appeals in JS behind a single keyset cursor. It is the one paginated list
   that does not go through `keysetPage`, because the merge does not fit the
   single-query skeleton; each side carries a correlated not-exists exclusion
   so a dual report-and-appeal case is never emitted twice.
3. **Action.** Removals and suspensions are `moderatorProcedure`; bans, role
   changes, the team view and the audit log are `staffProcedure`. Every action
   is one effect in `packages/api/src/moderation-actions.ts`
   (`removePostEffect`, `suspendUserEffect`, `banUserEffect`, `setRoleEffect`):
   the effect owns its transaction, its `FOR UPDATE` guard read, the report
   stamps, the audit row, and the notice it owes — the procedure sends that
   notice only after the effect's transaction has committed.
4. **Audit.** `moderation_action` is append-only. Every effect — forward and
   inverse (`restorePostEffect`, `unbanEffect`, `restoreRoleEffect`) — reads
   its guard `FOR UPDATE` inside its own transaction: an unlocked pre-read is
   a TOCTOU that two concurrent restores both pass and both log, and a double
   log is a lie about what happened. The role overturn checks the contested
   grant under that same lock, so a racing role change can never be clobbered
   by an appeal that already passed its currency check. A rollback produces no
   audit row, no partial state change and no email: the notices are returned,
   never sent from inside the transaction.
5. **Appeal.** `moderation.appealOpen` takes either an HMAC-signed token from
   the notification email (works signed out — a banned user cannot sign in) or
   a `postId` from a signed-in author's removed-post stub. `appealReview`
   excludes the moderator who took the original action.

## Schemas and migrations

**Source of truth:** `packages/db/src/schema`, `packages/db/drizzle.config.ts`,
`apps/server/src/migrate.ts`

The schema is split in two and joined by a barrel:

- `packages/db/src/schema/app.ts` — hand-written: `post`, `post_like`,
  `follow`, `report`, `user_block`, `moderation_action`, `appeal`.
- `packages/db/src/schema/auth.ts` — generated by the better-auth CLI:
  `user`, `session`, `account`, `verification`, `two_factor`, `passkey`,
  `rate_limit`. App tables must never move into this file; regenerating would
  wipe them.

Lifecycle: edit the schema → `pnpm db:generate` writes SQL and a snapshot into
`packages/db/drizzle` → commit both → apply with `pnpm db:push` locally, or by
the pre-deploy runner in production. `pnpm --filter @my-tuums/db db:check`
catches a schema edit that never had a migration generated.

Migrations run as a pre-deploy step, never at server boot: N replicas would
race the same DDL. The image ships `apps/server/dist/migrate.js` and the SQL
so Railway and `docker-compose.yml` run the identical runner.

## Test topology

**Source of truth:** `packages/api/vitest.config.ts`, `apps/web/vitest.config.ts`,
`e2e/playwright.config.ts`, `.github/workflows/ci.yml`

| Layer            | What runs                                                         | Needs                                         |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Unit             | `*.test.ts(x)` — pure logic, atoms, components                    | nothing; must pass with no database reachable |
| Integration      | `*.int.test.ts` in `packages/api`                                 | real Postgres, `fileParallelism: false`       |
| E2E              | Playwright `setup` / `api` / `chromium` projects                  | real server, real Postgres, optional bucket   |
| Docker           | CI builds the image, asserts its contents, boots it and probes it | a Postgres service                            |
| Production smoke | `.github/workflows/smoke.yml` probes the live domain              | nothing                                       |

The unit/integration split is enforced by CI giving the `unit` job no database
service. The `docker` job is the only place the production artefact is ever
started; the E2E suite runs the dev server.

## Further reading

- [product.md](product.md) — what the app does, and the words for it.
- [operations.md](operations.md) — environments, deploys, CI.
- [security.md](security.md) — trust boundaries and sensitive invariants.
