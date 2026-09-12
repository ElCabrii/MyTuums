# e2e context

## Responsibility

Playwright journeys through the React/Vite frontend and the real Worker
application services, using local workerd D1, R2, Images and API rate-limit
Durable Objects. No PostgreSQL connection, remote bucket, application secrets
or `.env` is loaded by the test scripts. Video uploads use the real Stream
adapter and Video Workflow with a synthetic provider boundary. Hosted Stream
processing and playback remain unverified; the browser test covers transport
recovery and pending-post behavior.

Use API integration or unit tests for rules that do not require a browser.
See [../TESTING_STRATEGY.md](../TESTING_STRATEGY.md).

## Start here

| File                                       | Owns                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `constants.ts`                             | Synthetic origins, auth secret, Access issuer/audience and test resource names |
| `playwright.config.ts`                     | Projects, fixture account state and the two local processes                    |
| `support/platform.ts`                      | Shared local D1/R2 registry clients and their disposal                         |
| `support/db.ts`                            | Database fixtures and the once-per-run local reset                             |
| `global-setup.ts`                          | Reset and committed game fixture, including R2 covers                          |
| `support/fixtures.ts`                      | Browser contexts, consent defaults and per-worker platform cleanup             |
| `tests/auth.setup.ts`                      | Real signup/signin, fixture roles and cookie storage state                     |
| `../apps/server/src/e2e-server.ts`         | Native backend startup, migration readiness and shutdown                       |
| `../apps/server/worker/tests/e2e-entry.ts` | Real application composition surrounded by synthetic provider boundaries       |

## Change map

| Change                                           | Owner                 | Also check                                        |
| ------------------------------------------------ | --------------------- | ------------------------------------------------- |
| Ports, synthetic identity or test resource names | `constants.ts`        | `playwright.config.ts`, Worker fixture            |
| Local storage sharing or disposal                | `support/platform.ts` | backend startup, setup and worker fixture cleanup |
| Fixture writes or reset                          | `support/db.ts`       | committed D1 schema, `global-setup.ts`            |
| HTTP behavior                                    | `tests/api`           | native application boundary and runtime tests     |
| Browser journey                                  | `tests/specs`         | `support/fixtures.ts` and the owning web feature  |

## Invariants

- The backend binds only `127.0.0.1:3101`. Vite preview binds `localhost:5273` and
  proxies API/media requests as before. Browser navigation tests cover the
  client gate; `tests/api` covers the Worker's own page and media gates.
- D1 ID `mytuums_e2e_test`, R2 name `mytuums-e2e_test` and the
  `.wrangler/e2e_test` root are fixed and checked. No connection string or
  remote resource selector is accepted. Ordinary PoC development storage is
  separate and cannot be reset through these helpers.
- Miniflare's shared storage owner and dev registry coordinate processes.
  Clients share `resourcePersistencePath` and `unsafeDevRegistryPath` but each
  owns a temporary `isolatedResourcePersistencePath`. These are local test
  runtime options, never deployment settings. A two-process D1/R2 probe verifies
  reads/writes through the owner; do not open the underlying SQLite files directly.
- The backend applies committed Drizzle D1 migrations before its HTTP port is
  ready. Global setup then resets application tables and seeds games. It retains
  `__drizzle_migrations`, SQLite internals and Cloudflare's `_cf_` metadata.
  Foreign-key checks are deferred across the atomic reset, not disabled.
  Owner-deletion cleanup debt is cleared last. Local R2 cleanup failures fail
  setup, rather than allowing one run's uploads to leak into the next.
- Both servers use `reuseExistingServer: false`; a test cannot silently attach
  to an unrelated developer process. The setup process, authentication project,
  each browser worker and the backend dispose their own registry clients.
- The test Worker supplies a synthetic signed Access assertion and edge IP to
  the real application boundary. Certificate lookup and synthetic Stream upload creation are the only permitted
  outbound requests; both are fulfilled locally. This models an already-authenticated Access visitor;
  production-entrypoint tests separately prove missing/invalid assertions fail.
- Better Auth's limiter is disabled only in this fixture, preserving the old
  one-client E2E policy. The API limiter uses the real Durable Object. Native
  auth counter enforcement has its own runtime tests.
- Email is captured in the local R2 bucket under `__e2e_emails/`, never sent or
  printed. Fixture verification links use the fixed synthetic auth secret.
- Avatar, banner and post-image tests always run against local R2; they no longer
  skip based on S3 credentials. The video spec intercepts every request to the
  synthetic Stream upload host. Local R2 stores only provider metadata. The
  actual jobs Worker and Workflow engine observe upload completion, while the
  provider remains in processing state. No Cron is configured in this harness.
  Ready publication and captions belong to the separate jobs tests.

## Test conventions

- Keep `workers: 1`. Tests share one application database and rate-limit state.
  Global setup resets once; each spec seeds unique content and owns its cleanup.
- Use real HTTP signup when password acceptance matters. `setUserRole` is a
  fixture-only direct update; production role changes remain audited RPC calls.
- Seed posts in batches of twenty: Drizzle binds five values per row, including
  defaults, within D1's 100-parameter ceiling. Raw times
  are epoch milliseconds, including notification backdating.
- Locators use roles, labels and structure; no `data-testid` attributes.
- Storage state contains cookies only. Fresh-storage assertions need a new
  browser context. Unrelated journeys start with analytics refused and the
  current release notes already seen; relevant journeys explicitly opt out.
- Browser fixtures release the platform connection with a worker-scoped auto
  fixture. Specs that need database helpers should use `support/fixtures.ts`.
  The standalone authentication setup registers its own `afterAll` disposal.

## Verification

`pnpm test:e2e` builds the SPA with the synthetic analytics measurement ID,
then starts Playwright against Vite preview and the native backend. Both use the
built assets. This avoids Chromium resource exhaustion during repeated cold loads
of Vite's development module graph. For direct focused Playwright commands, first
run `VITE_GA_MEASUREMENT_ID=G-E2E306TEST pnpm --filter @my-tuums/web build`.
The build generates frontend route and locale artifacts.

- `pnpm --filter @my-tuums/e2e exec playwright test --project api`: HTTP contracts.
- `pnpm --filter @my-tuums/e2e e2e`: all browser projects and setup.
- `pnpm --filter @my-tuums/e2e lint` / `typecheck`: harness checks.
- The native application, auth/Access, RPC/media and jobs suites remain separate
  evidence for the deployed Worker artifact and real Workflows execution.

Generated `.auth`, `test-results`, `playwright-report` and `.wrangler` data are
ignored. Never commit captured messages, cookies, keys or local database files.
