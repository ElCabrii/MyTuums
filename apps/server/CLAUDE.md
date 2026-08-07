# CLAUDE.md

Guidance for working in `apps/server`, the Node HTTP server of the MyTuums monorepo. Read the root `CLAUDE.md` first — it owns the repo-wide rules and env gotchas.

## What this is

A plain `node:http` server (no framework) that terminates every request: health checks, better-auth (`/api/auth`), the oRPC API (`/rpc`), media redirects (`/media`), and — in production — the built SPA. It is the only process Railway runs (`node apps/server/dist/index.js`). The routing tree, the response decorator and the env gate are deliberately extracted from `index.ts` so each can be unit-tested without a socket, a database or a session.

## Key files

- `src/index.ts` — the real entrypoint: the one place a bad env becomes `process.exit(1)`, wiring of real dependencies into the routing tree, the `decorateResponse` wrapper, and graceful shutdown (SIGTERM/SIGINT/unhandledRejection/uncaughtException → drain the Postgres pool, exit; 5s force-exit backstop).
- `src/env.ts` — zod validation of every env var. Its `superRefine` catches half-configured OAuth providers and partial S3 groups at boot; `parseEnv` throws but never exits.
- `src/request-handler.ts` — the routing decision tree, unit-tested with stand-ins. Exact-match `/health`, `/api/auth` (with `/api/auth/admin/*` 404'd FIRST — the better-auth admin plugin's own endpoints are deliberately unreachable; every moderation action must go through `/rpc` so the rank hierarchy and the audit log are the only enforcement surface), `/rpc` (body cap before oRPC buffers — Content-Length at the router, chunked bounded by oRPC's `BodyLimitPlugin`), `/media` (GET/HEAD only, session required before the key is even parsed → presigned 302, or 401), then the page gate (every extension-less GET/HEAD not on `SIGNED_OUT_PATHS` requires a live session, checked via the same injected `hasValidSession`), static files last, 404, and the catch-all 500 / socket-destroy safety net.
- `src/static-files.ts` — serves the built SPA when `WEB_DIST` is set: content-type allowlist, gzip/brotli with `Vary`, `assets/` immutable vs `no-cache` for `index.html`, SPA fallback for extension-less paths only, traversal protection.
- `src/response-decorators.ts` — one choke point wrapping `res`: security headers (inner wins) and gzip/brotli for JSON bodies ≥ 1024 bytes, with the real `writeHead` deferred to `end` so `Content-Length`/`Vary` can be fixed up.
- `src/compression.ts` — q-value-aware content negotiation shared by the decorator and static files; brotli wins ties.
- `src/migrate.ts` — the pre-deploy migration runner: applies `packages/db/drizzle` SQL and exits non-zero so Railway aborts the deploy on failure.
- `Dockerfile` — multi-stage (prune → build → runner); ships the tsup bundle, the built SPA (`WEB_DIST=/app/apps/web/dist`), and the drizzle SQL; must declare `VITE_SOCIAL_PROVIDERS`/`VITE_GOOGLE_CLIENT_ID` as ARGs or OAuth buttons silently don't ship. The runner is fed by a second, server-only `turbo prune` (`--out-dir out-runner`) so `pnpm install --prod` installs only `@my-tuums/server`'s own declared deps — the web tree is already bundled into `dist` and would otherwise ship for nothing (issue #58).
- `tsup.config.ts` — bundles `src/index.ts` + `src/migrate.ts`; inlines `@my-tuums/*` (source-only packages) because Node's native type-stripping cannot rewrite their `.js` specifiers.
- `vitest.config.ts` — unit tests only. `src/index.ts` is deliberately out of scope (module-scope env parse + exit handlers would kill the runner); HTTP behaviour is covered by the Playwright `api` project in `e2e/`.

## How it connects

- `@my-tuums/api` supplies the oRPC router, per-request context, and the media presigner; `@my-tuums/auth` the better-auth node handler; `@my-tuums/db` the pool (ping/close) and migrations. All are inlined at build time.
- One origin is a requirement, not a preference: the SPA resolves `/rpc` against `window.location.origin` and images are relative `/media/` paths. In dev, Vite serves the app and proxies `/rpc`, `/api/auth`, `/media` here; in prod this server serves both.

## Load-bearing decisions — do not break

- `parseEnv` must never call `process.exit`; only `src/index.ts` may turn a bad env into exit(1) (keeps tests/scripts able to inspect the throw).
- The page gate must recognise the `__Secure-` session-cookie prefix (production HTTPS) — a mismatch 302s every signed-in visitor on every page.
- The page gate's allowlist (`SIGNED_OUT_PATHS`) is shared with the client gate via `@my-tuums/api/constants`, not duplicated — the two drifting apart is a redirect loop (a path gated here but exempt client-side, or vice versa, could bounce a signed-out visitor between this server and `/login` forever). `request-handler.test.ts`'s loop-guard test asserts every member of the shared list is exempt here.
- `hasValidSession` (wired in `index.ts`) must fail OPEN — return `true` — on any error. A database blip degrades to "the client gate decides" for pages (what every visitor already had before this gate existed) and "images keep loading" for `/media`, never to a mass sign-out or every avatar in the app breaking at once. That fail-open promise is a contract the callback itself must uphold — `request-handler.ts` has no special handling for a *rejecting* `hasValidSession`; it hits the same top-level 500 safety net any other unhandled exception would (see the test pinning this in `request-handler.test.ts`).
- `/media`'s session check runs BEFORE the key is parsed, not after — an anonymous caller must not be able to learn which keys are well-formed, let alone which objects exist, by watching whether the response differs. The rejection is `Cache-Control: no-store`, not merely relying on 401 being non-heuristically-cacheable by default: a cached 401 could otherwise keep an image looking broken after the browser signs in. Gating `/media` closes the last anonymous read of user content (issue #36 closed the data surface, the page gate above closed pages) — but it does NOT revoke a presigned URL already handed out; that URL is a bearer credential good for its own TTL (`DEFAULT_SIGNED_URL_TTL` in `packages/api/src/storage.ts`) regardless, since this server never sees it again once issued.
- The `/rpc` body cap must run before oRPC buffers a multipart body (that buffer happens before auth/rate limiting). Content-Length is checked at the router; chunked (`Transfer-Encoding`) bodies — which carry no Content-Length and are legitimate Node-client traffic — are bounded at the same ceiling by oRPC's `BodyLimitPlugin` (wired in `index.ts`).
- `decorateResponse`'s deferred `writeHead` contract: writers call `writeHead` then `end`; handlers that set their own headers keep them; never compress a response that already sets `Content-Encoding`.
- Brotli quality is an explicit per-request CPU decision, never a default to inherit: both `response-decorators.ts` and `static-files.ts` set `BROTLI_PARAM_QUALITY: 4` because the zlib default (11) is for build-time assets and costs ~10 ms of blocked event loop per response for a few percent of bytes (issue #54).
- Static files: never serve `index.html` for a path with an extension (mistyped `/assets/x.js` must 404); `assets/` is immutable, `index.html` is `no-cache`.
- Migrations run as a pre-deploy step, never at server boot — boot-time migration would make N replicas race the same DDL.

## Commands

- `pnpm --filter @my-tuums/server dev` — tsx watch on :3001 (loads `../../.env`).
- `pnpm --filter @my-tuums/server test` — vitest unit suites; needs no DB (that split keeps the unit/integration boundary honest).
- `pnpm --filter @my-tuums/server lint` / `typecheck` — eslint (typed) / `tsc --noEmit`.
- `pnpm --filter @my-tuums/server build` — tsup bundle into `dist/` (what the Dockerfile runs).
