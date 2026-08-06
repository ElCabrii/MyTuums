# packages/api — CLAUDE.md

## What this is

The oRPC contract for MyTuums: `appRouter` (`me`, `post`, `user`) — the
procedures `apps/server` mounts under `/rpc` — plus the pure logic they are
built from: keyset cursors, rate limiting, image acceptance, media URLs.
Source-only package (tsup inlines it into the server bundle); the web app
talks to it over `/rpc` and imports only the browser-safe subpaths, never
the root — see `src/constants.ts` for why.

## Key files

- `src/router.ts` — `appRouter` + `AppRouter`; `me` lives here, `post`/`user` are posts.ts/users.ts. No RPC-level health check, on purpose.
- `src/posts.ts` — `post.create` / `list` / `thread` / `like` / `unlike`; `postSelection` is the single projection feeds and threads share.
- `src/users.ts` — `byUsername` / `uploadImage` / `removeImage` / `follow` / `unfollow` / `followers` / `following`; `publicUserColumns` is the privacy boundary.
- `src/search.ts` — `search.typeahead` / `users` / `posts`; `escapeLikePattern` keeps user input literal against LIKE wildcards.
- `src/procedures.ts` — `protectedProcedure` and the `rateLimit(policy)` middleware. No `publicProcedure` — every procedure requires a session (issue #36).
- `src/context.ts` — the `Context` shape and `createContext`; owns the one process-wide rate limiter and storage client.
- `src/cursor.ts` — opaque base64url keyset cursors, parameterised on the tie-breaker's id schema.
- `src/rate-limit.ts` — in-memory fixed-window limiter and the `RATE_LIMITS` tiers.
- `src/storage.ts` — S3 factory; `Storage` vs `DestructiveStorage` split; windowed presigned URLs.
- `src/media.ts` — the `/media/<key>` resolver: presigned redirect + cache budget. A pure key→URL function with no session logic of its own — `apps/server/src/request-handler.ts` requires a live session before this is ever called.
- `src/image.ts` — pure upload rules: type sniffing, bounds, key layout, the `isSafeObjectKey` path-traversal guard.
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
- **Fixed-window, in-memory limits** reset on deploy and multiply per replica; right for bounding one client, wrong for billing. If that changes, keep the `consume` interface. `maxKeys` is a hard bound — at capacity a brand-new key is refused.
- **`like` / `follow` are separate idempotent procedures**, not a `toggle`: ordering and retry safety.
- **Replies are a mode of `post.list` (`parentId`)**, not a separate procedure — the web app's optimistic like sweep covers every cached `post.list` by key prefix, so a separate procedure would miss reply likes.
- **`publicUserColumns` is a privacy boundary**: email, `twoFactorEnabled`, `lastLoginMethod` and preferences must never be added (`users.int.test.ts` pins the exact shape).
- **Upload order matters**: row write before object delete; display + original share one uuid (`.orig` infix); `objectKeyFromMediaPath` returns `null` for provider URLs; leaks are reaped by `scripts/reconcile-media.mjs`.
- **Cursor bounds go through `sql.param(value, column)`** — interpolating a JS `Date` hands postgres.js something it can't serialise.
- **Presigned URLs are windowed** (`MEDIA_SIGNING_WINDOW_MS`): byte-identical within a window — what makes the object cache work; redirects must not be cached past `secondsUntilWindowEnd()`.

## Commands

- `pnpm --filter @my-tuums/api test:unit` — pure logic, must pass with no DB.
- `pnpm --filter @my-tuums/api test:integration` — real Postgres (run `pnpm docker:up` first); `fileParallelism: false` is deliberate.
- `pnpm --filter @my-tuums/api lint` / `typecheck`
- `pnpm --filter @my-tuums/api reconcile:media` — delete objects the rows no longer point at.
