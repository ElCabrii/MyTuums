# Video worker operations

This branch uses Stream for video storage/encoding and Cloudflare Workflows for
processing coordination. The native owner is [apps/jobs/CONTEXT.md](../apps/jobs/CONTEXT.md).
Local compiled runtime tests pass; deployment and hosted provider behavior remain
unverified. The full scope and resource inventory are in
[the migration record](cloudflare-migration.md).

## Cloudflare PoC runtime

The jobs Worker handles video processing, game sync and maintenance. It has no
HTTP handler; workers.dev and preview URLs are disabled in its configuration.
The isolated EU D1 database and private EU R2 bucket are provisioned. D1 remains
empty until its committed migrations are applied. Stream availability and required
secrets still need verification before deployment.

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

Stream owns encoded video and source retention. The PoC does not reproduce the
former FFmpeg codec, frame-rate, rendition, probe or source-deletion guarantees.
Its accepted behavior is documented in the migration record; the original native
media tests and benchmark measurements are historical evidence only.

Playback requires current application authorization before issuing a signed
Stream capability. Access protects the application and token issuance. A holder
can use an issued playback capability directly until its one-hour expiry.

D1 records durable Stream cleanup obligations before owning rows disappear.
Retries survive post/account deletion, cancellation and ambiguous provider calls.
R2 stores images and covers privately. Minute maintenance drains cleanup intents;
a daily inventory lists objects before reading a consistent D1 reference snapshot.
Keep database, R2 bucket and Stream namespace isolated as one PoC environment.
Do not clear debt by deleting lifecycle or outbox rows. After a restore, pause
cleanup until the restored database and provider inventories are reconciled.

## Migrations

Use committed migrations in `packages/db/drizzle-d1`. Builds and Worker startup
must not apply migrations. The original PostgreSQL history remains preserved in
`packages/db/drizzle` for comparison; native jobs use the D1 outbox and Workflows,
not the old pg-boss schema. Native seed/reset and remote recovery commands remain
outstanding in the migration plan.

## Local development and verification

`pnpm jobs:dev` starts Wrangler with local bindings and no public HTTP route.
It does not connect the unfinished application entrypoint or seed a database.
Use the compiled runtime suite for a self-contained synthetic experiment:

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
