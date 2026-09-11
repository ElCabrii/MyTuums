# Cloudflare PoC: validation report

Status: local implementation verified in stages; hosted validation is incomplete.
This is the report for `codex/cloudflare-poc`, prepared September 11, 2026.
The implementation scope remains [the migration plan](cloudflare-migration.md).
Production stays on Railway. This report does not authorize a production cutover.

## Feature parity evidence

The table separates application behavior exercised locally from provider behavior
that requires the deployed PoC. Passing synthetic provider tests does not establish
that the account can send mail, transform images, encode video or complete OAuth.

| Capability             | Local evidence                                                                                                                       | Hosted evidence still required                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Web and backend        | Actual Worker/static-asset bundles, HTTP body limits, headers, SPA routing, RPC and missing-asset responses                          | Both PoC hostnames, latency, routing and asset behavior                                               |
| Access and rate limits | Signed JWT checks and SQLite Durable Object concurrency/restart tests                                                                | Owner-only Access, alternative URL denial and deployed counters                                       |
| Authentication         | D1 auth integration; native password hashing/session tests; browser TOTP and passkey ceremonies                                      | Google/Discord/Twitch callbacks, One Tap, real verification/recovery mail and PoC passkey origin      |
| Social features        | D1 feeds, post/reply/quote, reactions, relationships, privacy, profiles, search, notifications and game-favorite suites              | Representative authenticated and unauthorized journeys through Access                                 |
| Moderation and appeals | Guarded D1 batches, simultaneous action/refusal tests, signed appeal capabilities and durable notice recovery                        | Hierarchy, suspension/revocation and live appeal links through the deployed app                       |
| Transactional email    | Existing bilingual templates, native runtime rendering, bounded provider-error retries; moderation notices recover through Workflows | Verified sender, delivery/suppression behavior and real test recipients                               |
| Images and files       | Private local R2, upload/authorization races, variant handling and native Images emulation                                           | Actual Images codecs, orientation, metadata, animation and private R2 delivery                        |
| Video                  | Stream protocol fixtures, resumable browser upload, explicit publish, Workflow polling, deadlines, captions and cleanup              | Real encoding, playback signing/expiry, direct-upload recovery and account limits                     |
| Game sync              | Native Workflow with synthetic 5,000-game input, R2 covers, catalog staging, replay fencing and favorites                            | Live IGDB/Twitch credentials, cold sync performance and daily scheduling                              |
| Notification pruning   | Native multi-batch pruning, continuation intent, Monday scheduling and retained moderation notices                                   | Deployed scheduled execution and operational monitoring                                               |
| Link previews          | Unsafe outbound preview fetching is declined; the post retains a plain link                                                          | This is the plan's permitted fallback; rich previews need a proven connection-time destination policy |
| Branding               | Actual branding Worker bundle, gated assets and PoC metadata                                                                         | Access-protected branding hostname and production-link isolation                                      |
| Recovery               | Local SQL export/import of seven migrations, schema/data comparison, foreign keys and restored triggers                              | Coordinated hosted D1/R2/Stream/Workflow recovery and exact teardown rehearsal                        |

The last complete browser/HTTP run passed 107 checks before the durable moderation
email addition. The new mail work passed 109 scoped moderation/appeal checks and
eight native Workflow checks. Full `pnpm verify` then passed: 1,521 unit/native checks and 656 integration
checks across 56 D1 suites (782.74 seconds for integration). Final documentation
and source-map configuration received separate checks afterward.

