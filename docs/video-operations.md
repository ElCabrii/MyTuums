# Video worker operations

Production and preview use Stream for video storage/encoding and Cloudflare
Workflows for processing coordination. The native owner is
[apps/jobs/CONTEXT.md](../apps/jobs/CONTEXT.md). Local runtime tests and hosted
migration checks passed; current identities and preserved-video evidence are in
[the production execution record](cloudflare-production-migration.md).

## Cloudflare runtime

The jobs Worker handles video processing, game sync and maintenance. It has no
HTTP handler; workers.dev and preview URLs are disabled in its configuration.
Each hosted environment has an isolated EU D1 database, private EU R2 bucket,
Stream creator namespace and required secret bindings. Production and preview
Cron schedules are enabled; keep their minute triggers in committed configuration.

Each submitted video commits a stable Workflow intent with its private pending
post. A Workflow polls Stream and publishes only while D1 still permits it.
Selection and upload completion are not author consent to publish. Processing
expires after thirty minutes; abandoned uploads expire after twenty-four hours.
Minute maintenance enforces deadlines even when the original Workflow never ran.

Monitoring removes completed intents, restarts errored instances under the same
ID and retries unconfirmed creation/status without inventing a replacement ID.
Paused and terminated instances remain under operator control. A video still
has its database processing deadline while paused. Inspect identifiers, statuses
and counts; do not log captions, drafts or raw SQL/provider errors.

## Storage, playback and cleanup

Stream owns encoded video and source retention. The native runtime does not reproduce the
former FFmpeg codec, frame-rate, rendition, probe or source-deletion guarantees.
Its accepted behavior is documented in the migration record; the original native
media tests and benchmark measurements are historical evidence only.

Playback requires current application authorization before issuing a signed
Stream capability. Preview and PoC also require Access before token issuance. A holder
can use an issued playback capability directly until its one-hour expiry.

D1 records durable Stream cleanup obligations before owning rows disappear.
Retries survive post/account deletion, cancellation and ambiguous provider calls.
R2 stores images and covers privately. Minute maintenance drains cleanup intents;
a daily inventory lists objects before reading a consistent D1 reference snapshot.
Keep the database, R2 bucket and Stream namespace isolated by environment. Never bind the migration archive to cleanup.
Do not clear debt by deleting lifecycle or outbox rows. After a restore, pause
cleanup until the restored database and provider inventories are reconciled.

## Migrations

Use committed migrations in `packages/db/drizzle-d1`. Builds and Worker startup
must not apply migrations. The original PostgreSQL history remains preserved in
`packages/db/drizzle` for comparison; native jobs use the D1 outbox and Workflows,
not the old pg-boss schema. The CI-gated deployment command applies the selected
environment's committed migrations before replacing its Workers. Full snapshot
imports are migration-only operations and must never run against a live environment.

## Local development and verification

With `pnpm dev` running, `pnpm jobs:dev` requests a maintenance Workflow through
the separate loopback development entrypoint. It shares that app's isolated
persistent D1/R2 and captured mail, with no hosted credentials. Use the compiled
runtime suite for a self-contained synthetic experiment:

```bash
pnpm --filter @my-tuums/jobs test:unit
pnpm --filter @my-tuums/jobs typecheck
pnpm --filter @my-tuums/jobs lint
```

The test script first builds through Wrangler, then runs the real local
Workflows/D1/R2 engine with synthetic Stream and catalog responses. It covers
video publication/captions, replay, cancellation/deadlines, cleanup, multi-batch
pruning, a 5,000-game catalog and absence of HTTP access. A separate
`pnpm --filter @my-tuums/jobs build` performs a deployment dry run only.
It does not create resources, apply migrations or deploy.

These checks replace the removed FFmpeg application's unit/media suites and
Docker queue smoke on this branch. API D1 lifecycle tests remain in place.
The Node app and E2E harness still need migration; local fixture responses do not
prove hosted Stream behavior or complete feature parity.

## Historical Railway implementation

The FFmpeg application and Docker build are preserved at
[commit 9365342](https://github.com/ElCabrii/MyTuums/tree/936534256487531ac426cae222399904dd59e0a9/apps/video-worker).
Use its [versioned operations guide](https://github.com/ElCabrii/MyTuums/blob/936534256487531ac426cae222399904dd59e0a9/docs/video-operations.md)
for original commands and recovery procedures. Its
[implementation and measurement record](video-implementation.md) remains here
for comparison. Removing that runtime from this PoC branch does not alter any
Railway deployment.
