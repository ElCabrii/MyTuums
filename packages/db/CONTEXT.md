# packages/db context

Cloudflare PoC: `src/index.ts` now exports `createDatabase(binding)`, `Database`
and `pingDb(db)`, with no global connection. `Database` excludes interactive
transactions. SQLite schema and generated auth tables use epoch milliseconds.
Generate/check D1 migrations through `drizzle.d1.config.ts`; the old `drizzle/`
folder is historical PostgreSQL DDL. `src/testing/d1.ts` supplies ephemeral local
workerd databases. Founder grants and bootstrap promotion use D1 through
`scripts/admin.ts`; committed migrations use `scripts/migrate.ts`. `db:test:setup` validates an
ephemeral D1 binding. `@my-tuums/db/poc-database` exposes the guarded, Node-only
administration connections to maintenance CLIs; never import it into a Worker.
`openPocDatabase` binds only D1; `openPocMedia` binds the matching D1 and EU R2
bucket. Both validate the fixed PoC account/resource identities, share Wrangler's
local development persistence and load no `.env` or unrelated app bindings.
Remote access is explicit; media commands cannot combine one environment's
bucket with another database.
The PostgreSQL config, direct schema-push/Studio commands and test-URL helpers
have been removed on this branch. Use committed native migrations.
`scripts/rehearse-recovery.ts` owns the local SQL recovery rehearsal. It creates
two fresh `_test` databases, exports/imports through the installed Wrangler CLI,
compares schema/data and exercises restored triggers. It accepts no target or
remote option, loads no environment files and removes its own temporary files.
It does not open the application's local or hosted PoC resources.
See [migration status](../../docs/cloudflare-migration.md). The map below records native ownership and invariants.

The deployed PoC migration baseline is `drizzle-d1/0000_cloudflare_initial.sql`;
`0001_database_invariants.sql` owns handle normalization, the two expression
indexes Drizzle Kit cannot generate correctly, and `user_delete_post_tree`.
Account deletion materializes its full reply descendant set and deletes that
set atomically. The parent foreign key uses NO ACTION: a recursive cascade
exceeds D1's trigger depth on long conversations. Other authors' quotes and
unrelated posts survive. Normal post deletion remains a tombstone. Preserve
these custom invariants whenever rebuilding tables or regenerating a baseline.

`0002_game_favorite_counts.sql` backfills the public game favorite count and
maintains it on favorite insertion, deletion and game reassignment. These
triggers also run for account-deletion cascades. Application writes must not
adjust the counter separately; catalog refreshes preserve it.

Before deployment, the baseline was regenerated from the current schema when video
ownership moved fully to Stream. It includes media intents, catalog versions,
Workflow intents and Stream state. The remaining migrations are custom SQL:
`0003_media_cleanup_triggers.sql` for profile/link/post images,
`0004_game_cover_cleanup.sql` for catalog covers, and
`0005_stream_cleanup_triggers.sql` for video termination/orphan cleanup.
The previous experimental migration sequence was never applied remotely. The
current seven migrations, through `0006_durable_moderation_email.sql`, were applied
to the isolated EU PoC database on September 11 from commit `9078e60`. All 114
schema objects and ledger hashes match local migration output. Evolve this
deployed baseline with new committed migrations; never regenerate or reset it.
Historical PostgreSQL migrations under `drizzle/` remain unchanged.

Video rows require a creator identity and retain a private upload capability,
provider UID, deadline and verified width/height/duration/caption metadata.
Ready/published rows require valid Stream metadata; no source object, multipart
ID, leased encoding attempt, rendition inventory or source-deletion flag remains.
`post_attachment.byte_size` for videos is the accepted upload size, since Stream
does not expose a derivative inventory. Cleanup has no owner/video foreign key.
State transitions and account/post cascades capture its provider UID or opaque
creator lookup target; retirement of terminal rows must not recreate cleanup.

Publication's D1 batch first latches author/target/deadline eligibility. Its
intermediate published state has no post ID until the same batch inserts the
post and effects and attaches its ID; no caller can observe that intermediate
state. A committed published row with no post ID is an orphan, never playable.
Failure commits its notification, pending-text erasure and cleanup together.
Provider operations always happen outside the database transaction.

Catalog versions stage invisible rows and atomically update the permanent game
projection and active pointer. Stable IDs preserve favorites and hashtag keys.
Immutable cover paths and upload intents protect in-flight PUTs; the cover
trigger captures superseded storage in the publication commit.
Workflow scheduling intent also commits with its source transition. Intents
contain IDs and retry timestamps, never text/captions, and have no owner FK.
Dispatch acknowledgement proves instance creation, not completion.

## Responsibility

