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

No app/jobs/branding Worker or Workers Builds trigger has
been deployed. Stream/Email authorization checks and the GitHub Builds connection
remain unresolved. Dedicated runtime secrets and OAuth registrations are also
required before live verification.

The latest read-only checks still return Stream authorization error `10002` and
Email authorization error `2036`; these do not establish whether either product
is enabled. Builds has no tokens and cannot resolve the repository configuration.
The earlier connection attempt explicitly reported disconnected Git integration.
To unblock deployment, connect `ElCabrii/MyTuums` to Workers Builds in the Ops
account for `codex/cloudflare-poc` only, enable/authorize the required Stream and
Email services, and provision the dedicated PoC secrets/OAuth registrations
listed in [operations](operations.md). Keep credentials out of chat and source.

The cost figures in the migration plan are illustrative platform prices. A measured
Cloudflare estimate must include app requests/CPU, D1 rows/storage, image transforms,
R2 operations, Stream storage/delivery minutes, email, Workflows, Durable Objects,
scheduled idle work, builds and observability. It cannot be inferred from Railway
memory samples alone.

Recommendation at this stage: continue the isolated PoC and resolve deployment
access. There is enough local evidence to justify hosted testing, but not enough
to recommend a production migration. The final adopt/revise/stop recommendation
depends on the hosted feature checks, recovery rehearsal and measured usage.
