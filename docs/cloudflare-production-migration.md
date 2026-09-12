# Production migration execution

## Authorization and release gates

Gabriel authorized the six-step production migration on September 12, 2026:
integrate current main, finish preview validation, provision isolated production
resources, rehearse and reconcile production data, perform a coordinated cutover,
then retain the old Railway data for 14 days. Permanent deletion requires a new
approval. The cutover is authorized after automated checks and owner verification
of the candidate pass, within a rehearsed 30-minute maintenance budget.

The validated native implementation may be merged into main, including removal of
legacy Node server, Docker and PostgreSQL runtime files there. This supersedes the
earlier branch-only restriction; other branches remain untouched. Exactly one
clearly labelled production-migration test email to the owner's approved address
is authorized. Cloudflare accepted the single authorized production migration test at approximately 12:08 UTC; Gabriel confirmed inbox delivery in conversation.

Production remains live on Railway. Do not disconnect sources, freeze writes,
change production DNS, or merge the native runtime into main until the release
gates below pass. Railway currently auto-deploys main, and branch protection still
requires Verify, E2E tests and Docker image builds. Coordinate replacement of the
obsolete Docker gate with actual native artifact validation at release time.

## Working state

- Isolated branch: `codex/cloudflare-production` in `/home/gabriel/.local/share/mytuums/worktrees/cloudflare-production`.
- Starting native revision: `d0f2c3341e967c64fc1e4165f8bb543d86a28fb0`.
- Incoming main revision: `dd220dd50cbbc9f0cd32db62676ca1525decdd1f`.
- Main integration was committed as `6d3fff25e4c88f4887f66faca4c1cd3e5fc27239`
  and opened as draft PR #396. The incoming UI changes merged cleanly.
  Full local Verify passed, including 662 integration tests; all 107 browser
  checks passed. Hosted CI remains a deployment gate.
- The production PostgreSQL 18 unaccent dictionary was captured read-only. Its
  SHA-256 is `ecf4c41c0883dee17d02431e0a7f24a2611aadf8fe1da06e98c6ccb4acc4a981`.
  The port now uses that exact dictionary; 51 focused search tests pass.
- Preview owner sign-in/media verification was confirmed in conversation.
  Preview Cron was enabled at 12:12 UTC. Eight recovery Workflow instances had
  completed successfully by 12:22 UTC; production schedules remain disabled.

## Resource identities

Cloudflare Ops account: `734f3b84571b1967e6940140a0b7d75f`.
Zone: `e596b15a6c397986f91c737c156b7100`.

| Resource      | Identity                                                     | Current state                                                            |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Production D1 | `mytuums-production`, `e80d3f42-4fe5-41fb-90b7-32de79d25e0b` | Rehearsal imported and reconciled; EU/EEUR; replication disabled         |
| Runtime R2    | `mytuums-production-media`                                   | EU/private; 6,246 runtime objects checksum-verified                      |
| Archive R2    | `mytuums-production-archive`                                 | EU/private; 6,256 original objects and twelve snapshot archives verified |

The archive bucket must never be bound to runtime cleanup. The production
database/bucket/Stream namespace must remain isolated from preview and PoC.
The production app/jobs Workers are deployed only as a protected candidate at
`preview-candidate.mytuums.com`, using the rehearsal D1/R2 copy. Production
schedules remain empty. The actual production domains and Railway writers have
not changed. Temporary network diagnostic Workers and their Container were removed.

Railway project: `ffdcd3e4-918b-4d72-aae3-971a3c6b1438`.
Production environment: `814c546d-cae5-4e1f-bd9f-7930eae09ea8`.
Source PostgreSQL service: `c8bfea31-83fb-4ef4-b833-65ec0984aa2d`.
Source bucket: `3e59642c-5ae0-4254-bb45-b8bfeea36516` (`mytuums-media`).
Both `mytuums.com` and `about.mytuums.com` must move before retiring the server.

## Rehearsal snapshot

Private files are under `/home/gabriel/.local/share/mytuums/production-migration-private`, mode 0700;
credentials, snapshots and media are excluded from Git. Rehearsal snapshots and
media have also been checksum-verified under
`/home/gabriel/.local/share/mytuums/production-migration-20260912`. API tokens and
SSH keys are excluded from that durable backup. Six snapshot files are verified
in private archive R2 under `migration/20260912-initial/`.

The first full PostgreSQL dump is 4,912,953 bytes. The separate repeatable-read,
read-only application snapshot contains 29 tables and 6,355 rows: 13 users,
56 posts, 6,015 games and one published video, including passkey, two-factor and
moderation/appeal data. This online snapshot is a rehearsal, not the final state.
The initial source readiness check found zero unfinished videos, submissions,
video cleanup obligations or active legacy jobs.

