# Preview migration to Cloudflare

Gabriel authorized preview migration on September 12, 2026, preserving existing
preview data. Production, main, release branches, and their infrastructure remain
outside this migration. Implementation stays on `codex/cloudflare-poc`.

## Target and cutover rules

| Component                                 | Preview target                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Application and SPA                       | `mytuums-preview-app`                                                   |
| Scheduled work and video workflows        | `mytuums-preview-jobs`                                                  |
| Database                                  | EU D1 `mytuums-preview`, `c8ce4268-2a4c-4175-b574-93c1c45aac92`         |
| Active images                             | Private EU R2 `mytuums-preview-media`                                   |
| Migration backups and legacy video assets | Private EU R2 `mytuums-preview-archive`, never bound to runtime cleanup |
| Video                                     | Stream creator namespace `mytuums-preview`; signed URLs required        |
| Email                                     | Cloudflare Email Service, `noreply@mytuums.com`                         |
| Rehearsal                                 | `preview-candidate.mytuums.com`, owner-only Access                      |
| Final origin                              | `preview.mytuums.com`, existing preview Access policy                   |

Use `apps/server/wrangler.preview.jsonc` and `apps/jobs/wrangler.preview.jsonc`
explicitly. Default Wrangler configuration still targets the isolated PoC. Jobs
have no Cron triggers during rehearsal. Neither Worker has a workers.dev endpoint
or deployment preview URL. The candidate Access audience must be replaced with
the existing preview audience when changing the final origin and route.

Never run cleanup against the archive bucket. Do not seed the PoC fixtures into
preview. Keep `BETTER_AUTH_SECRET` identical to the old preview secret: password,
session and encrypted two-factor records are imported unchanged. The legacy
appeal signer also used that secret; preserve it as `APPEAL_TOKEN_SECRET`.
Candidate OAuth needs candidate callbacks to test that hostname; final preview
keeps its existing callbacks and passkey relying-party hostname.

## Progress, September 12

- Created the EU D1 database and both private R2 buckets in account
  `734f3b84571b1967e6940140a0b7d75f`. Production resources are unchanged.
- Preserved the existing preview Access application. Created owner-only candidate
  Access app `e4b35298-926a-49c6-98f0-7c242f5140bc`, audience
  `e5abc28a2568684b5fb2d7a83e797cab5d15f12e619ed0b271f49bd999cfa495`.
- Exported PostgreSQL with `pg_dump`, including its 39-entry migration history and
  legacy job schema. Exported all 29 application tables in a read-only,
  repeatable-read transaction for conversion. These are rehearsal snapshots;
  Railway preview continues accepting writes until the final maintenance window.
- Snapshot: 2,812 application rows, including 10 users, 24 posts, 2,635 games,
  18 sessions, 11 linked auth accounts, one two-factor record and two published
  videos. No pending video submissions or video cleanup obligations were present.
- Backed up all 3,155 media objects (80,850,639 bytes) with SHA-256 hashes, sizes,
  source ETags and content types. Snapshot credentials and account data remain in
  a permission-restricted migration directory outside the repository.
- Verified a durable backup copy at
  `/home/gabriel/.local/share/mytuums/preview-migration-20260912`, outside Git and
  temporary storage. All 2,637 image references in the snapshot exist in the
  backup; two external image references are preserved as URLs.
- Both legacy originals had already been deleted by the old pipeline. Remuxed
  each highest available HLS rendition without re-encoding, and uploaded to Stream.
  The first video has a 360×640 rendition; the second is 1920×1080. Both are ready
  and require signed URLs. All legacy renditions remain in the backup.
- The conversion reconciled every target row with its expected converted source,
  including game favorite counts. The resulting SQL executed all 2,920 statements
  successfully in an isolated local D1 database.
- Imported the rehearsal into hosted D1: 37 tables, 2,621,440 bytes. All 29
  application table counts and SHA-256 row digests match, all seven native
  migration hashes match, and `foreign_key_check` reports zero violations.
- Created placeholder preview app/jobs Workers to prepare their secret bindings.
  They have no public routes; workers.dev and deployment preview URLs are disabled.
  The real application is not deployed yet.
- Copied preview auth/OAuth, IGDB and appeal secrets directly into the new Worker
  secret bindings without displaying their values. The existing auth secret is
  preserved. `STREAM_API_TOKEN` is the remaining runtime secret: Cloudflare does
  not return the stored PoC value, so the owner must supply it to both Workers.
- Overnight PoC maintenance now shows successful automatic executions. The earlier
  absence of Cron evidence is no longer an established blocker.
- Cloudflare's plugin rejects requests to Railway's `t3.storageapi.dev` host.
  Local Wrangler authentication was requested for bulk R2 transfer and deployment.
  Creating resources through the plugin does not authenticate the local CLI.

## Verification

