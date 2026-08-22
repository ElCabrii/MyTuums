# packages/api context

## Responsibility

The oRPC contract and the business rules behind it: every procedure the server
mounts at `/rpc`, plus the pure logic they are built from — keyset cursors,
rate-limit policies, image acceptance, media URLs, the role hierarchy, the
visibility filters and the moderation effects.

Source-only: tsup inlines it into the server bundle. The web app talks to it
over HTTP and imports only its browser-safe subpaths.

## Start here

| File                        | Why                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/router.ts`             | The five groups and what owns each.                                                                                                                                                      |
| `src/procedures.ts`         | The four gates, the legal consent gate, the two rate-limit mechanisms, the one exception.                                                                                                |
| `src/context.ts`            | What every handler is handed, and why nothing is a module global.                                                                                                                        |
| `src/pagination.ts`         | The keyset skeleton every paginated list is built from.                                                                                                                                  |
| `src/visibility.ts`         | The one filter that keeps banned and blocked content from leaking.                                                                                                                       |
| `src/moderation-actions.ts` | The forward and inverse moderation effects: transaction, guards, audit, owed notices. The one entry point (`applyModerationEffect`) and the per-action wrappers own "commit, then send". |
| `src/appeal-intake.ts`      | The appeal intake lifecycle: the two sources, the budgets, the gates, the replay policy.                                                                                                 |
| `src/profile-media.ts`      | The avatar/banner lifecycle: replace/remove, the locked swap, best-effort cleanup.                                                                                                       |

## Change map

| Intent                                | Primary                                                                                  | Also touch                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Add a procedure                       | the group's file (`src/posts.ts`, `src/users.ts`, `src/search.ts`, `src/moderation*.ts`) | `src/router.ts` if it is a new group; an `.int.test.ts`                                 |
| Add a paginated list                  | `src/pagination.ts` (`keysetPage`) at the call site                                      | a matching index in `packages/db/src/schema/app.ts`                                     |
| Change a rate limit                   | `src/rate-limit.ts` (`RATE_LIMITS`)                                                      | `src/rate-limit.test.ts`                                                                |
| Change the public profile shape       | `src/users.ts` (`publicUserColumns`)                                                     | `src/users.int.test.ts` pins it — read the invariant first                              |
| Add a moderation action               | `src/moderation-actions.ts` (the effect) and `src/moderation.ts` (the procedure)         | `src/constants.ts` (action code), `docs/product.md` glossary                            |
| Change the queue or a case view       | `src/moderation-queue.ts`                                                                | `src/moderation-inputs.ts` if the input shape moves                                     |
| Change how an appeal is opened        | `src/appeal-intake.ts` (`openAppeal`), `src/appeal-token.ts`                             | `src/appeal-intake.int.test.ts`; `docs/security.md` — this is the one anonymous surface |
| Change how an appeal is reviewed      | `src/moderation-appeals.ts` (`appealReview`)                                             | `src/moderation-actions.ts` if the inverse effect changes                               |
| Change upload rules                   | `src/image.ts`, `src/constants.ts` (`IMAGE_LIMITS`)                                      | `src/image.test.ts`; `src/dimensions.ts` for a new format                               |
| Change the upload/remove lifecycle    | `src/profile-media.ts`                                                                   | `src/profile-media.int.test.ts`; `src/users.ts` only if the procedure shape changes     |
| Change media URLs or caching          | `src/media.ts`, `src/storage.ts`                                                         | `apps/server/src/request-handler.ts`                                                    |
| Add a shared constant for the web app | `src/constants.ts`                                                                       | must stay free of `@my-tuums/db`                                                        |
| Change an account rule                | `../auth/src/rules.ts`                                                                   | not `src/constants.ts` — see the invariant below                                        |

## Invariants

- **The rate limiter, storage client, and email sender are threaded on `Context`,
  never module globals.** Tests substitute all three; one suite's limiter state
  must not bleed into another's, and moderation tests record delivery through
  the same sender interface production uses.
- **`rateLimit` keys on `user:<id>`; `rateLimitCapability` keys on a
  capability.** Do not describe limiting here as uniformly per-user.
  `rateLimitCapability` is what throttles `moderation.appealOpen`
  (`appeal:<nonce>` or `appeal:<actionId>`) and is deliberately not a
  middleware — the key only exists after the handler's own branch work.
- **`baseProcedure` has exactly one consumer.** `moderation.appealOpen` is the
  app's one anonymous surface, and it is HMAC-capability-gated because a
  banned user cannot sign in to appeal. Anything else built on it is a bug.
- **`protectedProcedure` carries the legal consent gate.** An account whose
  recorded acceptance is absent or names a superseded version is refused
  FORBIDDEN, because `packages/auth`'s create hook can only cover
  `/sign-up/email` — an OAuth or passkey sign-up has nowhere to put a
  checkbox, so those accounts exist before anyone can be asked. It lives on
  the gate every procedure is built from rather than on the ones someone
  remembered to mark, and `hasCurrentLegalConsent` in `@my-tuums/auth/rules`
  is the single reader the web dialog shares. Accepting, the `/welcome` claim,
  signing out and reading the documents all run outside oRPC, which is what
  keeps the gate from locking out the very people it is asking.
- **Appeal intake lives in `src/appeal-intake.ts`, and only there.**
  `moderation.appealOpen` validates its input shape and calls `openAppeal`;
  it owns nothing else. The module treats the email link and the removed-post
  stub as two source adapters — each authenticates its own claim and spends
  its own capability budget (`appeal:<nonce>`, `appeal:<actionId>`) — and
  normalises both to one target, after which the appealable/current/latest
  gates, the replay policy and the insert are source-blind. The ordering is
  load-bearing: the HMAC comparison happens before any database work, each
  budget is consumed at the exact point its key comes into existence, and the
  common tail locks the contested `moderation_action` through validation and
  insert. Intake never sends a notice and never reverses an action — that is
  `appealReview`'s half, in `src/moderation-appeals.ts`.
- **Appeal intake is exactly-once at two layers.** The action-row lock
  serializes concurrent application opens before their replay read. The
  unique `token_nonce` and partial unique open-per-action indexes remain the
  database authority for outside writers and collisions; `isUniqueViolation`
  walks Drizzle's wrapped `cause` chain so a constraint rejection still reads
  as a caller-facing refusal.
- **`publicUserColumns` is a privacy boundary.** Never add `email`,
  `twoFactorEnabled`, `lastLoginMethod`, `role` or a preference column; sign-in
  method is reconnaissance, not profile data. `src/users.int.test.ts` pins the
  exact shape.
- **Every surface filters through `src/visibility.ts`.** `invisibleUser` is the
  stricter of the two per-user filters — it is what lets a banned-but-not-blocked
  profile resolve to its suspended stub instead of 404ing.
- **`like`/`unlike` and `follow`/`unfollow` are separate idempotent
  procedures, never a toggle** — ordering and retry safety.
- **A post has two independent tombstones, and neither is a row delete.**
  `moderation.removePost` stamps `removed_at`; `post.delete` (the author's own,
  issue #148) stamps `deleted_at`. `postSelection` nulls the content for
  either, and `search.posts` excludes both rows outright — it matches the raw
  `content` column, which no projection touches, so a tombstoned post's text
  would otherwise stay probeable. Keeping the row is what lets replies, likes
  and the thread above survive, and it is why `post.parent_id` can still
  cascade. `post.delete` is deliberately NOT a moderation effect: no
  transaction, no `FOR UPDATE`, no `moderation_action` row, no email, nothing
  appealable — it is author-owned and idempotent, and it refuses a post a
  moderator already removed so the author keeps the stub's reason and appeal
  link. Its unlocked read/write pair is safe because the update compares both
  tombstones; after losing to a concurrent delete or removal, it re-reads the
  winner and preserves that outcome.
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
- **`scripts/reconcile-media.ts` must list the bucket BEFORE reading the
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
  instead of sending them. The module's single entry point
  (`applyModerationEffect`, and the per-action wrappers `removePost`,
  `restorePost`, `suspendUser`, `banUser`, `unbanUser`, `setRole`) opens the
  transaction itself, runs the effect inside it, and sends the owed notices
  only after it commits — so a rollback produces no audit row, no partial
  state and no email, and the send can never be forgotten by a caller that
  goes through the wrappers. The raw effects remain exported for the appeal
  intake and the tests, which compose them directly; a new procedure must go
  through the wrappers, not call an effect and hand-thread the send.
- **A manual inverse action closes appeals under a shared action lock.** The
  `restorePost`, `unbanUser` and `setRole` wrappers lock the contested action
  rows, then stamp linked open appeals `reversed`, then lock/change the target,
  all in one transaction. Intake takes the same action lock through its insert,
  so reversal cannot miss an appeal being created. The wrappers do not fill
  review fields or log `appeal_resolved`; the inverse action's audit row and
  notice are the source of truth. The remaining appeal-before-target order
  matches `appealReview`, avoiding a review/reversal deadlock.
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
- **`src/constants.ts`, `src/dimensions.ts` and `src/roles.ts` must stay
  dependency-free.** The browser imports them; an `@my-tuums/db` import throws
  at module load.
- **Account rules are not this package's to state.** The handle bounds, the bio
  limit, the date-of-birth rules and the preference lists live in
  `packages/auth/src/rules.ts` (`@my-tuums/auth/rules`), because `packages/auth`
  is where they are enforced. `usernameInput` in `src/users.ts` reads the bounds
  from there rather than repeating `3`/`20`, and `src/constants.ts` deliberately
  no longer carries a `BIO_MAX_LENGTH` copy — that copy existed only because
  the browser had no other dependency-free module to read, and it needed a
  drift test to stay honest. Re-adding one here re-creates the drift.
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
