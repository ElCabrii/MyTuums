# apps/server — agent guide

## Responsibility

The Node HTTP server. A plain `node:http` server with no framework that
terminates every request: health checks, better-auth at `/api/auth`, the oRPC
API at `/rpc`, media redirects at `/media`, and — in production — the built
SPA. It is the only process Railway runs.

It owns transport concerns only: routing, gates, headers, compression, static
files, env validation, observability, shutdown. Business rules live in
`@my-tuums/api`.

## Start here

| File                         | Why                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `src/request-handler.ts`     | The routing decision tree — every gate, in order. Unit-tested with stand-ins. |
| `src/index.ts`               | The real entrypoint: wiring, graceful shutdown, the one `process.exit(1)`.    |
| `src/error-observation.ts`   | Which faults are logged, reported, ignored, or require shutdown.              |
| `src/env.ts`                 | Every variable the server reads, and the all-or-nothing group rules.          |
| `Dockerfile`                 | How the production artefact is assembled.                                     |
| `../../docs/architecture.md` | Route order and one-origin routing in prose.                                  |

`src/index.ts` is deliberately outside the vitest scope — module-scope env
parsing and exit handlers would kill the runner. Its HTTP behaviour is covered
by the Playwright `api` project.

## Change map

| Intent                                | Primary                                              | Also touch                                                                         |
| ------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Add or reorder an HTTP route          | `src/request-handler.ts`                             | `src/request-handler.test.ts`, `../../e2e/tests/api`                               |
| Change who may reach a page           | `packages/api/src/constants.ts` (`SIGNED_OUT_PATHS`) | never duplicate it — the client gate reads the same set                            |
| Add an environment variable           | `src/env.ts`                                         | `../../.env.example`, `../../docker-compose.yml`, `Dockerfile` if it is a `VITE_*` |
| Change security or cache headers      | `src/response-decorators.ts`, `src/static-files.ts`  | `../../e2e/tests/api/headers.spec.ts`                                              |
| Change compression behaviour          | `src/compression.ts`                                 | both call sites: the decorator and static files                                    |
| Change access logging or request ids  | `src/observability.ts`                               | `src/request-handler.ts`                                                           |
| Change error classification/reporting | `src/error-observation.ts`, `src/sentry.ts`          | `src/index.ts`                                                                     |
| Change what ships in the image        | `Dockerfile`                                         | `.github/workflows/ci.yml` (`docker` job asserts it)                               |
| Change the migration runner           | `src/migrate.ts`                                     | `../../docker-compose.yml`                                                         |

## Invariants

- **`parseEnv` must never call `process.exit`.** Only `src/index.ts` may turn
  a bad environment into an exit. Otherwise merely importing the module kills
  any test or script that wanted to inspect the failure.
- **The request id is generated at the top of the tree, before any branch.**
  That is what puts it on responses written by the injected handlers (auth,
  RPC, static) as well as the tree's own. The access log reads the header back
  at `finish`; the oRPC context reads it from the response header. Skip it and
  the log degrades to `-` — it never throws.
- **The access log records the pathname only, never `req.url`.** Query strings
  are where tokens end up, and a log that stored them verbatim leaks on every
  dump.
- **All Sentry decisions go through `src/error-observation.ts`.** oRPC 4xx
  failures and request-level client-abort codes are logged but not reported;
  process-level faults are reported and return a shutdown decision. A broken
  logger or reporter must never replace the observed failure, response, or
  shutdown.
- **`/api/auth/admin/*` must 404 before the auth pass-through.** The admin
  plugin gates on its own `adminRoles` option, which cannot express this app's
  hierarchy. Blocking it keeps `/rpc` the only path to a moderation action, so
  the rank guard and the audit log stay the only enforcement surface.
- **The `/rpc` body cap runs before oRPC buffers.** oRPC buffers a multipart
  body while routing — before auth, rate limiting or any payload check.
  Content-Length is checked here; chunked bodies are bounded at the same
  ceiling by oRPC's `BodyLimitPlugin`, wired in `src/index.ts`.
