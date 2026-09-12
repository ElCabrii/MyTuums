# Operations

Production and preview run on Cloudflare. The current release, data reconciliation,
retention deadline and rollback constraints are in
[the production execution record](cloudflare-production-migration.md).
The PoC setup history below is historical and is not the production release procedure.

## Configuration

Runtime configuration comes from each Worker's `wrangler.jsonc` and secret
bindings. App configuration is validated by `apps/server/worker/index.ts`.
Never put credentials in Wrangler vars, browser build inputs or source control.
The root `.env.example` documents public browser build inputs only. Vite can
read those inputs from the root `.env`;
D1 maintenance and test commands do not load it.

The local administration clients bind only the fixed PoC D1 database and, where
needed, its matching private EU R2 bucket. `--remote` is explicit. Wrangler CLI
credentials are independent of the Codex Cloudflare plugin connection.

## Local development

Install with `pnpm install`, then run `pnpm build` and `pnpm db:test:setup`.
No PostgreSQL, Docker or external bucket credentials are needed for native tests.
`pnpm test:e2e` starts a complete disposable browser test stack on `:3101` and
`:5273`, using real local D1/R2/Workflows and synthetic Access, mail and Stream
transport. It resets only its `_test` resources; see [E2E context](../e2e/CONTEXT.md).

`pnpm dev` starts the app at `http://localhost:5173`, its Worker at
`http://localhost:3001`, and branding at `http://localhost:5174`. Keep `localhost`
consistent for cookies and passkeys. Register with a development email address,
then open `http://localhost:3001/__dev/emails` and follow the captured verification
link. No message is sent to an external mailbox.

`apps/server/src/development-platform.ts` owns one Miniflare instance with the
real app and jobs bundles, committed migrations, D1, R2, Images, Workflows and
rate-limit Durable Objects. Data persists under
apps/server/.wrangler/development across restarts, separately from E2E, PoC and
hosted resources. To reset development data, stop `pnpm dev` and remove only that
directory. Development startup applies migrations only to this local database.

`pnpm jobs:dev` requests one maintenance Workflow against the same local D1/R2.
There is no automatic local Cron. Restart `pnpm dev` after changing bundled
Worker or jobs sources. Rich links reuse the guarded Node fetching transport.
Password auth, posts, images and captured mail work locally; OAuth, Stream video
processing and IGDB sync require hosted preview verification. The local app
omits OAuth buttons and video uploads, loads no provider secrets, and blocks
unconfigured Worker outbound calls. Its separate entrypoint accepts only HTTP
loopback requests on port 3001 and appears in no deployment configuration.

## Cloudflare deployment

Production uses `mytuums.com` and `about.mytuums.com`; preview uses
`preview.mytuums.com` behind Cloudflare Access. Workers.dev and version preview
URLs remain disabled. App, jobs, D1, private R2, Stream and rich-link Container
resources are isolated by environment. Application email uses Cloudflare Email
Service. Railway and Resend are not runtime dependencies.

Production and preview releases are explicit operator commands, not automatic
GitHub push deployments. From a clean `main` checkout whose exact commit has
successful Verify, E2E tests and Docker image builds checks, supply the target's
public `VITE_GOOGLE_CLIENT_ID` and `VITE_SOCIAL_PROVIDERS=google,discord,twitch`, then
run `pnpm --filter @my-tuums/db deploy:preview --target=production` or
`pnpm --filter @my-tuums/db deploy:preview --target=preview`. Preview additionally
needs its configured `VITE_GA_MEASUREMENT_ID`; production analytics are disabled.
The command derives `VITE_WEB_ORIGIN` from the target configuration, builds,
applies committed D1 migrations, deploys and verifies the private link fetcher,
then deploys jobs and app. Production also deploys branding.

Keep the minute Cron in both environment configurations. The former
production-candidate target and its configuration files are retired: it shared
the production database and must never be used for another import or deployment.
Never run the full-snapshot converter/importer against a live environment.
Normal schema evolution uses committed incremental migrations.

The initial DNS handoff required replacing the saved Railway CNAME records before
attaching Worker Custom Domains; the API rejected Wrangler's overwrite flags.
Those records are now Cloudflare-managed. Subsequent deployments must preserve
the existing native Custom Domains and do not need another DNS migration.

### Historical PoC Workers Builds configuration

Use the repository root (`/`) for all three builds so pnpm sees the workspace
lockfile. Set build variables `NODE_VERSION=24`, `PNPM_VERSION=12.1.0` and
`SKIP_DEPENDENCY_INSTALL=1`, then explicitly install with the frozen lockfile.
These overrides are documented by Cloudflare's
[build image reference](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).
The build variables are separate from runtime Worker secrets.