GitHub CI subsequently passed both Verify and E2E tests for commit `a4265e9`,
including the durable moderation email changes. See [the completed run](https://github.com/ElCabrii/MyTuums/actions/runs/34593742228).

Hosted D1 SQL export/import also passed against a disposable EU database: all 114
schema objects matched exactly, the seven-entry migration ledger matched, and
foreign-key validation found no violations. The source contained no application
users; this verifies schema and ledger recovery, not populated application or
coordinated media/job recovery. The temporary database and local SQL backup were
removed. See [the recovery record](artifacts/cloudflare-poc/d1-recovery-2026-09-11.json).

## Railway baseline

Read-only Railway plugin inspection on September 11 found five production services,
all reporting successful latest deployments. Game sync uses `0 0 * * *` and
notification pruning `0 4 * * 1`, matching the Cloudflare schedule design.
The PostgreSQL volume is provisioned for 500 MB in Railway's European region;
the production media bucket is in Amsterdam.

The seven-day metric query used hourly samples (169 returned per measurement):

| Production service   | Average memory (GB, decimal) | Maximum sampled memory (GB) |
| -------------------- | ---------------------------: | --------------------------: |
| Web/backend          |                       0.1842 |                      0.5175 |
| PostgreSQL           |                       0.0716 |                      0.1748 |
| Video worker         |                       0.0130 |                      0.1910 |
| Game sync            |                       0.0174 |                      0.1581 |
| Notification pruning |                            0 |                           0 |

The current database-service disk sample is 0.1306 GB. This is a small observed
resource footprint, but disk usage is not a logical database export size. Hourly
samples can miss short job peaks; zero samples do not prove that a job never ran.
These measurements are not billing totals, request counts or Stream video minutes.
The captured measurements are preserved in [the baseline artifact](artifacts/cloudflare-poc/railway-baseline-2026-09-11.json).
Source: the [production Railway project](https://railway.com/project/ffdcd3e4-918b-4d72-aae3-971a3c6b1438?environmentId=814c546d-cae5-4e1f-bd9f-7930eae09ea8).

## Deployment and decision

Owner-only Access applications, EU D1 and private EU R2 are provisioned. D1 now has
all seven committed migrations: its 114 schema objects match local output exactly,
the migration hashes match, and no foreign-key violations or application users
exist. See [the initialization record](artifacts/cloudflare-poc/d1-initialization-2026-09-11.json).
The committed fixture is now seeded remotely: 28 games and 26 private R2 cover
objects (22,897 bytes). Fixture values and staged payloads match the fresh local
seeder run; database-generated creation/publication timestamps were validated
separately. Every object matches its source SHA-256 and content type. No
foreign-key violations, pending upload intents or held catalog lease remain.
There are still no application users. See [the fixture record](artifacts/cloudflare-poc/fixture-seed-2026-09-11.json).

GitHub repository access now works and its connection has been created. Stream
reports 1,000 storage minutes. Email Sending is enabled for `mytuums.com`, with
DNS status `ready` and a 200/day quota. Branding is deployed at
`about-cf-poc.mytuums.com`; anonymous page and asset requests redirect to Access,
and its workers.dev URL returns 404. The jobs Worker is deployed through Workers
Builds, with video, maintenance and game-sync Workflows and the one-minute Cron.
See [the jobs deployment record](artifacts/cloudflare-poc/jobs-deployment-2026-09-11.json).

The build token and dedicated runtime secret names are configured. The owner
reports registering the PoC OAuth applications. External credential validity,
OAuth callbacks and live email/video behavior still require hosted verification.
The app deployed successfully from commit
`07c7ce2cfb23f5293afbf2e654a8fa4492e9bdb3` at `cf-poc.mytuums.com`. Anonymous
homepage and auth-session API requests redirect to Access; workers.dev returns
404 and preview URLs are disabled. Authenticated behavior remains unverified.
See [the app deployment record](artifacts/cloudflare-poc/app-deployment-2026-09-11.json).
App and jobs automatic build paths are excluded pending coordinated deployment
ordering. Their manual builds target only `codex/cloudflare-poc`.

The cost figures in the migration plan are illustrative platform prices. A measured
Cloudflare estimate must include app requests/CPU, D1 rows/storage, image transforms,
R2 operations, Stream storage/delivery minutes, email, Workflows, Durable Objects,
scheduled idle work, builds and observability. It cannot be inferred from Railway
memory samples alone.

Recommendation at this stage: continue the isolated PoC and resolve deployment
access. There is enough local evidence to justify hosted testing, but not enough
to recommend a production migration. The final adopt/revise/stop recommendation
depends on the hosted feature checks, recovery rehearsal and measured usage.

## Cold catalog import timeout

The first live game-sync attempt timed out after 30 minutes before publication.
D1 contained 3,809 upload intents and the active catalog remained the 28-game
fixture. An intent alone does not prove its R2 upload completed. The old Workflow
`games-1789135434886` was terminated before deploying a correction.

The correction separates cover CDN downloads from authenticated IGDB API pacing
and processes four covers concurrently, including their D1 intents and R2 writes.
API query pacing, download validation and retry/backoff remain intact. Publication
still waits for every cover decision and atomically replaces the catalog under
its lease. This addresses serialized network latency; it does not add partial-run
resume. A timed-out unpublished run still cannot reuse its covers on retry.

The regression test holds one CDN response open and confirms another download can
complete. It failed before the change and passed afterward. Hosted completion and
cold-import duration must be measured before calling the timeout fixed remotely.

The corrected code passed `pnpm verify`: 656 D1 integration tests across 56 files
(744.85 seconds), plus the unit/native, build, lint, type, format and schema gates.
Workers Builds deployed commit `83f18a1151c5af5759c7da9cbaf34f5fe53c1a97`
as jobs version `90914399-5dd1-44b9-9831-b1b43ca90e27`.

The next live run completed cover processing and staged 5,079 rows but failed
publication. Readback revealed duplicate slugs between real IGDB IDs and the
fixture's invented IDs (for example, Apex Legends IDs 114795 and 900023).
The 28 existing fixture slugs were prefixed with `poc-fixture-`, their synthetic
popularity ranks cleared, and their active staged payloads updated to match.
IDs, hashtag keys and user references were preserved. A fresh live run,
`games-1789138913057`, is validating the repaired data with the fixed deployment.
Future live PoC initialization must use an empty catalog or namespace fixtures
before the first import; development fixtures are not real IGDB records.

The final live run completed successfully on its first attempt, from
15:02:07.997 to 15:11:49.038 UTC (9 minutes 41 seconds). Its result reports
5,000 selected games, 100 upcoming candidates, 5,003 covers uploaded, 26 retained
fixture covers and zero cover failures. The published union contains 5,079 games
(including 28 preserved fixtures), with 5,029 cover paths. D1 readback confirms
active version `f822f83f-09aa-42fa-ab75-5381336459a3`, no held lease, no remaining
upload intents for that version and no foreign-key violations. Real-cover browser
delivery is a separate check from successful import and storage publication.