Media inventory: 6,256 objects, 165,245,601 bytes. All originals are backed up
locally with size, ETag and SHA-256 checks. All 12,502 destination copies are
verified. The existing video was remuxed without re-encoding from its surviving
360×640 HLS rendition, imported as private Stream video
`6b53813e4fe7887892e9680ba870b94d`, and verified ready (12.67 seconds).
All 29 D1 tables / 6,355 converted rows match the rehearsal checksums, all seven
migration hashes match, and the foreign-key check returns zero violations.

Temporary Railway SSH key registration:
`e5569bac-6f26-4fb7-b7ee-be9fb7afe5a0`, named
`mytuums-production-migration-20260912`. Remove this registration, the private key
files and the private SSH agent when migration access is no longer needed.
The database has no usable public endpoint; use the private SSH export path.

## Execution checklist

1. Complete main integration, search parity, local development/browser validation,
   full Verify and native E2E, then deploy the verified revision to preview.
2. Enable and observe preview schedules; prove link-preview transport safety and
   hosted functionality. Preserve production's public routes, metadata, caching,
   authentication, client-IP trust and media authorization in native configuration.
3. Prepare isolated app/jobs/branding configurations, CI-gated deployment, native
   production secrets, alerts, email suppression handling and provider capacity.
   Preserve the existing auth secret; legacy appeal signatures use that same secret.
4. Adapt the strict importer for the production source/resource identities. Import
   into isolated D1, reconcile every converted row and every media object, and test
   Stream playback. Suppress incidental mail and schedules during rehearsal.
5. Complete owner candidate verification and measure final export/import and
   reconciliation within the maintenance budget. Recheck main for new commits.
6. At the coordinated cutover, freeze every source writer, drain jobs, capture and
   reconcile final data, verify native services, switch both production domains,
   reopen native writes and schedules, and record exact deployed versions.
7. Observe production, retain source database/media for 14 days, remove migration
   access, and ask before permanent source deletion. Resend must have no remaining
   application dependency before its credentials are retired.

After Cloudflare accepts new writes, DNS-only rollback is unsafe. Prefer a forward
fix or reconcile new D1/media state back to the source before reopening Railway.
D1 recovery alone does not restore R2, Stream, Workflow or rate-counter state.

## Candidate configuration and remaining parity issue

`apps/server/wrangler.production-candidate.jsonc` and the matching jobs file use
only the production D1/R2/Stream identities. The candidate uses
`preview-candidate.mytuums.com` with mandatory Access and noindex. Jobs have no
Cron triggers. The production files use `mytuums.com` and `about.mytuums.com`;
public admission is accepted only for those fixed origins. Private application
routes still require sessions, and media retains its per-object authorization.
Workers.dev and version preview URLs remain disabled.

The deployment command accepts `--target=preview|production-candidate|production`.
Candidate requires a clean `codex/cloudflare-production` checkout; final production
requires clean `main`. Verify, E2E and Docker image builds must pass on the exact commit. Preview
may deploy either verified native branch. Builds include the target's explicit
public origin in Turbo's cache key. Production has no configured GA measurement
ID, so its analytics/CSP flag is disabled. Preview retains its existing setting.

Crawler source documents are retained from main under each app's
`crawler-documents/`. Vite emits those only for the public production build;
private builds emit disallow/noindex-oriented documents. Production branding
links point to `mytuums.com`.

Rich links now use the private Cloudflare Container described below. Hosted
candidate API and browser checks verified a new card's metadata and mirrored R2
image. The Node transport retains connect-time address validation and hostname
TLS verification. The earlier Workers socket experiment was removed after it
failed valid-site TLS checks. Ordinary DNS preflight plus unpinned fetch is not
an acceptable replacement.

Email Service currently allows 200 messages/day. Resend's available history has
28 delivered messages and zero suppressions (complete responses, no next page).
Cloudflare's suppression list is empty. The authorized production test has been
accepted by Cloudflare and confirmed in Gabriel’s inbox; do not send another migration test.

Before merging into main, disconnect Railway's source deployments only after
candidate approval, while leaving the running production services available.
Then merge and validate the resulting main commit before beginning maintenance;
CI time must not consume the 30-minute data cutover budget. Production Cron and
source retirement remain later coordinated steps, not effects of preparation.

## Refresh rehearsal and CI recovery

