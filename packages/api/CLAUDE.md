# packages/api — CLAUDE.md

## What this is

The oRPC contract for MyTuums: `appRouter` (`me`, `post`, `user`) — the
procedures `apps/server` mounts under `/rpc` — plus the pure logic they are
built from: keyset cursors, rate limiting, image acceptance, media URLs.
Source-only package (tsup inlines it into the server bundle); the web app
talks to it over `/rpc` and imports only the browser-safe subpaths, never
the root — see `src/constants.ts` for why.

## Key files

- `src/router.ts` — `appRouter` + `AppRouter`; `me` lives here, `post`/`user` are posts.ts/users.ts, `moderation` is moderation.ts. No RPC-level health check, on purpose.
- `src/posts.ts` — `post.create` / `list` / `thread` / `like` / `unlike`; `postSelection` is the single projection feeds and threads share.
- `src/users.ts` — `byUsername` / `uploadImage` / `removeImage` / `follow` / `unfollow` / `followers` / `following`; `publicUserColumns` is the privacy boundary. `byUsername` resolves banned profiles with `suspended: true` (the profile stub's contract) and 404s blocked ones.
- `src/search.ts` — `search.typeahead` / `users` / `posts`; `escapeLikePattern` keeps user input literal against LIKE wildcards.
- `src/procedures.ts` — `protectedProcedure` and the `rateLimit(policy)` middleware, plus the role gates (`moderatorProcedure` / `staffProcedure` / `adminProcedure`) and ONE deliberate exception: `baseProcedure`, used only by `moderation.appealOpen` — a banned user cannot sign in, so the HMAC-capability appeal link must work signed-out (issue #36's "no anonymous surface" holds everywhere else). `rateLimitCapability(context, policy, key)` is the session-less sibling of `rateLimit`, keyed on a capability the caller presented instead of `user:<id>`; `appealOpen` calls it from its handler (the key only exists after the handler's own branch work, so it cannot be a middleware).
- `src/moderation.ts` — the moderation router (issue #38): reports, blocks, the merged queue, case actions, the audit log, and the two appeal procedures. The queue merges report groups and open appeals in JS with a single keyset cursor; each side carries a correlated not-exists exclusion so a dual report+appeal case is never re-emitted across pages.
- `src/moderation-actions.ts` — the shared effects every moderation procedure composes: `logAction` / `stampReports` / `emailUser` / the inverses (`restorePostEffect` / `unbanEffect` / `undoAction`). The rank guard lives here, on the inverse paths, so no restore can skip it. The action-code constants are defined in constants.ts and re-exported here.
- `src/appeal-token.ts` — the HMAC-SHA256 signed-out appeal link signer/verifier (constant-time, zod re-parse, 7-day TTL); `BETTER_AUTH_SECRET`-keyed.
- `src/roles.ts` — `USER_ROLES`, `roleRank`, `roleAtLeast`, `canManageRole` (strictly-greater) — the hierarchy every gate and rank guard runs on.
- `src/visibility.ts` — `effectivelyBanned` / `invisibleAuthor` / `invisibleUser` / `visibleUser`: the one filter every surface applies so banned/blocked content cannot leak. `invisibleUser` is the stricter of the two per-user filters — what `users.byUsername` filters on so a banned-but-not-blocked profile still resolves to its suspended stub instead of 404ing.
- `src/context.ts` — the `Context` shape and `createContext`; owns the one process-wide rate limiter and storage client.
- `src/cursor.ts` — opaque base64url keyset cursors, parameterised on the tie-breaker's id schema.
- `src/rate-limit.ts` — in-memory fixed-window limiter and the `RATE_LIMITS` tiers (read/like/follow/write/upload/search/report/block/moderate).
- `src/storage.ts` — S3 factory; `Storage` vs `DestructiveStorage` split; windowed presigned URLs.
- `src/media.ts` — the `/media/<key>` resolver: presigned redirect + cache budget. A pure key→URL function with no session logic of its own — `apps/server/src/request-handler.ts` requires a live session before this is ever called.
- `src/image.ts` — pure upload rules: type sniffing, bounds, key layout, the `isSafeObjectKey` path-traversal guard.
- `src/reconcile-media.ts` — the reconcile-script core (`scripts/reconcile-media.mjs` is the guarded wrapper). Lists the bucket BEFORE reading the `user` rows, on purpose.
- `src/dimensions.ts` — dependency-free header-only dimension parser, also exported to the web app.
- `src/constants.ts` — browser-safe constants, also exported to the web app.
- `src/testing/harness.ts` — int-test harness: real BetterAuth sign-up, in-memory bucket, FK-safe truncate, per-test rate limiter.
- `vitest.config.ts` — `unit` / `integration` projects split by filename.

## How it connects

- `apps/server/src/request-handler.ts` mounts `appRouter` at `/rpc`, builds a `Context` per request via `createContext`, and serves `/media` through `createMediaResolver`.
- `Context.session` comes from `@my-tuums/auth`; `db` and the schema from `@my-tuums/db`.
- The web app imports `@my-tuums/api/constants` and `/dimensions` — those subpaths must stay dependency-free (no `@my-tuums/db`), or importing them in the browser throws at module load.

## Load-bearing decisions — do not break

- **Rate limiter and storage are threaded on `Context`, never module globals** — tests substitute both; one suite's rate-limit state must not bleed into another's.
- **Fixed-window, in-memory limits** reset on deploy and multiply per replica; right for bounding one client, wrong for billing. If that changes, keep the `consume` interface. `maxKeys` is a leak alarm, not an admission gate and not a memory bound — at capacity the map keeps growing regardless, it just logs about it (at most once per `capacityWarnCooldownMs`, a time-based cooldown, not a size-based latch: sweeping only runs from inside a full-map insert, so under sustained near-capacity traffic `buckets.size` wobbles across the threshold too fast for a "re-arm when it dips below" latch to mean "once per episode" — see the doc comment on `maxKeys` in rate-limit.ts). Since issue #36 removed the anonymous surface, the keyspace is bounded by registered users x 9 policies, plus however many `moderation.appealOpen` appeal capabilities (`rateLimitCapability`, keyed on `appeal:<nonce>`/`appeal:<actionId>`) are outstanding at once — all server-issued, none attacker-grown. At capacity a brand-new key is let through, never refused (issue #60 — refusing here used to 429 every request from a brand-new session, indistinguishable from a bug).
- **`like` / `follow` are separate idempotent procedures**, not a `toggle`: ordering and retry safety.
- **Replies are a mode of `post.list` (`parentId`)**, not a separate procedure — the web app's optimistic like sweep covers every cached `post.list` by key prefix, so a separate procedure would miss reply likes.
- **`publicUserColumns` is a privacy boundary**: email, `twoFactorEnabled`, `lastLoginMethod` and preferences must never be added (`users.int.test.ts` pins the exact shape).
- **Upload order matters**: row write before object delete; display + original share one uuid (`.orig` infix); `objectKeyFromMediaPath` returns `null` for provider URLs; leaks are reaped by `scripts/reconcile-media.mjs`, which must keep listing the bucket BEFORE reading the `user` rows — an upload landing between the two steps would otherwise look like an orphan and be deleted while its row points at it (issue #52; the order is pinned by `src/reconcile-media.test.ts`).
- **The inverse effects read their guard under `FOR UPDATE`, inside their own transaction** (`restorePostEffect` / `unbanEffect`): the audit log is append-only, so a double-log is a lie about what happened — an unlocked pre-read of the tombstone/sentence is a TOCTOU that two concurrent restores/unbans both pass and both log (issue #51). Moving the read back out of the transaction "for speed" re-opens the double-log.
- **Cursor bounds go through `sql.param(value, column)`** — interpolating a JS `Date` hands postgres.js something it can't serialise.
- **Presigned URLs are windowed** (`MEDIA_SIGNING_WINDOW_MS`): byte-identical within a window — what makes the object cache work; redirects must not be cached past `secondsUntilWindowEnd()`.

## Commands

- `pnpm --filter @my-tuums/api test:unit` — pure logic, must pass with no DB.
- `pnpm --filter @my-tuums/api test:integration` — real Postgres (run `pnpm docker:up` first); `fileParallelism: false` is deliberate.
- `pnpm --filter @my-tuums/api lint` / `typecheck`
- `pnpm --filter @my-tuums/api reconcile:media` — delete objects the rows no longer point at.
