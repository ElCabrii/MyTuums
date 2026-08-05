# CLAUDE.md

Guidance for working in `apps/server`, the Node HTTP server of the MyTuums monorepo. Read the root `CLAUDE.md` first — it owns the repo-wide rules and env gotchas.

## What this is

A plain `node:http` server (no framework) that terminates every request: health checks, better-auth (`/api/auth`), the oRPC API (`/rpc`), media redirects (`/media`), and — in production — the built SPA. It is the only process Railway runs (`node apps/server/dist/index.js`). The routing tree, the response decorator and the env gate are deliberately extracted from `index.ts` so each can be unit-tested without a socket, a database or a session.

## Key files

- `src/index.ts` — the real entrypoint: the one place a bad env becomes `process.exit(1)`, wiring of real dependencies into the routing tree, the `decorateResponse` wrapper, and graceful shutdown (SIGTERM/SIGINT/unhandledRejection/uncaughtException → drain the Postgres pool, exit; 5s force-exit backstop).
- `src/env.ts` — zod validation of every env var. Its `superRefine` catches half-configured OAuth providers and partial S3 groups at boot; `parseEnv` throws but never exits.
- `src/request-handler.ts` — the routing decision tree, unit-tested with stand-ins. Exact-match `/health`, the signed-out `/` 302, `/api/auth`, `/rpc` (Content-Length cap before oRPC buffers), `/media` (GET/HEAD only → presigned 302), static files last, 404, and the catch-all 500 / socket-destroy safety net.
- `src/static-files.ts` — serves the built SPA when `WEB_DIST` is set: content-type allowlist, gzip/brotli with `Vary`, `assets/` immutable vs `no-cache` for `index.html`, SPA fallback for extension-less paths only, traversal protection.
- `src/response-decorators.ts` — one choke point wrapping `res`: security headers (inner wins) and gzip/brotli for JSON bodies ≥ 1024 bytes, with the real `writeHead` deferred to `end` so `Content-Length`/`Vary` can be fixed up.
- `src/compression.ts` — q-value-aware content negotiation shared by the decorator and static files; brotli wins ties.
- `src/client-ip.ts` — rate-limiter identity: `X-Forwarded-For` only when `TRUST_PROXY` is on, IPv4-mapped IPv6 normalised.
- `src/migrate.ts` — the pre-deploy migration runner: applies `packages/db/drizzle` SQL and exits non-zero so Railway aborts the deploy on failure.
- `Dockerfile` — multi-stage (prune → build → runner); ships the tsup bundle, the built SPA (`WEB_DIST=/app/apps/web/dist`), and the drizzle SQL; must declare `VITE_SOCIAL_PROVIDERS`/`VITE_GOOGLE_CLIENT_ID` as ARGs or OAuth buttons silently don't ship.
- `tsup.config.ts` — bundles `src/index.ts` + `src/migrate.ts`; inlines `@my-tuums/*` (source-only packages) because Node's native type-stripping cannot rewrite their `.js` specifiers.
- `vitest.config.ts` — unit tests only. `src/index.ts` is deliberately out of scope (module-scope env parse + exit handlers would kill the runner); HTTP behaviour is covered by the Playwright `api` project in `e2e/`.

## How it connects

- `@my-tuums/api` supplies the oRPC router, per-request context, and the media presigner; `@my-tuums/auth` the better-auth node handler; `@my-tuums/db` the pool (ping/close) and migrations. All are inlined at build time.
- One origin is a requirement, not a preference: the SPA resolves `/rpc` against `window.location.origin` and images are relative `/media/` paths. In dev, Vite serves the app and proxies `/rpc`, `/api/auth`, `/media` here; in prod this server serves both.

## Load-bearing decisions — do not break

- `parseEnv` must never call `process.exit`; only `src/index.ts` may turn a bad env into exit(1) (keeps tests/scripts able to inspect the throw).
- The `/` redirect must recognise the `__Secure-` session-cookie prefix (production HTTPS) — a mismatch 302s every signed-in visitor at `/`.
- The `/rpc` Content-Length cap must run before oRPC buffers a multipart body (that buffer happens before auth/rate limiting).
- `TRUST_PROXY` stays off by default: `X-Forwarded-For` is client-supplied and spoofable.
- `decorateResponse`'s deferred `writeHead` contract: writers call `writeHead` then `end`; handlers that set their own headers keep them; never compress a response that already sets `Content-Encoding`.
- Static files: never serve `index.html` for a path with an extension (mistyped `/assets/x.js` must 404); `assets/` is immutable, `index.html` is `no-cache`.
- Migrations run as a pre-deploy step, never at server boot — boot-time migration would make N replicas race the same DDL.

## Commands

- `pnpm --filter @my-tuums/server dev` — tsx watch on :3001 (loads `../../.env`).
- `pnpm --filter @my-tuums/server test` — vitest unit suites; needs no DB (that split keeps the unit/integration boundary honest).
- `pnpm --filter @my-tuums/server lint` / `typecheck` — eslint (typed) / `tsc --noEmit`.
- `pnpm --filter @my-tuums/server build` — tsup bundle into `dist/` (what the Dockerfile runs).