| Worker                 | Build command                                                                                                        | Deploy command                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `mytuums-poc-app`      | `pnpm install --frozen-lockfile && pnpm --filter @my-tuums/web build && pnpm --filter @my-tuums/server build:worker` | `pnpm --filter @my-tuums/server exec wrangler deploy`   |
| `mytuums-poc-branding` | `pnpm install --frozen-lockfile && pnpm --filter @my-tuums/branding build`                                           | `pnpm --filter @my-tuums/branding exec wrangler deploy` |
| `mytuums-poc-jobs`     | `pnpm install --frozen-lockfile && pnpm --filter @my-tuums/jobs build`                                               | `pnpm --filter @my-tuums/jobs exec wrangler deploy`     |

These are proposed settings, not active triggers. Select only
`codex/cloudflare-poc` as each PoC deployment's tracked branch and leave other
branch builds disabled. Do not use the default `main` selection. Workers Builds
ignores Wrangler's custom-build configuration, so its commands must be configured
in Builds itself. See [build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

The initial rollout must apply committed D1 migrations successfully, deploy jobs
and its Workflow classes, then deploy the app that binds those Workflows. Branding
can deploy independently after Access protection is ready. Do not enable
independent automatic triggers until migration/deployment ordering is implemented
and exercised. In particular, three simultaneous migration runners are not a
safe pre-deploy step. Retain Wrangler's built-in CI Worker/account match checks;
one Worker's build must not deploy a different Worker by bypassing those checks.

A read-only plugin check on 2026-09-11 returned HTTP 200 from
`/accounts/{account_id}/builds/account/limits`, with
`has_reached_build_minutes_limit=false`. That does not establish Workers Paid
status or repository access. Repository configuration lookup returned API error
12000 (not found), using both repository names and GitHub's numeric identifiers.
A subsequent repository-connection request using verified GitHub identifiers
returned error 8000008: Cloudflare's Git integration is disconnected. The build
token list is also empty. Reconnect `ElCabrii/MyTuums` to this account before
configuring the PoC branch builds. No build trigger, build token, subscription,
Worker or deployment was created by these checks.

After account setup at 13:00 UTC, the GitHub repository lookup succeeds and the
connection is `edb3ba42-0325-417c-a75a-34634c78f67d`. Stream now reports 1,000
storage minutes, and Email Sending reports a 200/day quota with `mytuums.com`
enabled and DNS status `ready`. These are configuration checks, not encoding or
delivery evidence. See [the setup record](artifacts/cloudflare-poc/account-setup-2026-09-11.json).

Workers Builds still has no deployment token. The plugin cannot manage account
API tokens (permission lookup returns `9109`), so the owner must create/select
one under the branding Worker's **Settings → Builds → API token**. The
[Builds configuration reference](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
describes automatic token creation in that dashboard flow. Keep the value in
Cloudflare; only its Builds UUID is needed for API trigger configuration.
Initially the empty Worker entries prevented dashboard build settings from
opening. Branding now has one **undeployed** bootstrap version
`590ec5f2-041c-42ea-b1d5-e9b1d8764e69`, containing only an unconditional empty 503
response and no bindings. It exists to unlock setup, not to serve the PoC.
Readback confirms zero deployments, no custom domains and disabled workers.dev
and preview URLs. App/jobs remain versionless; their secrets API returns `10007`.
The real application artifacts will be deployed through branch-specific Builds.

## Build-time and runtime configuration

Vite embeds public `VITE_*` inputs at build time. The typed browser contract in
`apps/web/src/vite-env.d.ts` is checked against this list:

<!-- docs:check=vite-build-inputs -->

- `VITE_SOCIAL_PROVIDERS`
- `VITE_GOOGLE_CLIENT_ID`
- `VITE_GA_MEASUREMENT_ID`
- `VITE_WEB_ORIGIN`

The PoC Vite configuration fixes the provider list to Google, Discord and Twitch.
Workers Builds must supply the public Google client ID matching the runtime's
Google credentials for One Tap. Runtime credentials remain Worker secrets;
changing them cannot change an already built frontend. `VITE_WEB_ORIGIN` selects
the isolated PoC, preview candidate or final preview origin for metadata and
copied links. It defaults to PoC; the preview deployment command derives it from
`apps/server/wrangler.preview.jsonc`.

When `VITE_GA_MEASUREMENT_ID` is set, configure that GA4 property under
**Admin → Data collection and modification → Data retention** for 14 months.
The app limits both its consent record and GA cookies to six months, disables
Google signals and advertising-personalization signals, and never loads the
tag before consent; the property setting is the remaining deployment-side
retention control and cannot be enforced from this repository.

The app sends SPA page views manually (`send_page_view: false` plus one
`page_view` per TanStack Router navigation, with only the origin and pathname
so capability tokens in query strings never leave the device). That flag alone
does not stop Enhanced Measurement from also emitting a `page_view` on every
browser-history change, so disable **Admin → Data collection and modification
→ Data streams → Web → Enhanced measurement → Page views → Show advanced
settings → Page changes based on browser history events** for the same
property. Otherwise each navigation is counted twice — once automatically,
once manually. See
https://developers.google.com/analytics/devguides/collection/ga4/views#disable_page_changes_based_on_browser_history_events.

## Worker artifacts

`pnpm build` builds the SPA and branding assets and runs Wrangler deployment dry
runs for the application, branding and jobs Workers. It does not deploy.
`apps/server/src/native-application.test.ts` and `native-branding.test.ts` execute
those actual bundles and assets in workerd. Jobs tests execute the compiled
Workflow classes with local D1/R2. Do not rebuild assets while artifact tests run.

The former Node ESM email regression now lives in
`apps/server/src/native-auth-email.test.ts`: password reset, verification and OTP
builders execute with React Email's `workerd` export condition. Synthetic delivery
is not evidence of hosted Email Service availability.

The native sender retries `E_RATE_LIMIT_EXCEEDED` and `E_INTERNAL_SERVER_ERROR`
at most twice after the initial attempt, with 500 ms and 1 second delays. It
reuses the same rendered message and replaces terminal provider errors with a
content-free error. Sender/recipient validation, suppression, daily limits and
unclassified failures are not retried. The
[Workers Email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
documents error codes but provides no idempotency-key field: this policy does
not promise exactly-once delivery. Unknown network failures are not safe to
retry automatically because the provider may already have accepted the message.
The binding also exposes no cancellation signal; the attempt count and backoff
are bounded, not the provider's individual response time.

Moderation actions, case resolution and appeal review now commit serialized email
notices in the same D1 batch as their state changes. Immediate delivery and minute
maintenance share `moderation-email.ts`. Each pass handles at most 25 due notices,
in order per recipient, with two-minute fenced leases. Known temporary failures
back off for 1, 2, 4, 8 and 16 minutes, up to six delivery attempts (each uses the
bounded transport above). Permanent or ambiguous failures stop automatic retry.
Acknowledged notices are deleted; account deletion cascades pending private
content, and maintenance removes notices after 24 hours. An accepted send followed
by an interrupted acknowledgement can still produce a duplicate on recovery.

Set the same independently generated `APPEAL_TOKEN_SECRET` (at least 32 characters)
on the app and jobs Workers. Keep `BETTER_AUTH_SECRET` app-only. Recovery signs the
stored action/recipient/notice identity using the original creation time, so a
retry does not extend the seven-day appeal-link lifetime. Auth verification,
password-reset and OTP mail still have bounded transport retries only; their
durable intent remains outstanding. Hosted Email Service delivery is unverified.

## Migrations

```bash
pnpm db:generate                       # SQL + snapshot from schema changes
pnpm --filter @my-tuums/db db:migrate  # apply committed D1 migrations locally
pnpm --filter @my-tuums/db db:check    # catch a schema edit with no migration
pnpm db:test:setup                     # validate migrations in ephemeral local D1
pnpm db:promote                        # grant a moderator/staff/admin role (local)
```

On the Cloudflare PoC branch, administrative commands use D1 directly:

```bash
pnpm db:promote <username> <moderator|staff|admin>
pnpm db:grant:founder <username>
# Add --remote to target the isolated mytuums-poc D1 database.
```

The default is the application's local Wrangler state. The remote option requires
Wrangler authentication separately from the Codex plugin connection. Both paths
validate the exact PoC account and database configured in `apps/server/wrangler.jsonc`,
load no `.env`, and require committed migrations to have been applied first.
The old Railway admin entrypoints have been removed from this branch.

Promotion is **bootstrap-only**: one atomic D1 batch refuses changes once an admin
exists, including concurrent bootstrap commands. Subsequent changes go through
`moderation.setRole`, which enforces hierarchy and records the audit log.
Founder grants also use an atomic batch, preventing duplicate grants or more than
three holders. Known refusals are shown to the operator; raw SQL/provider errors
are replaced with a generic failure.

D1 migration execution uses the same guarded PoC connection, defaults to local,
and accepts `--remote` explicitly. It applies committed `packages/db/drizzle-d1`
SQL through Drizzle's migration ledger; do not mix it with Wrangler's separate
`d1 migrations apply` ledger. A nonzero exit must stop deployment. Never run
migrations at Worker request/startup time. `db:test:setup` checks the migrations
in a disposable local binding; each integration file provisions its own binding.

Historical PostgreSQL DDL under `packages/db/drizzle` remains immutable reference
material. Only `packages/db/drizzle-d1` is applied by this branch. Direct schema
push and the PostgreSQL Studio command were removed; use reviewed, committed D1
migrations. The `_test` databases belong to local native test fixtures.

## D1 backup and recovery

Rehearse a fresh D1 setup and SQL round trip without credentials:

```bash
pnpm --filter @my-tuums/db db:rehearse:recovery
```

The command creates two independent temporary `_test` databases, applies the
committed Drizzle migrations to the source, and seeds synthetic related data.
It uses the installed `wrangler d1 export --local` and `d1 execute --local --file`
commands to restore into the empty target. It compares every application schema
object and row, including the Drizzle ledger, checks foreign keys, reruns
migrations as a no-op, then exercises normalization, account deletion, favorite
counts and orphan-media cleanup triggers. It accepts no arguments and removes
only its own temporary directories. Neither existing local PoC state nor remote
resources are opened. Run it after changing schema or the Wrangler version.

For a retained snapshot of the application's **local** PoC database, use an
absolute output path outside the repository:

```bash
pnpm --filter @my-tuums/server exec wrangler d1 export mytuums-poc --local --output /absolute/private/path/mytuums-poc.sql
```

This reads the app config's default `.wrangler/state` persistence; the installed
Wrangler export command has no `--persist-to` flag. A full export must retain
schema, triggers and `__drizzle_migrations`; do not use `--no-schema`, `--no-data`
or a table filter for recovery. Keep SQL snapshots private because they may
contain session and verification capabilities. Import into a fresh isolated
database, verify it, then deliberately switch the PoC binding; never import over
an active database or apply migrations before importing a full schema snapshot.
Do not copy or alter D1's reserved `_cf_` metadata or mix Drizzle's ledger with
Wrangler migrations. These commands follow the current
[D1 import/export documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

The September 11 hosted SQL export/import rehearsal restored the initialized PoC
into a disposable EU D1 database. All 114 schema objects and seven ledger entries
matched, with no foreign-key violations. The disposable database and local backup
were removed; the original PoC database was unchanged. The source had no
application users. See [the recovery record](artifacts/cloudflare-poc/d1-recovery-2026-09-11.json).

Neither SQL export/import rehearsal verifies
[Time Travel recovery](https://developers.cloudflare.com/d1/reference/time-travel/).
Before hosted recovery, restrict PoC traffic, stop writes and job dispatch, record
the exact resource IDs and recovery point, and export the current database.
Restore into disposable PoC resources first and check the same schema/data
invariants. R2 bytes, Stream videos, Workflow histories and rate-limit Durable
Objects are separate state: D1 restoration cannot restore them. Keep cleanup and
jobs stopped until restored media references and job intents are reconciled with
those systems; an older database can otherwise cause valid newer media to be
classified as orphaned. Hosted recovery of populated application data and the
coordinated media/job procedure remain unverified. No reset, cutover or remote
deletion is performed by this runbook.

## Observability

The Worker entrypoints enable Cloudflare observability and source maps. Automatic
invocation logs are disabled and query strings redacted because auth URLs contain
capabilities. HTTP responses carry an `x-request-id`; native boundary failures
log content-free events. `/health` checks D1 behind the same Access gate.

Sentry's Node adapter was removed with the Node entrypoint. Auth diagnostics
retain severity only, and unexpected auth failures return a generic 500 without
SQL or provider details. Moderation mail failures log the generated request ID;
image cleanup failures log only a static event. Local regressions exercise these
failure paths. Live log inspection, alerting and usage/cost measurement remain
deployment gates. Never log tokens, signed URLs,
SQL parameters, user text or provider response bodies.

## CI checks

On this branch `.github/workflows/ci.yml` runs on pushes to `main` or
`codex/cloudflare-poc` and pull requests. It has two self-hosted jobs:

| Job         | Checks                                                             | Secrets |
| ----------- | ------------------------------------------------------------------ | ------- |
| `Verify`    | `pnpm verify`, including actual Worker artifact and Workflow tests | none    |
| `E2E tests` | builds the SPA, installs Chromium, runs `pnpm test:e2e`            | none    |

Both use local native resources; there are no PostgreSQL services, S3 setup,
Docker image jobs or deployment steps. Actions remain pinned to full commits,
checkout credentials are not persisted, and each job has a 30-minute timeout.
Playwright reports are retained for seven days even after test failure.

The historical `Docker image builds` required check on `main` is not changed by
editing this branch's workflow. Main and its branch protection remain untouched;
a future merge/cutover would require a separate check-policy decision.
See [.github/CONTEXT.md](../.github/CONTEXT.md).

## Maintenance

**Media reconciliation.** Uploads that leaked (a row write that never
completed, an interrupted replacement) are reaped by:

```bash
pnpm --filter @my-tuums/api reconcile:media --bucket=mytuums-poc-media
```

**Notification pruning.** Likes, replies and follows past the ninety-day
retention horizon (`NOTIFICATION_RETENTION_DAYS` — the same boundary the page
and the badge already serve) are deleted by:

```bash
pnpm --filter @my-tuums/api prune:notifications --apply --retention-days=90
```

The PoC command defaults to local D1 and a dry run; omit `--apply` to report
eligible rows. `--remote` explicitly selects the isolated `mytuums-poc` D1
resource, guarded by its configured account and database ID. It never loads
`.env` or accepts a production database URL. Every delete is bounded to 250
rows and uses the same ninety-day predicate as the list, badge and jobs Worker.
Moderation notices and read cursors remain intact. The PoC jobs Worker schedules
Monday 04:00 UTC pruning after deployment. Railway production keeps its existing
scheduled service until a separately authorized cutover.

**Game catalog sync.** `pnpm games:sync [--remote]` queues a durable request in
PoC D1. The jobs Worker's next scheduled recovery dispatches GameSyncWorkflow,
which reads IGDB, writes private R2 covers and publishes the staged catalog.
The CLI does not run the sync itself and needs no IGDB or application auth
credentials. Its timestamp comes from D1, preserving monotonic catalog fencing.
Local queued requests need local recovery connected to the same D1 persistence;
remote requests need the PoC jobs Worker deployed. The native daily schedule is
00:00 UTC. Railway production retains its existing service until cutover.

Dev, CI and e2e never need IGDB credentials — they seed the committed
fixture instead:

```bash
pnpm games:seed --database=mytuums-poc
```

On September 11 the connected Cloudflare API seeded the remote PoC pair with the
same fixture: 28 games and 26 private cover objects. That operation replayed the
existing seeder's captured SQL batches and storage writes after verifying empty,
idle targets; it did not authenticate Wrangler. All fixture values and object
hashes match. See [the seed evidence](artifacts/cloudflare-poc/fixture-seed-2026-09-11.json).
The normal repeatable CLI remains the command above, with `--remote` and Wrangler
authentication for hosted resources. A connected plugin does not supply CLI
credentials automatically.

The native PoC commands require the exact database or bucket name and validate
both against the application's fixed account, D1 ID and EU R2 configuration.
They default to local Wrangler storage; `--remote` explicitly selects the hosted
PoC pair. They never read `DATABASE_URL`, S3 credentials or `.env`. Game seeding
always uploads committed fixture covers to R2. Reconciliation immediately deletes
unreferenced objects under managed image prefixes after listing all candidates
and reading live plus pending references in one D1 snapshot. It does not delete
Stream videos. The retyped bucket argument is its deliberate deletion guard.

**Lighthouse.** `pnpm lighthouse` and `pnpm lighthouse:desktop` run against
`http://localhost:3001/` by default. For the Vite development UI, explicitly target
`http://localhost:5173/`; port 3001 serves the local API, not the built SPA. Reports land in `lighthouse-reports/`, which is git-ignored.
Note that the valid-source-maps audit flags the main chunk: its gatherer gives
up on a large map after 1.5 seconds. The maps themselves work, and the audit
carries no score weight.

**Documentation.** `pnpm docs:check` validates the agent-facing docs against
the code — links, cited paths, documented scripts, the router groups, and the
public Vite build inputs. It runs as part of `pnpm verify`.

## Production preload diagnostics

Shared HTML preloads only shared resources; lazy routes load on demand and enter
the service worker runtime cache after use. The measured login-hint fix and the
remaining warning investigation are recorded in
[Production preload investigation](preload-investigation.md).

## Further reading

- [architecture.md](architecture.md) — dev and production topology in detail.
- [security.md](security.md) — secrets, isolation, and exposed surfaces.
- [../README.md](../README.md) — first-run setup.
