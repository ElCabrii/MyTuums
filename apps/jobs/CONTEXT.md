# Cloudflare jobs Worker

This workspace owns `mytuums-poc-jobs`, the native background runtime for the
synthetic-data migration PoC. The full migration scope and outstanding work
remain in [the migration record](../../docs/cloudflare-migration.md).

## Entry points and ownership

- `src/index.ts` exports `VideoWorkflow`, `GameSyncWorkflow`, `MaintenanceWorkflow` and the Cron
  handler. It has no HTTP handler. `wrangler.jsonc` disables workers.dev and
  preview URLs and declares the one-minute Cron, D1, private EU R2, Stream and Workflow bindings.
- `packages/api/src/cloudflare-jobs.ts` is the runtime's import boundary. It
  excludes the router, auth instance, S3, Sharp and legacy queue modules.
- `packages/api/src/stream-job.ts` owns one restartable video poll, caption
  handoff and publication. D1 state transitions and cleanup remain API-owned.
- `packages/api/src/jobs.ts` owns transactional dispatch intent and monitoring.
  A Worker recovers only the job kinds for which it has bindings. All three
  Workflow kinds are now bound.

## Invariants

- Workflow payloads and results contain identifiers and control flags/counts.
  Private post text and captions are loaded inside a step. Errors are sanitized
  inside `step.do` before Workflows can persist them; database errors may contain
  bound private values and must not be attached as causes to persisted errors.
- Video polls reload current D1 state. Only an author-confirmed submission can
  publish. Cancellation, ownership and the database-clock deadline win over late
  provider replies. Captions use a native readable stream, replace the same
  language track on retry and never enter Workflow parameters or step results.
- The Workflow retries transient operations three times, sleeps durably for
  twenty seconds between pending responses and has at most ninety polls. D1
  enforces the original thirty-minute deadline, including time spent queued.
  Retry exhaustion fails the submission atomically. Minute recovery expires
  overdue work even if its Workflow is absent or terminated.
- Cron commits a stable maintenance intent before dispatch. Monday at 04:00 UTC
  also commits a pruning intent. Pruning uses 250-row batches, at most 100 steps
  per instance, and records a continuation intent if more work remains.
- Dispatch acknowledges only confirmed instance creation. Monitoring visits at
  most fifty due instances, retires confirmed completion and restarts errored
  instances under the same ID with backoff. Unconfirmed status returns the intent
  to dispatch under its original ID, including after provider history expires;
  paused or terminated instances require operator action. Only IDs/counts enter
  application logs. The database guards make replay safe.
- Stream expiry and cleanup use bounded API passes. A provider deletion failure
  remains durable debt, including after account/post deletion. Minute maintenance
  also expires image uploads and cleans media intents and obsolete catalog rows.
  Daily 03:00 UTC inventory lists R2 objects before reading one D1 reference snapshot.
- Daily 00:00 UTC game sync stages the catalog in D1 and publishes atomically.
  Its scheduled timestamp prevents replay from replacing an identical or newer
  snapshot. The thirty-minute database lease fences stale attempts; each Workflow
  step returns only status and counts. Cold cover-download performance still
  requires remote measurement.
- Minute maintenance cleans expired moderation notices and delivers at most 25
  due notices through native Email Service. D1 leases fence acknowledgement and
  preserve recipient ordering. Workflow results contain counts only; private
  notice text and signed links are never step parameters or results.

## Configuration and checks

Wrangler targets the Ops account's isolated `mytuums-poc` D1 database, provisioned
September 11 with EU jurisdiction and read replication disabled. Its seven
committed migrations are applied; it has no application users or seeded data yet. The
private EU R2 bucket is also provisioned. Stream availability is outstanding. See the verified resource
inventory in the migration record before any remote operation. No migration or
deployment command belongs in the build script. The account ID is a non-secret
variable; the Stream token, IGDB client credentials and shared app/jobs
`APPEAL_TOKEN_SECRET` are required secrets. The jobs Worker has no authentication
session secret. Its Email binding restricts the sender to `noreply@mytuums.com`.
Local tests use no production data, account credentials or remote provider.

- `pnpm --filter @my-tuums/jobs types` regenerates `worker-configuration.d.ts`
  from Wrangler configuration. Runtime types come from the pinned Workers types.
- `pnpm --filter @my-tuums/jobs build` performs a Wrangler deployment dry run.
- `pnpm --filter @my-tuums/jobs test:unit` builds and runs the real local Workflows
  engine in Miniflare/workerd with D1 migrations and a Stream protocol fixture.
  It covers native caption streams, publication, multi-batch pruning, the
  scheduled handler, deadline recovery and absence of HTTP access. It also runs
  a 5,000-game catalog plus upcoming rows with synthetic provider responses,
  native R2 covers, replay protection, cleanup and multi-page bucket operations.
- `pnpm --filter @my-tuums/jobs typecheck` checks both Worker and Node test contexts;
  `lint` checks both source and tests without loosening either environment's types.
- API integration tests cover concurrent publication/cancellation, transactional
  rollback, provider failures, dispatch ambiguity and completion monitoring.

The FFmpeg application and its Docker checks have been removed from this branch.
The native app and E2E harness now use Cloudflare bindings. Hosted verification
and interactive local development remain required.

The manual `pnpm games:sync [--remote]` administration command writes the same
D1 game-sync intent shape as Cron. It takes its timestamp from D1 and relies on
scheduled recovery for dispatch. It never invokes IGDB outside this Worker and
its success means queued, not completed. Stable Workflow IDs and staged catalog
fencing are unchanged. Local administrative requests need recovery connected to
the same local D1 persistence; remote execution awaits the PoC jobs deployment.