A second read-only production export took 5.65 seconds and still contained 6,355
rows. The refresh procedure removes triggers before dropping tables in reverse
foreign-key order, then imports the schema, rows and triggers from the committed
migration-based converter. It was first checked locally with a deliberate
candidate mutation, then exercised against the unserved production D1 clone
after exporting a private backup. The hosted import processed 6,528 statements
in 531 ms. All 29 application tables, seven migration hashes and foreign keys
reconciled afterward; no cleanup side effects were introduced. This does not yet
measure the final media delta or the complete coordinated cutover.

The local full Verify and browser suites passed. Initial hosted checks failed
because the runner shares the developer machine: local E2E occupied port 3101,
and the host `/tmp` quota caused a SQLite write failure in the badge stress test.
Local browser processes have exited. CI now uses its own disk-backed temporary
directory for verification and browser commands, and push/PR events share a
branch concurrency key. Test requirements and deployment gates are unchanged.

Temporary candidate verification access is scoped only to
`preview-candidate.mytuums.com`: policy `cd0b938d-2e75-4650-8720-055b6c2b0127`,
service token `c36a787f-7f87-42c7-9709-92ee4fd194b2`, expiring September 12 at
16:31 UTC. Remove both after automated hosted checks. The owner policy is intact.

The CI temporary-directory fix also requires `globalPassThroughEnv: ["TMPDIR"]`
in Turbo: an isolated probe showed strict mode stripping the variable before
that addition, and preserving the disk-backed path afterward. The rapid-like
browser trace exposed a separate test race: reload cancelled the unlike request
before the final like was sent. A controlled 500 ms network delay reproduced the
failure; waiting for the final like response made the same probe pass. The delay
was removed, and the persistence assertion remains. No application rate limits
or mutation behavior were relaxed.

## Rich-link implementation and reboot recovery

Gabriel requested rich links be resolved before production switches. The pure
Workers socket experiment remains unsuitable. A private Cloudflare `lite`
Container successfully reused the existing Node fetcher: hosted valid HTTPS
requests passed, mismatched/expired/self-signed certificates failed, and loopback
and metadata addresses were refused. An eight-target cold probe completed in
3.6 seconds. The deployed private service subsequently returned the Cloudflare Workers card
metadata and its 917,439-byte PNG image through the application adapter. The
first cold request completed in 1.9 seconds. Browser verification against the
production candidate remains pending. A separate deployed caller Worker then
ran the actual adapter through a service binding and fetched both metadata and
the image in 1.3 seconds (1.9 seconds including the local proxy round trip).

`apps/link-fetcher` now provides the private service and Container. Only bounded
URL requests cross the service binding; no user cookies or provider secrets are
forwarded. D1 caching, moderation and R2 card images stay in the application.
Each environment has its own stateless instance, sleeping after 60 seconds.
Preview releases cannot update the production fetcher. Current platform pricing
includes Container memory, CPU and disk allowances in Workers Paid; actual
incremental cost depends on awake time and the account's other usage.

The September 12 reboot cleared `/tmp`. Committed work was restored to the
persistent worktree above. The durable migration snapshot and media directory
survived under `/home/gabriel/.local/share/mytuums/production-migration-20260912`,
and the private R2 archive remains available. Temporary credentials and scripts
must be recreated from current provider state before deployment or final export.
The lost candidate Service Auth policy and token were revoked; the owner policy
was preserved. The old temporary Railway SSH registration was also removed.
GitHub identified the interrupted Verify job as runner communication loss; it
was rerun and both Verify and all 107 E2E checks passed on `f047e39`. New
link-fetcher changes require their own exact
commit checks before application deployment.

The first full local run of the rich-link revision passed 661 integration tests
but timed out while seeding the 100,000-account badge fixture. A local benchmark
reduced 10,000-row setup from 562 ms to 181 ms by increasing the JSON batch from
500 to 5,000 rows; its largest parameter is 675,001 bytes, within D1's 2 MB value
limit. The unchanged seven badge assertions then passed in 32 seconds. Thresholds,
account counts and the 120-second deadline are unchanged. Deployment now also
waits for the newly provisioned private fetcher before exposing an application.

## Candidate deployment and verification — September 12, 15:30 UTC

Runtime revision `6c3b2053da75310aa9fa11ee34ee22bc6e5a0238` passed local full
Verify, including all 662 API integration tests. GitHub run `34700223711` passed
Verify and E2E. One composer layout test initially saw the loading screen and
passed its configured retry; ten subsequent repetitions with retries disabled
all passed. This does not establish the cause of the isolated CI failure.

The private deployment wrapper initially inherited mode 077 for generated build
files. The Container's non-root user could not read its owner-only bundle, and
the readiness gate stopped before replacing the preview application. Rebuilding
with normal public-artifact permissions corrected the wrapper; credential and
migration files remain private. No runtime authentication controls changed.

