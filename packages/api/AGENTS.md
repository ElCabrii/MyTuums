# packages/api — agent guide

## Responsibility

The oRPC contract and the business rules behind it: every procedure the server
mounts at `/rpc`, plus the pure logic they are built from — keyset cursors,
rate-limit policies, image acceptance, media URLs, the role hierarchy, the
visibility filters and the moderation effects.

Source-only: tsup inlines it into the server bundle. The web app talks to it
over HTTP and imports only its browser-safe subpaths.

## Start here

| File                        | Why                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `src/router.ts`             | The five groups and what owns each.                                                   |
| `src/procedures.ts`         | The four gates, the two rate-limit mechanisms, the one exception.                     |
| `src/context.ts`            | What every handler is handed, and why nothing is a module global.                     |
| `src/pagination.ts`         | The keyset skeleton every paginated list is built from.                               |
| `src/visibility.ts`         | The one filter that keeps banned and blocked content from leaking.                    |
| `src/moderation-actions.ts` | The forward and inverse moderation effects: transaction, guards, audit, owed notices. |
| `src/profile-media.ts`      | The avatar/banner lifecycle: replace/remove, the locked swap, best-effort cleanup.    |

## Change map

| Intent                                | Primary                                                                                  | Also touch                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Add a procedure                       | the group's file (`src/posts.ts`, `src/users.ts`, `src/search.ts`, `src/moderation*.ts`) | `src/router.ts` if it is a new group; an `.int.test.ts`                             |
| Add a paginated list                  | `src/pagination.ts` (`keysetPage`) at the call site                                      | a matching index in `packages/db/src/schema/app.ts`                                 |
| Change a rate limit                   | `src/rate-limit.ts` (`RATE_LIMITS`)                                                      | `src/rate-limit.test.ts`                                                            |
| Change the public profile shape       | `src/users.ts` (`publicUserColumns`)                                                     | `src/users.int.test.ts` pins it — read the invariant first                          |
| Add a moderation action               | `src/moderation-actions.ts` (the effect) and `src/moderation.ts` (the procedure)         | `src/constants.ts` (action code), `docs/product.md` glossary                        |
| Change the queue or a case view       | `src/moderation-queue.ts`                                                                | `src/moderation-inputs.ts` if the input shape moves                                 |
| Change the appeal flow                | `src/moderation-appeals.ts`, `src/appeal-token.ts`                                       | `docs/security.md` — this is the one anonymous surface                              |
| Change upload rules                   | `src/image.ts`, `src/constants.ts` (`IMAGE_LIMITS`)                                      | `src/image.test.ts`; `src/dimensions.ts` for a new format                           |
| Change the upload/remove lifecycle    | `src/profile-media.ts`                                                                   | `src/profile-media.int.test.ts`; `src/users.ts` only if the procedure shape changes |
| Change media URLs or caching          | `src/media.ts`, `src/storage.ts`                                                         | `apps/server/src/request-handler.ts`                                                |
| Add a shared constant for the web app | `src/constants.ts`                                                                       | must stay free of `@my-tuums/db`                                                    |

## Invariants

- **The rate limiter and the storage client are threaded on `Context`, never
  module globals.** Tests substitute both; one suite's limiter state must not
  bleed into another's.
- **`rateLimit` keys on `user:<id>`; `rateLimitCapability` keys on a
  capability.** Do not describe limiting here as uniformly per-user.
  `rateLimitCapability` is what throttles `moderation.appealOpen`
  (`appeal:<nonce>` or `appeal:<actionId>`) and is deliberately not a
  middleware — the key only exists after the handler's own branch work.
- **`baseProcedure` has exactly one consumer.** `moderation.appealOpen` is the
  app's one anonymous surface, and it is HMAC-capability-gated because a
  banned user cannot sign in to appeal. Anything else built on it is a bug.
- **`publicUserColumns` is a privacy boundary.** Never add `email`,
  `twoFactorEnabled`, `lastLoginMethod`, `role` or a preference column; sign-in
  method is reconnaissance, not profile data. `src/users.int.test.ts` pins the
  exact shape.
- **Every surface filters through `src/visibility.ts`.** `invisibleUser` is the
  stricter of the two per-user filters — it is what lets a banned-but-not-blocked
  profile resolve to its suspended stub instead of 404ing.
- **`like`/`unlike` and `follow`/`unfollow` are separate idempotent
  procedures, never a toggle** — ordering and retry safety.
- **Replies are a mode of `post.list` (`parentId`), not their own procedure.**
  The web app's optimistic like sweep covers every cached `post.list` by key
  prefix; a separate procedure would miss reply likes.