`pnpm verify` passed on September 12, including 56 integration files and all 656
integration tests (776.50 seconds). The six importer/deployment-gate tests passed,
as did scoped database lint/typechecking, Oxlint, formatting and documentation
checks. Both preview Wrangler configurations completed dry-run builds. Local D1
accepted the full import, and hosted D1 row hashes and foreign keys were verified.
Authenticated candidate/provider smoke checks and final cutover remain pending;
these results do not mean the Railway preview has switched.

## Repeatable preparation

`packages/db/scripts/preview-import.ts` owns conversion and reconciliation.
The CLI accepts an exported preview snapshot and a provider-verified Stream map:

```sh
pnpm --filter @my-tuums/db db:prepare:preview \
  --source /absolute/private/source.json \
  --streams /absolute/private/streams.json \
  --output /absolute/private/new-import.sql
```

The importer is offline and creates only a new SQL file and a reconciliation
report, both mode 0600. It refuses to overwrite either file. It accepts only the
recorded preview environment ID, requires every legacy application table, rejects
unknown tables/columns and unfinished video work, and requires private, ready,
environment-matched Stream mappings for published videos. Source SQL dumps and
all original video fields stay in the archive; legacy queue history is not replayed
as new Cloudflare work.

It preserves IDs and values, converts PostgreSQL timestamps to epoch milliseconds,
booleans to integers and arrays/JSON to JSON text. It changes video provider
metadata and attachment playback paths explicitly. It does not invoke auth hooks,
create users, grant badges, send historical emails or refresh the game catalog.
It applies the seven committed native migrations locally, verifies foreign keys,
reconciles all converted rows, and writes a D1-compatible SQL file with parents
before children and triggers installed after data. Favorite counts are checked
against favorite rows rather than being doubled by insertion triggers. The native
Drizzle migration ledger is carried forward; the PostgreSQL ledger is archived.

Import only into a verified empty preview target during rehearsal. A repeated
cutover import requires a fresh target or an explicit offline reset of the isolated
candidate after accounting for its test writes. Never apply this full snapshot to
an environment accepting user writes. Normal later migrations use:

```sh
pnpm db:migrate --remote --environment=preview
```

Database administration validates the exact account, Worker, database and bucket
pair. Local preview administration persists separately from local PoC state.
Existing media maintenance CLIs still default to the PoC; preview maintenance runs
through the preview jobs Worker.

## Ordered deployment

After the migration branch has been committed, pushed and passed both GitHub CI
checks, run `pnpm --filter @my-tuums/db deploy:preview` from a clean checkout.
Supply the preview `VITE_GOOGLE_CLIENT_ID` and
`VITE_SOCIAL_PROVIDERS=google,discord,twitch` as build environment variables.
The command refuses another branch, a dirty or changed checkout, or missing/failed
`Verify` and `E2E tests` checks for the exact commit. It builds, applies committed
preview migrations, deploys jobs, then deploys the application. A failed step stops
the sequence. Local Wrangler must be authenticated and preview secrets must be
configured. This is an operator-triggered pipeline; automatic push deployment is
not enabled during rehearsal. Future Workers Builds automation must preserve the
same CI and deployment ordering gates.

## Remaining deployment and cutover sequence

1. Finish R2 copies and verify every destination object against the backup ledger.
   Preserve backups in the archive bucket, outside active cleanup namespaces.
2. Import and reconcile hosted D1; verify the seven migration hashes, all table
   counts, row digests and foreign keys. Record Stream mappings in the protected
   migration ledger.
3. Configure preview credentials and frontend build variables, deploy jobs then
   application from one verified commit, with schedules disabled. Confirm Access,
   private media, real authentication, images, video and transactional email.
4. Establish CI-gated, ordered preview deployment. A successful build alone does
   not authorize automatically changing production or deploying unverified code.
5. Freeze writes to Railway preview, stop every scheduled/background writer after
   draining work, capture final database/media snapshots, repeat conversion and
   reconciliation, and verify no source changes occurred during export.
6. Set the final preview origin and existing Access audience, then switch only
   `preview.mytuums.com`. Preserve the old CNAME and preview edge-secret transform
   for recovery; remove the transform from the native path once verified. Test
   final-origin auth and access before reopening writes and enabling Cron.
7. Observe for seven days. Retain frozen Railway preview and backups. Before new
   Cloudflare writes, routing rollback is possible; afterward, forward-fix or
   reconcile all new data before reopening Railway. Retire preview-only Railway
   resources after successful observation. Production and its Resend use continue
   until a separately authorized migration.

Current rollback DNS: record `cbc32191096f4c449fcb19fc47e07830`, proxied CNAME
`preview.mytuums.com` → `gfi00vwx.up.railway.app`. Existing Access app
`32aef62f-57e1-4940-9def-c11c2a58e878`, audience
`6a8abc536bcca8df6a610bf39889bf089c297137124b0ce515dfb949130beca5`.
