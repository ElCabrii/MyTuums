# Operations

Production and preview run entirely on Cloudflare. The production release and
the temporary Railway rollback retention window are recorded in
[the production migration record](cloudflare-production-migration.md). The
earlier migration documents are historical evidence, not active runbooks.

## Configuration

The hosted environments use explicit Wrangler configurations:

| Environment | App config                              | Jobs config                           | Link fetcher                                  | Branding                                  |
| ----------- | --------------------------------------- | ------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| Preview     | `apps/server/wrangler.preview.jsonc`    | `apps/jobs/wrangler.preview.jsonc`    | `apps/link-fetcher/wrangler.preview.jsonc`    | none                                      |
| Production  | `apps/server/wrangler.production.jsonc` | `apps/jobs/wrangler.production.jsonc` | `apps/link-fetcher/wrangler.production.jsonc` | `apps/branding/wrangler.production.jsonc` |

The unqualified Wrangler files use `mytuums-build-*` names, no public routes,
and local D1/R2 identities. They exist for builds, generated types and local
maintenance. They are not a third hosted environment.

The Worker entrypoints validate each hosted origin, database, media bucket,
Stream namespace and Access mode as one tuple. Never mix resource bindings
between environments. Runtime credentials are encrypted Worker secrets; no
credential belongs in Wrangler vars, browser build inputs, source control or
operator output.

## Local development

Install dependencies, build generated assets, and validate the local database:

```bash
pnpm install
pnpm build
pnpm db:test:setup
```

`pnpm dev` serves the app at `http://localhost:3001`, the Vite client at
`http://localhost:5173`, and branding at `http://localhost:5174`. The native app
and jobs runtime share persistent local D1/R2/Workflow state under the
apps/server/.wrangler/development directory. Development captures email at
`http://localhost:3001/__dev/emails`; it does not deliver externally.

`pnpm jobs:dev` queues one local maintenance run. There is no local Cron.
OAuth, real Stream encoding and IGDB sync require hosted-provider verification.
`pnpm test:e2e` uses a separate disposable native stack and synthetic external
providers, so local development and CI cannot mutate preview or production.

## Cloudflare deployment

Production serves `mytuums.com` and `about.mytuums.com`. Preview serves
`preview.mytuums.com` behind Cloudflare Access. Workers.dev and version preview
URLs remain disabled. Each environment owns separate app/jobs Workers, D1,
private EU R2, Stream namespace, Workflows, Durable Objects, and a private
rich-link Container. Cloudflare Email Service sends application mail.

Deployments are explicit operator actions. From a clean `main` checkout whose
exact commit has successful `Verify`, `E2E tests`, and `Docker image builds`
checks, provide the target's public Vite inputs and run:

```bash
pnpm --filter @my-tuums/db deploy:preview --target=preview
pnpm --filter @my-tuums/db deploy:preview --target=production
```

The command derives the target origin, builds the repository, applies committed
D1 migrations, deploys and verifies the link fetcher, then deploys jobs and the
application. Production also deploys branding. Preview requires its GA
measurement ID; production analytics are disabled. Both hosted jobs Workers
keep their minute Cron schedule so durable video, notification and game-sync
recovery continues after deployment.

Never run the full snapshot importer against an environment accepting writes.
Normal releases use incremental committed migrations. The retired migration
candidate and proof-of-concept targets must not be recreated or selected by
operator commands.

## Build-time and runtime configuration

Vite embeds public `VITE_*` values into the browser bundle. The typed contract
in `apps/web/src/vite-env.d.ts` is checked against this list:

<!-- docs:check=vite-build-inputs -->

