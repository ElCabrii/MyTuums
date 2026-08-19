# Operations

Running MyTuums: locally, in Docker, and in production. For what the pieces
are, see [architecture.md](architecture.md).

## Environment file

There is one `.env`, at the repository root. Every host-side process reads it —
package scripts through `dotenv -e ../../.env`, the web app through Vite's
`envDir`. Copy `.env.example` to start.

**`.env.example` is the variable catalogue.** It lists every variable, what it
does, what happens when it is unset, and where the values come from. This
document does not repeat it; it covers only the rules that are not obvious from
a variable's own description.

Four traps worth restating, because each one fails silently:

- `S3_BUCKET` is the bucket's **globally unique** name (display name plus a
  short hash), not the display name and not `RAILWAY_BUCKET_NAME`.
- `S3_ENDPOINT` must be the **public** endpoint from the bucket's Credentials
  tab. `storage.railway.internal` resolves only inside Railway's network, so a
  laptop or a CI runner using it simply cannot connect.
- `VITE_SOCIAL_PROVIDERS` must agree with the providers that have credentials
  server-side. The browser cannot see server env; the two lists are kept in
  step by hand and asserted by CI.
- `BETTER_AUTH_SECRET` must be at least 32 characters of real randomness. It
  also keys the appeal-link HMAC, so rotating it invalidates outstanding
  appeal links.

Partial groups are refused at boot by `apps/server/src/env.ts`: an OAuth pair
missing a half, or an `S3_*` group missing one of endpoint, bucket, access key
or secret. All-or-nothing is the rule; `S3_REGION` is exempt because it has a
real default (`auto`).

## Local development

Two ways to run the stack. They both want ports 3001 and 5173, so run one.

| Mode               | Command          | What you get                                                                  |
| ------------------ | ---------------- | ----------------------------------------------------------------------------- |
| Host-side          | `pnpm dev`       | API on `:3001`, Vite on `:5173` proxying `/rpc`, `/api/auth`, `/media`        |
| Full stack, Docker | `pnpm docker:up` | Postgres on `:5432`, migrations applied, then the production image on `:3001` |

`pnpm docker:up` runs the same image Railway deploys, with a one-shot
`migrate` service between a healthy Postgres and the server — so a fresh clone
boots against a current schema instead of serving errors on every query. Stop
it with `pnpm docker:down`; the named volume survives, and only
`docker compose down -v` wipes the data.

Host-side processes use `localhost` in `DATABASE_URL`; the compose `server`
service points at the `postgres` service name and overrides `HOST` to
`0.0.0.0`, because Docker's port mapping cannot reach a container's loopback.

The Playwright stack runs on `:3101` and `:5273` on purpose, so it can run
beside a live dev stack rather than asking you to stop working first.

| Port   | Who                               |
| ------ | --------------------------------- |
| `5432` | Postgres (compose or local)       |
| `3001` | API — `pnpm dev` or the container |
| `5173` | Vite dev server                   |
| `3101` | E2E server                        |
| `5273` | E2E web                           |

## Railway

Production runs on Railway, **always in a European region** — the app,
Postgres and object storage in the same region.

Three environments, and they do not do the same job:

| Environment  | Runs the app | Postgres | Bucket          |
| ------------ | ------------ | -------- | --------------- |
| `production` | yes          | yes      | the live bucket |
| `dev`        | no           | no       | dev bucket only |
| `ci`         | no           | no       | ci bucket only  |

`dev` and `ci` exist **only** to own a bucket. Postgres and the monorepo run
locally or on a CI runner; Railway's dev and ci environments never run the
app.

**Bucket isolation is a safety property, not tidiness.** The E2E suite deletes
objects by prefix during cleanup. Local development points at the dev bucket,
CI at the ci bucket. Pointed at production, that cleanup deletes real users'
avatars.

CI never deploys. Railway builds its own image from `apps/server/Dockerfile`
on push; the CI `docker` job exists to fail a commit that would produce a
broken one.

## Build-time and runtime configuration

This split is the source of the most confusing production failure this app
has: an app that works in dev and ships without OAuth buttons.

**Build-time.** Vite inlines `import.meta.env.VITE_*` into the bundle when the
web app is built — which happens inside the Docker build. Railway only exposes
a service variable to a Docker build if the Dockerfile declares it with `ARG`
in the stage that needs it. The declared build arguments are:

<!-- docs:check=vite-build-args -->

- `VITE_SOCIAL_PROVIDERS`
- `VITE_GOOGLE_CLIENT_ID`

Miss one and the image starts cleanly, serves everything, and silently renders
no sign-in buttons. CI greps the built bundle for both, and separately probes
the booted container's `/api/auth/sign-in/social` so the server's registered
providers and the client's offered providers are asserted against each other
from both sides.

**Runtime.** Everything else is read from the process environment at boot and
validated by `apps/server/src/env.ts`. Only `DATABASE_URL` escapes that
report: `@my-tuums/db` evaluates it at module scope and throws before
`parseEnv` ever runs.

## Docker image

