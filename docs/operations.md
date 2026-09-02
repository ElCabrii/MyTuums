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

| Port   | Who                                 |
| ------ | ----------------------------------- |
| `5432` | Postgres (compose or local)         |
| `3001` | API — `pnpm dev` or the container   |
| `5173` | Vite dev server (the SPA)           |
| `5174` | Vite dev server (the branding site) |
| `3101` | E2E server                          |
| `5273` | E2E web                             |

The branding site has its own Vite dev server,
`pnpm --filter @my-tuums/branding dev` on `:5174` — no Host-header games
needed, because host routing only exists in the server, which serves the
built `dist/` when `BRANDING_DIST` is set (the Docker image always does). To
preview exactly what production serves, build the site and curl either
server with a forged Host header:

```bash
pnpm --filter @my-tuums/branding build
BRANDING_DIST=$PWD/apps/branding/dist pnpm dev   # separate shell
curl -H "Host: about.mytuums.com" http://localhost:3001/
```

## Railway

Production runs on Railway, **always in a European region** — the app,
Postgres and object storage in the same region. The public origin is
**https://mytuums.com**; it is what `WEB_ORIGIN` is set to in production, and
it is baked into `apps/web/index.html`'s Open Graph/Twitter tags and
Organization JSON-LD, mirrored by `SITE_ORIGIN` in
`apps/web/src/lib/document-head.ts`. Those tags are crawler-facing statements
about the real site, so every environment serves them unchanged — a Preview
URL still unfurls with production copy by design. Canonicals live only in
each route's `head()` (`SITE_ORIGIN`-based), never in `index.html`: the file
is served verbatim for every path, and a static canonical would point every
crawlable URL at the homepage. Change all three places together.

Four environments, and they do not do the same job:

| Environment  | Runs the app | Postgres | Bucket              | Deploy source         |
| ------------ | ------------ | -------- | ------------------- | --------------------- |
| `production` | yes          | yes      | the live bucket     | `main`                |
| `Preview`    | yes          | yes      | Preview bucket only | active release branch |
| `dev`        | no           | no       | dev bucket only     | none                  |
| `ci`         | no           | no       | ci bucket only      | none                  |

`Preview` is the release-candidate environment. It uses fresh, isolated data
and storage and auto-deploys the active release branch. When a new release
branch is opened, update the Preview service's Railway deployment trigger to
that branch. Production continues to auto-deploy `main` only.

Keep production third-party credentials out of Preview. OAuth, transactional
email, and error-reporting integrations remain disabled there until dedicated
non-production credentials are configured.

`dev` and `ci` exist **only** to own a bucket. Postgres and the monorepo run
locally or on a CI runner; Railway's dev and ci environments never run the
app.

**Bucket isolation is a safety property, not tidiness.** The E2E suite deletes
objects by prefix during cleanup. Local development points at the dev bucket,
CI at the ci bucket. Pointed at production, that cleanup deletes real users'
avatars.

CI never deploys. Railway builds its own image from `apps/server/Dockerfile`
on push; the CI `image` job exists to fail a commit that would produce a
broken one.

**The branding site rides the app's deployment.** `about.mytuums.com` is
served by the same Railway service — host routing inside the server over the
built `apps/branding/dist` (`BRANDING_DIST` in the image), no second
service, no environment change. The one manual step is DNS: add
`about.mytuums.com` as a custom domain on the production service, then create
the records Railway shows at the registrar. Until that is done the site
exists only under a forged Host header (see the curl in
[Local development](#local-development)).

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
   in `apps/server/dist`, `apps/web/dist`, `apps/branding/dist` and the
   migration SQL. The second prune is why neither web dependency tree can
   leak into the runtime image; CI asserts `apps/web/node_modules` does not
   exist and that the server's own production dependencies do.

The image sets `WEB_DIST=/app/apps/web/dist` and
`BRANDING_DIST=/app/apps/branding/dist`, runs as a non-root user, exposes
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
request. Three jobs, split by what a failure means and by what each is
trusted with — not by test taxonomy:

| Job                   | Does                                                                     | Secrets |
| --------------------- | ------------------------------------------------------------------------ | ------- |
| `Verify`              | Postgres service, then one `pnpm verify`                                 | none    |
| `E2E tests`           | Postgres + the `ci` bucket's secrets, then `pnpm test:e2e`               | `S3_*`  |
| `Docker image builds` | builds the image, asserts its contents, boots it and probes it over HTTP | none    |

`Verify` runs the **same** `pnpm verify` a contributor runs before pushing —
one script, so local and CI cannot drift. It is, in order: `build`, `lint`,
`typecheck`, `format:check`, `docs:check`, `test:unit`, `db:check`,
`db:test:setup`, `test:integration`.

The jobs run serially: this repository's runners are self-hosted and there is
effectively one slot, so the pipeline's critical path is their sum. That is
why there are three jobs and not more — each one costs about a minute of pure
setup. `Docker image builds` stays separate from `E2E tests` despite both
needing Postgres because the image job must keep taking no secrets.

All three are required checks on `main`; GitHub matches them by job `name:`,
so renaming a job silently breaks branch protection. To restore the
protection (e.g. after experimenting), put each job's `name:` into
`required_status_checks.checks` — `Verify`, `E2E tests`,
`Docker image builds` — and `PUT` it to
`repos/ElCabrii/MyTuums/branches/main/protection` with the existing
`enforce_admins`, `strict`, `required_conversation_resolution`,
`allow_force_pushes: false` and `allow_deletions: false` settings intact.
Details and the invariants behind each job: [.github/CONTEXT.md](../.github/CONTEXT.md).

## Maintenance

**Media reconciliation.** Uploads that leaked (a row write that never
completed, an interrupted replacement) are reaped by:

```bash
pnpm --filter @my-tuums/api reconcile:media
```

**Notification pruning.** Likes, replies and follows past the ninety-day
retention horizon (`NOTIFICATION_RETENTION_DAYS` — the same boundary the page
and the badge already serve) are deleted by:

```bash
pnpm --filter @my-tuums/api prune:notifications --apply --retention-days=90
```

Dry-run by default; moderation notices are exempt, and read cursors
(`notification_last_seen`) are never deleted — one row per recipient, kept
so a recipient returning past the horizon does not find every retained
moderation notice unread again. Run it on a schedule that suits the volume
— weekly is plenty at this scale.

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
Docker build arguments. It runs as part of `pnpm verify`.

## Further reading

- [architecture.md](architecture.md) — dev and production topology in detail.
- [security.md](security.md) — secrets, isolation, and exposed surfaces.
- [../README.md](../README.md) — first-run setup.