- **The profile-media lifecycle lives in `src/profile-media.ts`, and only
  there.** `user.uploadImage` and `user.removeImage` call
  `replaceProfileMedia`/`removeProfileMedia` and own nothing else: the
  prepare-write-swap-discard ordering, the `FOR UPDATE` row lock, the
  avatar/banner pair-key mapping and the best-effort cleanup are the
  module's, so the two procedures cannot drift. The display and original
  variants share one uuid with an `.orig` infix, and `objectKeyFromMediaPath`
  returns `null` for provider URLs — cleanup never touches them. Without the
  row lock, two racing replacements could both read the same old keys and
  each delete them after its own swap, orphaning the pair the first to
  commit wrote. The lifecycle interface accepts the bare `Database` handle,
  not a transaction handle, so its swap commits before object cleanup begins.
- **`scripts/reconcile-media.mjs` must list the bucket BEFORE reading the
  `user` rows.** The reverse order treats an upload landing between the two
  steps as an orphan and deletes an object whose row points at it (issue #52;
  pinned by `src/reconcile-media.test.ts`).
- **Every moderation effect reads its guard `FOR UPDATE`, inside its own
  transaction** (`removePostEffect`, `suspendUserEffect`, `banUserEffect`,
  `setRoleEffect`, `restorePostEffect`, `unbanEffect`, `restoreRoleEffect`).
  The audit log is append-only, so a double log is a lie about what happened;
  an unlocked pre-read is a TOCTOU two concurrent restores both pass (issue
  #51). The role overturn checks the contested grant under that same lock, so
  a racing role change can never be clobbered by an appeal that already passed
  its currency check. The effects return the notices they owe (`PendingEmail`)
  instead of sending them — the procedure sends after the commit, so a
  rollback produces no audit row, no partial state and no email.
- **Cursor bounds go through `sql.param(value, column)`.** Interpolating a JS
  `Date` hands postgres.js something it cannot serialise.
- **`keysetPage`'s `createdAtField` is type-tied to the `createdAt` column**, so
  a cursor can never encode a different timestamp than the SQL compares. One
  list bypasses the skeleton on purpose: `moderation.queue` merges two shapes
  in JS, which does not fit a single query.
- **Presigned URLs are windowed** (`MEDIA_SIGNING_WINDOW_MS`): byte-identical
  within a window, which is what makes object caching work. Redirects must not
  be cached past `secondsUntilWindowEnd()`.
- **Signed appeal tokens have a 4 KiB input ceiling and a canonical signature.**
  Reject oversized or malformed base64url input before decoding or hashing so
  the one anonymous procedure cannot turn attacker-controlled strings into
  unbounded work.
- **Bulk deletion trusts only provider-confirmed `Deleted` entries.** An HTTP
  success may still include per-key S3 failures or omit an acknowledgement;
  preserve the confirmed count and throw `StorageDeleteError` for every
  requested key not confirmed as deleted.
- **PostgreSQL owns suspension expiry time.** `suspendUser` returns the
  `banExpires` value from the update and uses that exact timestamp in both the
  response and notification; do not calculate a second application-clock
  value.
- **Fixed-window, in-memory limits** reset on deploy and multiply per replica —
  right for bounding one client, wrong for billing. `maxKeys` is a leak alarm,
  not an admission gate: at capacity a brand-new key is let through, never
  refused (issue #60).
- **`src/constants.ts` and `src/dimensions.ts` must stay dependency-free.** The
  browser imports them; an `@my-tuums/db` import throws at module load.
- **`src/moderation-inputs.ts` is a leaf on purpose.** The moderation router
  files must never import each other — a cycle fails at module evaluation.

## Dependencies and boundaries

- `Context.session` comes from `@my-tuums/auth`; `db` and the schema from
  `@my-tuums/db`. `apps/server` mounts `appRouter` at `/rpc` and serves
  `/media` through `createMediaResolver`.
- `src/media.ts` is a pure key-to-URL function with no session logic of its
  own — the server requires a live session before it is ever called.

## Verification

| Command                                          | Covers                                 |
| ------------------------------------------------ | -------------------------------------- |
| `pnpm --filter @my-tuums/api test:unit`          | pure logic; must pass with no database |
| `pnpm --filter @my-tuums/api test:integration`   | real Postgres (`pnpm docker:up` first) |
| `pnpm --filter @my-tuums/api lint` / `typecheck` | this package alone                     |
| `pnpm --filter @my-tuums/api reconcile:media`    | reap objects no row points at          |

Suites split by filename: `*.test.ts` is unit (no I/O), `*.int.test.ts` is
integration. `fileParallelism: false` is deliberate — the harness in
`src/testing/harness.ts` shares one pool and one truncate.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — context, media and moderation flows.
- [docs/security.md](../../docs/security.md) — the anonymous surface, rate-limit keys, privacy projection.
- [docs/product.md](../../docs/product.md) — the vocabulary these procedures implement.