`apps/server/Dockerfile` is a four-stage build from the monorepo root:

1. **pruner** — `turbo prune` twice: once for server _and_ web (what gets
   built), once for the server alone (what the runner installs).
2. **builder** — full install, tsup-bundle the server, then `vite build` with
   the `VITE_*` args declared.
3. **runner** — `pnpm install --prod` over the _server-only_ prune, then copy
   in `apps/server/dist`, `apps/web/dist` and the migration SQL. The second
   prune is why the web dependency tree cannot leak into the runtime image;
   CI asserts `apps/web/node_modules` does not exist and that the server's own
   production dependencies do.

The image sets `WEB_DIST=/app/apps/web/dist`, runs as a non-root user, exposes
3001, and starts `node apps/server/dist/index.js` — the exact process Railway
runs and the one CI boots and probes.

## Migrations

```bash
pnpm db:generate                       # SQL + snapshot from schema changes
pnpm db:push                           # apply locally
pnpm --filter @my-tuums/db db:migrate  # apply through the migrator
pnpm --filter @my-tuums/db db:check    # catch a schema edit with no migration
pnpm --filter @my-tuums/db db:studio   # browse
pnpm db:test:setup                     # create and migrate the _test database
pnpm db:promote                        # grant a moderator/staff/admin role (local)
```

`pnpm db:promote` runs through `tsx` and `dotenv-cli`, which are dev
dependencies and therefore absent from the production image. To appoint the
first admin in production, run the bundled entry point from the Railway
console instead — it needs only `node` and `DATABASE_URL` (already in the
process environment there):

```bash
node apps/server/dist/promote.js <username> <role>
```

This is a **bootstrap-only** operation: it refuses to run once an admin
already exists, so every later role change goes through the moderation desk
(`moderation.setRole`), which enforces the hierarchy and writes the audit log.

`packages/db/drizzle` is committed and ships inside the image. In production
migrations run as a **pre-deploy step** (`apps/server/dist/migrate.js`), which
exits non-zero so a failed migration aborts the deploy. Never at server boot —
N replicas would race the same DDL.

The `_test` database is a separate database whose name ends in `_test`;
`DATABASE_URL_TEST` is optional and derived from `DATABASE_URL` when unset.
Destructive helpers refuse to touch anything else.

## Observability

- **Request id.** Every request gets an `x-request-id` at the top of the
  routing tree. It rides the response header, the access log, the oRPC context
  and any Sentry event, so one identifier ties them together.
- **Access log.** One JSON line per finished request:
  `{"type":"access","requestId":…,"method":…,"path":…,"status":…,"durationMs":…}`.
  The **pathname only** — never the raw URL, because query strings are where
  tokens end up.
- **Sentry.** _Configuration-dependent_ on `SENTRY_DSN`. Unset (dev, CI) the
  server simply has no error-tracking client. When set, unhandled request
  errors are reported with the request id attached, 4xx responses deliberately
  are not, process crashes are reported, and the queue is flushed on shutdown.
  `apps/server/src/error-observation.ts` owns those classification decisions;
  `apps/server/src/sentry.ts` is the reporting adapter, while `index.ts` owns
  the actual shutdown and flush.
- **Health.** `GET /health` is DB-backed and returns `{"status":"ok"}`.

## CI checks

`.github/workflows/ci.yml` runs on every push to `main` and every pull
request:

| Job           | Does                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `check`       | build → lint → typecheck → Prettier → `pnpm docs:check`                  |
| `unit`        | `pnpm test:unit` with **no** database service                            |
| `integration` | Postgres service, schema-drift check, then `pnpm test:integration`       |
| `e2e`         | Postgres + the ci bucket's secrets, capped at 60 minutes                 |
| `docker`      | builds the image, asserts its contents, boots it and probes it over HTTP |

Details and the invariants behind each job: [.github/CONTEXT.md](../.github/CONTEXT.md).

## Maintenance

**Media reconciliation.** Uploads that leaked (a row write that never
completed, an interrupted replacement) are reaped by:

```bash
pnpm --filter @my-tuums/api reconcile:media
```

It lists the bucket before reading the `user` rows, so an upload landing
between the two steps is never mistaken for an orphan. Point it at the same
bucket as the environment whose rows you are reading, never across
environments.

**Lighthouse.** `pnpm lighthouse` and `pnpm lighthouse:desktop` run against
`http://localhost:3001/`, so serve a production build first (`pnpm docker:up`
is the easiest). Reports land in `lighthouse-reports/`, which is git-ignored.
Note that the valid-source-maps audit flags the main chunk: its gatherer gives
up on a large map after 1.5 seconds. The maps themselves work, and the audit
carries no score weight.

**Documentation.** `pnpm docs:check` validates the agent-facing docs against
the code — links, cited paths, documented scripts, the router groups, and the
Docker build arguments. It runs in CI's `check` job.

## Further reading

- [architecture.md](architecture.md) — dev and production topology in detail.
- [security.md](security.md) — secrets, isolation, and exposed surfaces.
- [../README.md](../README.md) — first-run setup.