- `VITE_SOCIAL_PROVIDERS`
- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GA_MEASUREMENT_ID`
- `VITE_WEB_ORIGIN`

`VITE_SOCIAL_PROVIDERS` must agree with the credentials configured on the app
Worker. `VITE_GOOGLE_CLIENT_ID` is Google's public client identifier for One
Tap. `VITE_WEB_ORIGIN` controls metadata and copied links and is derived by the
deployment command. `VITE_GA_MEASUREMENT_ID` enables consent-gated analytics in
preview when the Worker also enables analytics.

Runtime secrets include authentication, OAuth, Stream, IGDB and appeal-signing
credentials. The app and jobs Workers share the same independently generated
`APPEAL_TOKEN_SECRET`; `BETTER_AUTH_SECRET` stays app-only. Changing a runtime
secret cannot alter values already baked into the browser bundle.

## Worker artifacts

`pnpm build` builds both frontends and runs Wrangler deployment dry runs for the
application, branding, jobs and link-fetcher Workers. It does not deploy.
Configuration changes require regenerated Worker bindings:

```bash
pnpm --filter @my-tuums/server types
pnpm --filter @my-tuums/jobs types
pnpm --filter @my-tuums/branding types
pnpm --filter @my-tuums/link-fetcher types
```

Native artifact tests execute the built application, branding assets and real
Workflow classes in workerd. External Access, mail, Stream, IGDB and rich-link
networking use local fixtures in tests; hosted smoke checks cover provider
integration after deployment.

## Migrations

Schema changes use generated and committed D1 migrations:

```bash
pnpm db:generate
pnpm --filter @my-tuums/db db:check
pnpm db:test:setup
```

Apply migrations locally by default, or select one hosted environment
explicitly:

```bash
pnpm db:migrate
pnpm db:migrate --remote --environment=preview
pnpm db:migrate --remote --environment=production
```

The maintenance adapter refuses `--remote` for local and refuses preview or
production without `--remote`. It validates the exact app/D1/R2 tuple before
opening bindings and never loads `.env`. Migrations use Drizzle's committed
ledger and run before deployment, never at Worker startup.

Historical PostgreSQL migrations remain comparison material. They are not
executed by the Cloudflare runtime.

## Observability

Hosted Worker configurations enable observability and source maps. The app and
link fetcher redact query strings because authentication and appeal URLs can
contain capabilities. Automatic invocation logs remain disabled on the public
HTTP Workers; application failures emit content-free events with request IDs.

`/health` checks the environment's D1 connection. Production is public; preview
health is behind the same Access policy as the application. Use Cloudflare
Workers logs, Workflow instance state, D1 metrics, R2 metrics and Stream status
for hosted diagnosis.

## CI checks

GitHub Actions verifies but does not deploy. `Verify` runs `pnpm verify`; the
other required checks run native browser E2E and build the private Container
image. All tests use local or disposable D1/R2 resources and synthetic provider
transports. CI needs no Cloudflare, Railway or Resend credentials.

Before a hosted release, the deploy command confirms all three required checks
passed on the exact clean `main` commit. Branch pushes do not create additional
Cloudflare environments or automatic deployments.

## Maintenance

All operator commands default to the persistent local resource pair. Hosted
work always names the environment and includes `--remote`:

```bash
pnpm db:promote <username> <moderator|staff|admin>
pnpm db:grant:founder <username>
pnpm games:seed
pnpm games:sync
pnpm --filter @my-tuums/api reconcile:media
pnpm --filter @my-tuums/api prune:notifications --retention-days=90

pnpm games:sync --remote --environment=preview
pnpm games:sync --remote --environment=production
pnpm --filter @my-tuums/api reconcile:media --remote --environment=preview
pnpm --filter @my-tuums/api prune:notifications --retention-days=90 --apply --remote --environment=production
```

`games:sync` records an intent; the selected jobs Worker's scheduled recovery
dispatches it. `reconcile:media` always binds the selected database and its
matching private bucket. Notification pruning is a dry run unless `--apply` is
present. Promotion remains bootstrap-only after the first admin exists, and
founder grants enforce the three-holder cap atomically.

Retain exports and recovery artifacts outside the repository because they can
contain sessions and verification capabilities. D1 recovery does not restore
R2 objects, Stream videos, Workflow history or Durable Object state; coordinate
those systems before allowing writes to a restored database.