- **The `/api/auth` body cap runs before Better Auth converts the request.**
  Declared bodies above `AUTH_MAX_BODY_BYTES` are rejected immediately;
  lengthless and chunked bodies use the bounded replay path so the adapter
  never becomes an unbounded or competing stream consumer.
- **`/media` checks the session before parsing the key.** An anonymous caller
  must not learn which keys are well-formed by watching the response differ.
  The rejection sets `Cache-Control: no-store`, or a cached 401 keeps an image
  broken after the visitor signs in.
- **The `/media` gate's session lookup stays uncached.** It is a real
  `auth.api.getSession` call because `@my-tuums/auth` runs no session cookie
  cache — a revoked session must stop authenticating immediately. This was
  measured (issue #63) and the cost did not justify carving an exception.
- **`hasValidSession` must fail open — return `true` on any error.** A
  database blip degrades to "the client gate decides" and "images keep
  loading", never to a mass sign-out. The routing tree has no special handling
  for a _rejecting_ callback; that hits the top-level 500 net like anything
  else.
- **The page gate must recognise the `__Secure-` cookie prefix.** A mismatch
  redirects every signed-in visitor on every page in production.
- **The page gate reads `SIGNED_OUT_PATHS` from `@my-tuums/api/constants`.** A
  local copy lets the server and client gates disagree and bounce a visitor
  between them forever. `request-handler.test.ts` pins every member as exempt.
- **`path.extname` is checked against the pathname, never the raw URL.** A
  query string can contain a dot, and a crafted one would otherwise make a
  real page look like an asset and skip the gate.
- **Only extension-less GET/HEAD requests are gated.** `/login` needs its own
  JS and CSS to render at all; gating assets turns the redirect into a blank
  page.
- **`decorateResponse` defers the real `writeHead` until `end`** so
  Content-Length and Vary can be fixed up. Handlers that set their own headers
  keep them; never compress a response that already sets `Content-Encoding`.
- **Brotli quality is pinned to 4, explicitly.** zlib's default of 11 is for
  build-time assets and costs roughly 10 ms of blocked event loop per response
  for a few percent of bytes (issue #54).
- **Static files never serve `index.html` for a path with an extension** — a
  mistyped `/assets/x.js` must 404. `assets/` is immutable; `index.html` is
  `no-cache`.
- **Migrations run pre-deploy, never at boot.** N replicas would race the same
  DDL.
- **The runner stage installs only the server's own production dependencies.**
  The web tree is already bundled into `dist`; a second, server-only
  `turbo prune` keeps it out structurally rather than by install-time luck
  (issue #58). CI asserts both directions.
- **`VITE_SOCIAL_PROVIDERS` and `VITE_GOOGLE_CLIENT_ID` must stay declared as
  `ARG` in the builder stage**, or the OAuth buttons silently do not ship.

## Dependencies and boundaries

- `@my-tuums/api` supplies the router, the per-request context and the media
  presigner; `@my-tuums/auth` the better-auth node handler; `@my-tuums/db` the
  pool (`pingDb`/`closeDb`) and migrations. tsup inlines all three — only the
  packages this app declares in `dependencies` stay external.
- One origin is a requirement, not a preference. See
  [docs/architecture.md](../../docs/architecture.md).

## Generated files

`dist/` (tsup). Nothing here is committed.

## Verification

| Command                                             | Covers                               |
| --------------------------------------------------- | ------------------------------------ |
| `pnpm --filter @my-tuums/server test`               | the unit suites (no database needed) |
| `pnpm --filter @my-tuums/server lint` / `typecheck` | this package alone                   |
| `pnpm --filter @my-tuums/server build`              | the tsup bundle the Dockerfile runs  |
| `pnpm --filter @my-tuums/server dev`                | tsx watch on `:3001`                 |

HTTP behaviour end to end is the Playwright `api` project; the production
artefact is only ever started by CI's `docker` job.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — route order, one-origin routing.
- [docs/security.md](../../docs/security.md) — what each gate is protecting.
- [docs/operations.md](../../docs/operations.md) — the image, env, deploys.