The D1 + Drizzle data layer: explicit binding-based database construction,
hand-written app tables, generated Better Auth tables, committed migrations and
ephemeral local workerd test databases. It serves data only — no HTTP. Legacy
administrative scripts and deployment callers still require their runtime port.

## Start here

| File                   | Why                                                                           |
| ---------------------- | ----------------------------------------------------------------------------- |
| `src/index.ts`         | `createDatabase(binding)`, `Database` and `pingDb(db)`; no global connection. |
| `src/schema/app.ts`    | The hand-written tables; its comments record the load-bearing choices.        |
| `src/testing/d1.ts`    | Isolated local D1 databases with actual committed migrations.                 |
| `drizzle.d1.config.ts` | The native schema and migration output directory.                             |

## Change map

| Intent                                     | Primary                                                          | Also touch                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add or change an app table                 | `src/schema/app.ts`                                              | `pnpm db:generate`, then commit `drizzle-d1/`; an index if a cursor reads it                                                                     |
| Change an auth table                       | `packages/auth/src/index.ts`                                     | `pnpm --filter @my-tuums/db db:generate:auth`, then `pnpm db:generate`                                                                           |
| Add an index for a new list                | `src/schema/app.ts`                                              | the `keysetPage` call in `packages/api` it must mirror                                                                                           |
| Add or change a ranked-feed snapshot field | `src/schema/app.ts` (`feedRankSnapshot`, `FeedRankSnapshotItem`) | migration `0035_charming_sandman`; `packages/api/src/feed-rank.ts` (the only reader/writer); `docs/operations.md` Migrations                     |
| Change how migrations are applied          | `src/migrate.ts`                                                 | `scripts/migrate.ts`, `../../apps/server/wrangler.jsonc`                                                                                         |
| Change test-database handling              | `src/testing/d1.ts`                                              | `scripts/setup-test-db.ts`, `e2e/global-setup.ts`                                                                                                |
| Add a maintenance script                   | `scripts/`                                                       | the `scripts` entry in `package.json`                                                                                                            |
| Edit the games fixture                     | `fixtures/games.json`                                            | hand-authored seed data (never generated); `packages/api`'s `games-fixture.test.ts` pins its contract, and its seeder uploads `fixtures/covers/` |

## Invariants

- **Video lifecycle state outlives its owner.** Pending text/captions are
  outside `post` and cascade with their author. Stream cleanup and failure
  notices retain their opaque video ID independently. Terminal state changes
  record cleanup in database triggers, including account and post cascades.
- **Connections are explicit.** No database is constructed at module import;
  callers supply the environment's D1 binding. Test databases are ephemeral
  Miniflare/workerd instances, isolated per integration file.
- **App tables stay in `src/schema/app.ts`.** `src/schema/auth.ts` is
  regenerated wholesale; anything hand-written there is destroyed.
- **`src/schema/auth.ts` is generated.** Regenerate it with
  `pnpm --filter @my-tuums/db db:generate:auth`, which runs the better-auth CLI
  and then `scripts/patch-auth-schema.ts`. That script's header explains what
  it patches and why.
- **Composite primary keys are the idempotency mechanism.** Uniqueness for
  likes, reposts, follows, reports, blocks and stamped badges lives in the
  PK, so handlers use `onConflictDoNothing` instead of a read-then-write
  race. Badge stamps additionally upgrade in place — one row per tiered
  family, the crossing that earns a higher tier deleting the lower one
  (packages/api/src/badge-stamping.ts) — and the join badges are stamped
  exclusively (the higher of the tiers the rank earned). The
  `user_badge.badge` check constraint repeats the badge catalog
  (`BADGE_IDS` in `@my-tuums/api/badges`) as a SQL literal, and
  `src/stamp-join-badges.ts` repeats the join family's ranks and ids — the
  dependency points one way, so keep the copies in step.
- **A quote reference is deliberately FK-less.** `post.quoted_post_id` names
  another post, but a hard delete of that row (today, through its author's
  account cascade) must not delete the quoting author's own post. Readers
  resolve the reference and render the embedded post as unavailable when the
  target row is gone. Quote references must not participate in the account
  deletion trigger's reply-descendant traversal.
- **Timestamps use integer epoch milliseconds.** Drizzle decodes them to
  `Date`; raw SQL uses the same millisecond scale for keyset cursors and clocks.
- **Indexes mirror the cursors.** Every index is ordered to match the keyset
  comparison in `packages/api`; `post_created_idx` is deliberately partial
  (top-level posts only). Adding a paginated list without its index turns a
  page fetch into a table scan.
- **Migrations are committed and shipped**, applied once by the pre-deploy
  step — never at server boot, where N replicas would race the same DDL.
