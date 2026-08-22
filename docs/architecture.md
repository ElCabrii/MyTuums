# Architecture

How the workspaces fit together and what actually happens at runtime. For
"where do I make this change", start from [CONTEXT.md](../CONTEXT.md); for
behaviour and vocabulary, [product.md](product.md).

## Workspace ownership and dependency direction

**Source of truth:** `pnpm-workspace.yaml`, each package's `package.json`,
`turbo.json`

Dependencies point one way. `apps/web` and `apps/server` are leaves; nothing
imports them.

```
apps/web ──▶ packages/api, packages/auth (browser-safe subpaths only)
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

`apps/web` may import four workspace modules and no others:
`@my-tuums/api/constants`, `@my-tuums/api/dimensions`, `@my-tuums/api/roles`
and `@my-tuums/auth/rules`. All four must stay free of `@my-tuums/db`, which reads
`DATABASE_URL` at module scope and throws in a browser.

The `packages/auth` edge is the one that looks surprising, so it is worth
stating why it does not weaken the direction above. `@my-tuums/auth/rules`
(`packages/auth/src/rules.ts`) is the single statement of the account rules —
handle bounds, charset and lowercase normalization, the date-of-birth parse and
age comparison, the bio limit, the preference lists, and the English rejection
strings — and it is the only file in that package with **no imports at all**.
Reaching it does not construct the better-auth instance, read any env, or touch
`@my-tuums/db`; the production bundle contains exactly those four workspace
modules and nothing else from the packages. It lives in `packages/auth` because
that is where the rules are _enforced_ (the database hooks are the only place a
user-field rule actually holds) and because `packages/api` already depends on
`packages/auth` — putting the shared statement in `packages/api` instead would
force `packages/auth` to import it, closing a cycle.

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

User-field rules are enforced by the `databaseHooks` in
`packages/auth/src/dob.ts`, `packages/auth/src/profile.ts` and
`packages/auth/src/legal.ts` — the only place they hold, because these columns
are bare `text` and the browser's checks are skippable. Those hooks are thin:
the rules themselves live in
`packages/auth/src/rules.ts`, which the browser reads too, so the hook and the
form cannot come to disagree about what a valid handle, bio or date of birth
is. What stays in the hooks is what only a server does — turning a violation
into an `APIError`, permitting an absent date of birth (OAuth sign-ups arrive
with none), requiring legal acceptance on the email/password sign-up path
(`create.before` only — the update hook has to stay open for the writes
sign-up makes to its own row), and refusing the client image writes only the
upload procedure may make.

Legal acceptance is the one rule with a second enforcement point, because the
hook cannot reach every account that needs it: an OAuth or passkey sign-up has
nowhere to present a checkbox, so it creates an account before anyone can be
asked, and accounts predating the record have the same shape. So
`protectedProcedure` in `packages/api/src/procedures.ts` refuses any caller
whose record is absent or names a superseded version. The two enforcement
points read one predicate — `hasCurrentLegalConsent` in
`packages/auth/src/rules.ts` — which the web app's consent dialog reads too, so
the hook, the gate and the browser cannot disagree about who still owes an
acceptance. Everything that gate leaves reachable sits outside oRPC on
purpose: accepting and the `/welcome` claim go through the auth client, and
signing out and reading the documents touch no procedure at all.

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
`packages/api/src/media.ts`, `packages/api/src/reconcile-media.ts`,
`apps/web/src/lib/media.ts`

- **Crop is baked, not stored.** The browser re-encodes every picked file into
  a display variant (`apps/web/src/lib/media.ts`) and uploads it beside the
  untouched original. The crop/reposition editor
  (`apps/web/src/components/settings/image-crop-dialog.tsx`) chooses the
  visible region _before_ that encode, so the choice lands in the display
  object's pixels — there is deliberately **no crop column and no server-side
  crop state**. Everything that renders a profile image reads the same display
  object, which is what makes the crop consistent across the profile, header,
  post cards and settings preview for free. Re-cropping means re-uploading;
  the retained original is what makes that lossless. The server is unaffected:
  it validates the display object on its own bounds, exactly as before.
- **Avatars have a canonical 1:1 composition.** The crop editor and encoder
  share `calculateCropFrame`, which selects the same centered square at zoom 1
  for portrait and landscape sources. Applying an untouched crop therefore
  matches the no-crop encode, while pan and zoom change the square that every
  avatar surface renders without a second hidden `object-cover` crop. Only the
  display variant is square-cropped; the original remains untouched for a
  future refit.
- **Banners have a canonical 3:1 source and a responsive display crop.** At
  zoom 1 the editor rectangle is exactly the region the encoder stores
  (`calculateCropFrame`), so applying without adjusting anything is a no-op.
  The profile remains `w-full` behind a fixed `h-48 sm:h-64` frame and uses
  `object-cover`; consequently narrow layouts may hide the source's sides and
  wide layouts may hide its top and bottom. The editor outlines the center
  safe area shared by common 320px-phone through 1920px-desktop frames, making
  that responsive tradeoff visible before upload. The stored variant can reach
  3840x1280 for a sharp 2x sample on a 1920px display.
- **The pre-decode guards run at file pick, not just at encode.**
  `validateImageFile` owns the type, byte-cap and header megapixel checks, and
  the editor calls it before it decodes anything. The megapixel ceiling is the
  load-bearing one: a ~200 KB PNG declaring 400 MP allocates about a gigabyte
  on decode, so an editor that measured the source first would freeze the tab
  merely on selection.
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
`packages/api/src/moderation-queue.ts`, `packages/api/src/appeal-intake.ts`,
`packages/api/src/moderation-appeals.ts`,
`packages/api/src/moderation-actions.ts`, `packages/db/src/schema/app.ts`

1. **Report.** `moderation.report` writes a row keyed
   `(reporterId, targetType, targetId)`. A repeat report refreshes the
   timestamp and keeps the first reason, so a resolved case reopens.
2. **Queue.** `moderation.queue` merges unresolved report groups with open
   appeals in JS behind a single keyset cursor. It is the one paginated list
   that does not go through `keysetPage`, because the merge does not fit the
   single-query skeleton; each side carries a correlated not-exists exclusion
   so a dual report-and-appeal case is never emitted twice. Each case then
   carries a `preview` of its target — the reported post's author and a
   bounded excerpt, or the reported account and its effective ban state —
   loaded for the page after the merge and the slice, so a row says which
   case to open rather than only how many are waiting.
3. **Action.** Removals and suspensions are `moderatorProcedure`; bans, role
   changes, the team view and the audit log are `staffProcedure`. Every action
   is one effect in `packages/api/src/moderation-actions.ts`
   (`removePostEffect`, `suspendUserEffect`, `banUserEffect`, `setRoleEffect`):
   the effect owns its `FOR UPDATE` guard read, the report stamps, the audit
   row, and the notice it owes. The module's single entry point —
   `applyModerationEffect`, wrapped per-action as `removePost`, `restorePost`,
   `suspendUser`, `banUser`, `unbanUser`, `setRole` — opens the transaction,
   runs the effect inside it, and sends the owed notices only after it
   commits, so the procedures pass `Context` once and never touch the notices
   themselves.
4. **Audit.** `moderation_action` is append-only. Every effect — forward and
   inverse (`restorePostEffect`, `unbanEffect`, `restoreRoleEffect`) — reads
   its guard `FOR UPDATE` inside its own transaction: an unlocked pre-read is
   a TOCTOU that two concurrent restores both pass and both log, and a double
   log is a lie about what happened. The role overturn checks the contested
   grant under that same lock, so a racing role change can never be clobbered
   by an appeal that already passed its currency check. A rollback produces no
   audit row, no partial state change and no email: the notices are returned,
   never sent from inside the transaction, and `applyModerationEffect` sends
   them only after the owning transaction commits.
5. **Appeal intake.** `moderation.appealOpen` is a thin procedure over
   `packages/api/src/appeal-intake.ts`, which owns the whole intake lifecycle.
   The email link (an HMAC-signed token, works signed out — a banned user
   cannot sign in) and the signed-in author's removed-post stub are two source
   adapters: each authenticates its own claim and spends its own
   capability-keyed budget, and both normalise to one internal target — the
   contested action, its appellant, and the nonce that makes the attempt
   replayable exactly once. Everything after that is source-blind and one
   transaction: lock the contested action row, prove it appealable, still
   current and still latest, refuse a replay, then insert. The action lock is
   shared with manual reversal; database uniqueness remains the final backstop.
   Intake sends no email and changes no moderation state.
6. **Appeal review.** `moderation.appealReview` upholds or overturns, in one
   transaction with the inverse effect and the `appeal_resolved` audit row,
   and excludes the moderator who took the original action. It runs that
   transaction through `applyModerationEffect`, so the overturn's notices go
   out after the REVIEW's commit — never an inner savepoint.
7. **Manual reversal.** Restoring a post, unbanning or unsuspending an account,
   or changing a role that an open appeal contests stamps that appeal
   `reversed` in the same transaction. The wrapper first locks the contested
   action rows — the same synchronization point appeal intake holds through
   insert — then the appeal and target. It leaves the review fields empty and
   does not add an `appeal_resolved` row because no appeal review occurred;
   the inverse action's audit row and post-commit email record what happened.

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

Handle canonicalisation is also enforced by the database trigger installed in
`0015_lowercase_usernames`: `username` is lowercased and `display_username` is
derived from it on every handle write. This closes the pre-deploy interval in
which Railway still routes traffic to the previous application version, and
keeps direct database writers from splitting the two representations.

## Test topology

**Source of truth:** `packages/api/vitest.config.ts`, `apps/web/vitest.config.ts`,
`e2e/playwright.config.ts`, `.github/workflows/ci.yml`

| Layer       | What runs                                                         | Needs                                         |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------- |
| Unit        | `*.test.ts(x)` — pure logic, atoms, components                    | nothing; must pass with no database reachable |
| Integration | `*.int.test.ts` in `packages/api`                                 | real Postgres, `fileParallelism: false`       |
| E2E         | Playwright `setup` / `api` / `chromium` projects                  | real server, real Postgres, optional bucket   |
| Docker      | CI builds the image, asserts its contents, boots it and probes it | a Postgres service                            |

The unit/integration split is enforced by CI giving the `unit` job no database
service. The `docker` job is the only place the production artefact is ever
started; the E2E suite runs the dev server.

## Further reading

- [product.md](product.md) — what the app does, and the words for it.
- [operations.md](operations.md) — environments, deploys, CI.
- [security.md](security.md) — trust boundaries and sensitive invariants.