| Deployment                | Worker version                         |
| ------------------------- | -------------------------------------- |
| Preview app               | `09a7bd08-926e-4379-a9e1-3a2d56a66f31` |
| Preview jobs              | `f0969b68-2c20-446d-934b-263a1b67b7e7` |
| Preview link fetcher      | `23262cc8-22f8-4bc6-afb5-14c4a81fd746` |
| Production candidate app  | `fd605fc8-10f3-4a18-82f5-2a017ad5fca2` |
| Production candidate jobs | `25929952-6a7e-47b3-b291-de279046f003` |
| Production link fetcher   | `e521c48a-2c98-4d7f-bbdb-996494e6be43` |

Preview data was preserved and committed migrations were already current. Its
minute recovery schedule remains enabled, with successful instances observed
after deployment. Candidate/production schedules remain empty.

Candidate checks passed for health, preserved owner session, application page,
anonymous Access refusal, game cover delivery, legacy video previews, signed
thumbnail and HLS playback, new rich-card metadata/image, and Stream upload
creation/cancellation. Browser inspection confirmed all 20 visible game covers
loaded and a newly posted rich card displayed its title, description and image.
The disposable test post was deleted through the application's own procedure.

Automatic approval review rejected a broad maintenance Workflow test because its
cleanup scope included more than the disposable upload. That Workflow was not
run. The single cancelled test Stream upload was identified by its exact creator,
creation time and pending-upload state, then deleted separately. Its idempotent
cleanup intent remains in the rehearsal database. The existing imported video
was untouched. No additional migration email was sent.

The replacement temporary candidate Service Auth policy and token were revoked
after automated checks; only the existing Migration owner Access policy remains.
The private test browser was closed and its saved cookie/token files removed.
Owner candidate verification passed on September 12 after adding the candidate
Google OAuth callback and JavaScript origin to the existing client. Candidate trial changes will be replaced by the final frozen source
copy. Final source reconciliation and release coordination remain before
main/cutover. Local development and the transfer rehearsal are recorded below.

## Local development completion

A separate loopback composition now starts the real application and jobs with
persistent local D1/R2, Images, Workflows and captured email. The regression
checks account/mail persistence, hosted admission refusal and maintenance
removal through shared app/jobs storage. The first cleanup test used an invalid
media key; correcting it to the application's actual path contract made the
cross-worker cleanup pass. OAuth, Stream and IGDB remain hosted-preview checks.
The complete timed transfer rehearsal and release gates above remain required.

## Timed transfer rehearsal, September 12

The fresh read-only PostgreSQL snapshot (including current column types and an
exact public-table-set check) still contains 29 tables and 6,355 rows. JSON and
SQL exports took 2.20 and 1.72 seconds. All 6,256 source objects / 165,245,601
bytes match the earlier ETag/size inventory; no copy delta or deletion exists.

A new isolated EU D1 database imported all 6,476 SQL statements in 567 ms.
Every converted row checksum, all seven migration hashes and zero foreign-key
violations matched through the hosted binding in 10.91 seconds. That disposable
database was deleted after verification; the owner-approved candidate remained
intact. The final refresh SQL was separately tested with deliberate candidate-only
job debt: it drops 15 triggers and 37 tables in dependency order, restores the
snapshot, removes the trial debt and preserves every source checksum.

The Cloudflare media/archive comparison took 137.03 seconds: all 6,246 runtime
originals and 6,256 archive originals match verified size/checksum metadata.
Runtime R2 also contains two candidate-created objects; final reconciliation
must consider these against the frozen source. Eight fresh snapshot/report files
were archived and content-verified in 9.26 seconds. These component measurements
leave substantial room within the 30-minute maintenance budget; the final run
must still stop source writers and recheck the delta immediately before import.

All four legacy app/job services exist only in the production environment; dev
and CI have no Railway service instances, and preview uses distinct service IDs.
Before main merge, disconnect those four repository sources without stopping
the running deployments. Keep all three existing required checks. The Docker image check now builds
and checks the private Cloudflare Container; branch protection stays intact.
Wait for exact main CI before starting the maintenance timer. During cutover,
use temporary maintenance routes on both production hosts, stop and drain every
legacy writer, back up the candidate, import/reconcile final data, deploy the
verified main revision and perform read-only smoke checks before reopening.
Cloudflare [Worker routes take precedence over Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/routes/),
so the maintenance route can remain in place throughout domain replacement.

Automatic approval review rejected removing the Docker required check. The safer
release implementation retains main's protections and restores that CI job with
a real build of the Cloudflare Container plus a non-root bundle-read check.
No branch-protection setting was changed.