- **The two handle columns cannot diverge.** Custom migration 0001 owns
  insert/update normalization triggers; auth hooks and direct writes share
  the same lowercase database boundary.
- **Test execution has no remote connection path.** `src/testing/d1.ts`
  applies committed migrations to an ephemeral binding. Legacy URL-based
  administrative helpers remain guarded and must be ported before use.
- **A rank snapshot is viewer-owned, scope-bound, and content-free (issue
  #305).** `feedRankSnapshot` holds ordered IDs with repost attribution
  (`FeedRankSnapshotItem[]`), never post text; the scope check constraint pins
  `global`/`following`/`discover`, and `q`/`gameSlug`/`gameHashtagKey` pin the
  filters the order was built under. The two indexes serve the two maintenance
  reads — the viewer's rows by expiry (per-viewer trim) and all rows by expiry
  (bounded global sweep) — and `viewerId` cascades with the account. Expiry is
  enforced by the reader, not the schema: the row stays servable until
  `expiresAt`, then is refused and reaped opportunistically.
- **Bound work per pass and preserve atomicity.** D1 batches replace
  interactive transaction callbacks; `Database` omits `.transaction` so an
  old caller cannot silently run a non-atomic compatibility implementation.

## Dependencies and boundaries

Source subpaths are compiled or inlined by their consumers. Admin commands use
`scripts/poc-database.ts`: it validates the application config against the exact
PoC account/database and opens a D1-only Wrangler proxy. Commands default to local
state shared with `apps/server` Wrangler dev; `--remote` explicitly selects the
isolated PoC database and requires Wrangler authentication. No `.env` is loaded.
They do not expose an HTTP administration route. Founder grants atomically enforce
three holders; bootstrap promotion atomically refuses all changes after the first
admin exists, including concurrent invocations. Provider/SQL errors are not printed.

| Subpath                 | Exports                                 | Consumers                                       |
| ----------------------- | --------------------------------------- | ----------------------------------------------- |
| `.`                     | `createDatabase`, `Database`, `pingDb`  | `packages/api`, `packages/auth`, `apps/server`  |
| `./schema`              | tables and relations                    | `packages/api`, `e2e`                           |
| `./testing/d1`          | guarded ephemeral D1 runtime            | native integration fixtures                     |
| `./poc-database`        | fixed PoC D1/R2 administration bindings | Node maintenance CLIs                           |
| `./migrate`             | `runMigrations`                         | `scripts/migrate.ts`                            |
| `./promote`             | `promoteUser`                           | `scripts/admin.ts`                              |
| `./grant-founder-badge` | `grantFounderBadge`                     | `scripts/admin.ts`, API badge integration tests |
| `./stamp-join-badges`   | `stampJoinBadges`                       | `packages/auth` (the user-create hook)          |

This package must not import `packages/api` or `packages/auth` — the
dependency direction is one way.

## Generated files

| Path                 | Generator                                     | Committed                           |
| -------------------- | --------------------------------------------- | ----------------------------------- |
| `src/schema/auth.ts` | `pnpm --filter @my-tuums/db db:generate:auth` | yes                                 |
| `drizzle-d1/`        | `pnpm db:generate`                            | yes — native schema plus custom SQL |

## Verification

Use `pnpm --filter @my-tuums/db db:generate` for schema changes, then
`pnpm --filter @my-tuums/db db:check`, scoped lint and typecheck. Generation
writes native D1 SQL and snapshots; review the SQL as well as metadata. Custom
triggers must survive table rebuilds. Schema behavior is exercised through the
API's real-D1 integration suites. The badge and bootstrap integration suites
exercise administrative invariants against real D1.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — schema split and migration lifecycle.
- [docs/operations.md](../../docs/operations.md) — how migrations run in production.
- [docs/security.md](../../docs/security.md) — the test-database guard.

## Preview migration

`scripts/preview-import.ts` converts the explicit preview snapshot offline, checks
all rows and foreign keys, and emits a new D1 SQL artifact with the native migration
ledger. `scripts/prepare-preview-import.ts` is its guarded CLI; importer tests use
Node’s test runner through `pnpm --filter @my-tuums/db test:unit`. See
[the preview migration record](../../docs/cloudflare-preview-migration.md).
`db:migrate --environment=preview` uses the exact preview resource pair from
`apps/server/wrangler.preview.jsonc`; the default remains PoC. Never use the full
snapshot importer against an environment that is accepting writes.

`deploy:preview` gates the clean migration branch against the exact commit’s
latest GitHub Actions Verify and E2E results, then builds and deploys migrations,
jobs and application in order. `preview-deploy-checks.test.ts` covers refusals
for missing, foreign, superseded and failed checks. This operator command does
not automatically cut over domains, freeze source writes or start schedules.
