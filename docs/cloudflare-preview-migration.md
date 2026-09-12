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
or deployment preview URL. The final preview origin and its existing Access audience are now deployed.
The candidate hostname has been detached. Jobs remain unscheduled until the owner
confirms final-origin sign-in and media behavior.

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
  The final maintenance-window snapshot was captured after stopping the Railway
  application and background writers.
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
- Deployed the real candidate from verified commit `a2f3ff0a` to
  `preview-candidate.mytuums.com`. Both Workers keep workers.dev and deployment
  preview URLs disabled, and jobs have no schedules.
- Copied preview auth/OAuth, IGDB and appeal secrets directly into the new Worker
  secret bindings without displaying their values. The existing auth secret is
  preserved. The owner added `STREAM_API_TOKEN` to both Workers and completed
  local Wrangler OAuth authentication; both requirements are verified.
- Overnight PoC maintenance now shows successful automatic executions. The earlier
  absence of Cron evidence is no longer an established blocker.
- Completed and verified 3,117 active non-video objects and all 3,155 original
  archive objects against their SHA-256 hashes and sizes. Seven snapshot files
  are also verified in the archive. Both R2 buckets have public access disabled.
- Candidate HTTP checks passed for the preserved owner session, game listing,
  stored game cover, both videos’ signed playback, posters and timeline previews.
  Requests without Access credentials are refused by the edge.
- Native Images produced a verified WebP. Cloudflare Email Service accepted the
  one authorized test email, and Gabriel confirmed inbox delivery. Native Stream
  upload creation and cancellation passed; disposable provider uploads and their
  candidate database records were removed afterward.
- Gabriel authorized a four-hour service token and candidate-only Service Auth
  policy for verification. Remove both after candidate checks; the existing final
  preview and production Access policies remain unchanged.
- The first migration CI run passed Verify but exposed Chromium resource
  exhaustion while repeatedly loading the Vite development module graph.
  Browser tests now build the frontend before serving it through Vite preview.
  The existing handle-change regression passes against this deployment-shaped
  bundle. The tag-link journey uses its author's chronological feed to avoid
  depending on unrelated global ranking snapshots; ranked refresh retains its
  own dedicated journey.
- Preview deployments derive `VITE_WEB_ORIGIN` from their Worker configuration.
  Static metadata, client document heads and copied post URLs therefore stay
  within the candidate or final preview environment, rather than linking to PoC.

## Cutover, September 12

- Final commit `101ad5bed63646d0d1cfef53a1a61b5316c26675` passed both
  GitHub Verify and all 107 browser tests in run `34684957287`. The deployed app
  version is `c219b9cc-cf98-4551-9f4d-d8f9dce2822d`; jobs version is
  `81a370e4-03be-4d3c-ab83-0299941e0049`.
- Railway’s three preview writers have no connected source; the old game Cron
  schedule is removed. Their deployments report `deploymentStopped: true`.
  Use the documented `deploymentStop` API for this operation. The installed CLI
  interpreted zero replicas as removing the region and supplied a default region;
  preview’s original European region was restored before the final export.
- The final PostgreSQL dump and two independent application exports agree with the
  rehearsal: all 29 application tables and 2,812 rows are unchanged. The source
  media inventory still contains the same 3,155 keys, ETags and sizes. No unfinished
  video, submission, cleanup obligation or active legacy job remained.
- D1 still matches every converted row and all seven migration hashes, with zero
  foreign-key violations. No second full import or target reset was necessary.
  Thirteen final snapshot/verification files are hash-verified under the private
  archive’s `migration-20260912/final/` prefix and copied to durable local backup.
- Replaced only the old preview CNAME with the Worker custom domain. Cloudflare
  refused to attach while the Railway CNAME existed, so its exact saved record
  was removed before domain attachment. Worker domain ID:
  `70d48b833cd761209fee2ac07fd83c41e209d53c`.
- Existing preview Access policy `00c33257-20eb-4937-9869-62e52c7c695b` is
  unchanged, including its four allowed identities. The final URL has valid TLS
  and redirects unauthenticated requests to Cloudflare Access. Disabled only
  preview’s legacy edge-secret transform; retained it for recovery.
- Removed the temporary candidate Service Auth policy/token, candidate Worker
  domain and temporary Railway SSH key/agent. Production deployments are unchanged.
- The old preview PostgreSQL deployment and its 5 GB volume remain retained. A
  stop was requested, but its stopped flag has not yet confirmed completion; do
  not describe all Railway resources as shut down or billing as ended. The native
  application uses only D1. Preserve source data/backups for at least seven days
  after cutover, through September 19, before separately retiring them.
- Owner confirmation of sign-in, existing posts, covers and video at the final
  URL is pending. Native schedules remain paused until that check is complete.

## Verification

`pnpm verify` passed on September 12, including 56 integration files and all 656
integration tests (776.50 seconds). The six importer/deployment-gate tests passed,
as did scoped database lint/typechecking, Oxlint, formatting and documentation
checks. Both preview Wrangler configurations completed dry-run builds. Local D1
accepted the full import, and hosted D1 row hashes and foreign keys were verified.
The exact candidate commit passed GitHub Verify and all 107 browser tests. Hosted
candidate/provider smoke checks passed. Final source freeze, reconciliation and hostname cutover are complete. Owner
confirmation of final-origin OAuth/media and schedule activation remain pending.

The post-cutover `pnpm verify` run also passed, including all 656 integration
tests in 56 files (846.18 seconds). Final formatting and documentation checks
passed after updating this record.

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
Preserve preview's existing public `VITE_GA_MEASUREMENT_ID`; its
`GOOGLE_ANALYTICS=enabled` Worker setting enables the matching CSP sources.
The browser retains the existing opt-in consent behavior.
The command refuses another branch, a dirty or changed checkout, or missing/failed
`Verify` and `E2E tests` checks for the exact commit. It builds, applies committed
preview migrations, deploys jobs, then deploys the application. A failed step stops
the sequence. Local Wrangler must be authenticated and preview secrets must be
configured. This is an operator-triggered pipeline; automatic push deployment is
not enabled during rehearsal. Future Workers Builds automation must preserve the
same CI and deployment ordering gates.

## Cutover procedure and retention

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
