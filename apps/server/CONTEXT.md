# apps/server context

## Responsibility

The Cloudflare application Worker serves auth, oRPC, private media and the built
SPA on one origin. Native runtime ownership and detailed invariants live in
[worker/CONTEXT.md](worker/CONTEXT.md). The PoC is implemented locally; hosted
activation and full verification remain outstanding. See
[the migration record](../../docs/cloudflare-migration.md).

The Node application entrypoint, Sentry adapter, Dockerfile and tsup production
configuration were removed only on `codex/cloudflare-poc`. Older transport helpers
and their tests remain as reference coverage while their native counterparts are
verified. They are not deployment entrypoints. Node still runs local test and
administration tools.

## Start here

| File                             | Owns                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `worker/index.ts`                | binding/config validation and application initialization |
| `worker/application.ts`          | native auth/API/media composition                        |
| `src/worker-request-handler.ts`  | Web Request/Response routing and admission               |
| `src/worker-response-headers.ts` | native CSP, cache and response headers                   |
| `src/worker-document.ts`         | bounded HTML transformation and metadata                 |
| `src/access.ts`                  | fixed issuer/audience Access JWT verification            |
| `worker/media.ts`                | private R2 delivery and Images variants                  |
| `wrangler.jsonc`                 | PoC domain, bindings, limits and observability           |
| `src/e2e-server.ts`              | disposable local native E2E composition                  |
| `src/games-sync.ts`              | guarded D1 CLI that queues GameSyncWorkflow intent       |

## Change map

- HTTP gates or headers: native handler/header modules, native tests, E2E HTTP contracts.
- Binding/configuration: entrypoint and Wrangler config; regenerate Worker types.
- Email/runtime dependency compatibility: `src/native-auth-email.test.ts` and its
  fixture in `worker/tests`; React Email must select its `workerd` export.
- Deployable artifact: `build:worker`, native application/branding artifact tests,
  and branch-specific Workers Builds configuration.
- Admin commands and migrations: `../../packages/db/scripts` and its context.
- Background processing: `../jobs/CONTEXT.md`; no encoding or Cron in this Worker.

## Invariants

- Exact host and verified owner-only Access admission precede all routes/assets.
  workers.dev and preview URLs stay disabled; application auth remains underneath.
- Auth admin endpoints are denied before Better Auth dispatch. Moderation flows
  only through the API's hierarchy and audit guards.
- Bound declared and actual bodies before framework parsing. Auth rate limiting
  runs before its lazy body stream is read; large RPC admission checks sessions.
- Both rate-limit counters use separate SQLite Durable Objects. Failed counter
  access must not grant admission; no raw caller identifiers belong in logs.
- Media authorization runs before storage access and again before delivery.
  Every response is private/no-store; no public R2 URL bypasses Access.
- No runtime migration or production data import. D1/R2 pairing is fixed to the PoC.
- Requests carry generated IDs. Logs must exclude capabilities, user content and
  provider errors; dependency logging still requires its deployment audit.

## Verification

Build the SPA first, then `pnpm --filter @my-tuums/server build:worker`.
The Node tooling typecheck emits no files and follows the shared E2E fixtures;
it has no obsolete server-only output root.
Use scoped Vitest files while iterating, `typecheck:worker` for native binding
code and `pnpm verify` for the repository gate. Artifact tests need completed app
and branding builds; never rebuild their assets during a test run.

`pnpm dev` now starts low-level local Wrangler, but interactive development
composition remains incomplete: the real entrypoint requires the PoC host,
Access assertion and secrets. The E2E composition is complete for synthetic
browser tests; it is isolated test tooling, not a user development database.

The unused Node environment parser and its legacy configuration tests are also
removed. `worker/index.ts` validates native bindings; `.env.example` contains
public browser build inputs only. Host-side test tooling remains on Node.
