# Video worker operations

The video worker is a separate TypeScript application at `apps/video-worker`.
Node coordinates durable work; native FFmpeg does validation and encoding.
It uses the application's PostgreSQL database and the same environment's private
bucket. The implementation and local measurements are recorded in
[video implementation](video-implementation.md).

## Local development

Run the existing schema migrations and configure the complete development `S3_*`
group in `.env`. Install FFmpeg/FFprobe with libx264, AAC and zscale support, or
use the worker image. Start the app with `pnpm dev`, then the optional worker
in another terminal with `pnpm video:dev`. Its health port is `3002`; the dev
command overrides the server's `.env` port. The worker is excluded from ordinary
`pnpm dev`, so development without a bucket or FFmpeg still works.

Each running worker must have a database that owns **all** `videos/` objects in
its bucket. Do not run full reconciliation against a temporary test database
sharing a bucket with unrelated development videos. The browser regression
cleans only the upload capabilities created by its own page.

## Railway service configuration

Create a dedicated `video-worker` service in Preview first, then production
after verifying the release. These are the settings to apply; this change does
not create or deploy a Railway service.

| Setting              | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| Repository           | This monorepo, root directory `/`                                        |
| Dockerfile           | `apps/video-worker/Dockerfile`                                           |
| Start command        | Image default: `node apps/video-worker/dist/index.js`                    |
| Region               | `europe-west4-drams3a`, matching the existing application and PostgreSQL |
| Bucket               | The same environment's bucket, confirmed in the same European region     |
| Replicas             | `1` initially                                                            |
| Health check         | `/health`, port from Railway's `PORT`                                    |
| Restart              | On failure; keep the service running continuously                        |
| Sleeping / cron      | Disabled; queue polling and maintenance require a running process        |
| Pre-deploy migration | None on the worker; deploy the server's migration step first             |
| Public domain        | None required                                                            |
| Preview branch       | The active release branch, currently release/0.5.0                       |
| Production branch    | `main`, gated by CI                                                      |

Runtime variables:

| Variable                                                               | Value / default                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                         | Reference the same environment's PostgreSQL connection                                   |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Reference that environment's bucket credentials; never copy another environment's values |
| `S3_REGION`                                                            | Bucket signing region, default `auto`                                                    |
| `VIDEO_WORKER_CONCURRENCY`                                             | `1` initially; validated range 1–16                                                      |
| `VIDEO_FFMPEG_THREADS`                                                 | `2` initially; validated range 1–16                                                      |
| `VIDEO_TEMP_DIRECTORY`                                                 | `/tmp/mytuums-video-worker`, dedicated ephemeral scratch space                           |
| `PORT`                                                                 | Railway-provided port, default `3002`                                                    |

The worker needs no auth, email, OAuth, IGDB or frontend credentials. Its image
runs as a non-root user and uses `tini` to forward shutdown to native children.
Allow at least 30 seconds of termination grace. Start with one processing slot;
measure process-tree RSS and temporary disk at the configured resource limits
before raising concurrency. Each slot may hold a 500 MB source plus all derivatives.
Local encoder RSS measurements alone are not a memory limit recommendation.

Environment pairing is mandatory:

| Execution                 | Database                      | Bucket                                             |
| ------------------------- | ----------------------------- | -------------------------------------------------- |
| Production worker         | Production PostgreSQL         | Production bucket                                  |
| Preview worker            | Preview PostgreSQL            | Preview bucket                                     |
| Local worker              | Local development PostgreSQL  | Development bucket                                 |
| CI image smoke            | Disposable `_test` PostgreSQL | Local empty storage stub                           |
| Browser upload regression | Disposable `_test` PostgreSQL | CI bucket; dev bucket locally, scoped cleanup only |

Railway's [legacy Config as Code](https://docs.railway.com/config-as-code)
does not accept new services. This repository currently operates service
settings through Railway; no new `railway.toml` is introduced. Adopting
[Railway TypeScript IaC](https://docs.railway.com/infrastructure-as-code) for the
whole existing project is a separate migration.

## Bucket CORS

Video parts upload directly from the browser. HLS.js fetches binary assets after
authorized same-origin redirects, so the bucket must permit the app's exact
origin for `GET`, `HEAD` and `PUT`, request headers `content-type` and `range`,
and exposed headers `ETag`, `Content-Length`, `Content-Range`, `Accept-Ranges`.
Objects remain private and requests still require signed URLs.

The helper preserves other CORS rules and defaults to a read-only plan:

```bash
pnpm --filter @my-tuums/api storage:video-cors http://localhost:5173 http://localhost:5273
```

After reviewing the selected bucket and exact origins, append `--apply` to
persist the rule and verify readback. Use `https://preview.mytuums.com` in
Preview, `https://mytuums.com` in production, and `http://localhost:5273` in CI.
The development bucket was explicitly approved for `5173`, `5273` and the
temporary built-app inspection port `39101`; that rule persists after testing.
No Preview, CI or production CORS setting was changed by this implementation.

## Migrations

`0037_greedy_peter_parker.sql` adds video lifecycle tables and attachment/notice
contracts. `0038_video_queue.sql` installs the pinned pg-boss 12.26.0 schema
under `video_jobs`. The server's normal pre-deploy migration step applies both
before either new server procedures or a worker starts.

The initial queue migration was generated by creating a custom Drizzle migration
and filling that **new** file with the vendor construction plan:

```bash
pnpm --filter @my-tuums/db exec drizzle-kit generate --custom --name=video_queue
pnpm --filter @my-tuums/api exec tsx scripts/generate-video-queue.ts 0038_video_queue.sql
```

Do not rerun this over an applied migration. A pg-boss upgrade requires a new
reviewed upgrade migration using that version's upgrade plan, adapter regression
tests, and image smoke verification. Startup has `migrate` and `createSchema`
disabled and does not create statistics partitions.

## Recovery and observability

- The process queue has identifiers-only payloads. Submission and enqueue commit
  in one transaction. Application leases fence duplicate/stale deliveries;
  heartbeats renew every 30 seconds against a 90-second lease.
- A processing attempt has a 30-minute deadline and at most three encoding
  attempts. Upload/submission state expires after 24 hours. A ready retry reuses
  the completed assets while source deletion or publication recovers.
- Maintenance runs each minute, reconciling expired/orphaned rows, actual objects,
  multipart sessions and cleanup debt. Failed deletion retries back off up to six
  hours without forgetting the obligation. Bucket scans also catch writes that
  arrive after a previous cleanup finished.
- Native cancellation waits for the child to exit; it escalates from SIGTERM to
  SIGKILL after five seconds. Normal completion removes scratch directories.
  Startup and maintenance reap recognized crash leftovers older than one hour.
- `video_worker_ready`, `video_processed`, `video_processing_failed`,
  `video_cleanup`, `video_queue_error` and shutdown/start failures are structured,
  content-free logs. Processing reports elapsed time, encoder CPU/RSS and output
  bytes. Cleanup reports completed/deferred obligations and removed scratch dirs.
- `/health` is healthy only after tools, database, queues and consumers initialize;
  queue/maintenance failures make it unhealthy. Monitor queue age, pending age,
  cleanup debt age, retry/failure counts, disk usage and process-tree RSS.

Useful read-only queue inspection (run against the intended environment):

```sql
SELECT name, state, count(*), min(created_on) AS oldest
FROM video_jobs.job
GROUP BY name, state;

SELECT state, count(*), min(created_at) AS oldest
FROM video
GROUP BY state;

SELECT count(*), min(next_attempt_at) AS oldest_due
FROM video_cleanup
WHERE next_attempt_at <= now();
```

After a provider outage, restore connectivity and let maintenance drain the debt.
Do not delete queue/lifecycle rows to clear an alert. After a database restore,
pause all video workers until the restored database and bucket inventory have
been checked together; an older database may consider newer videos orphaned.
For rollback, stop consumers first and roll back application images while keeping
the additive schema and pending/cleanup rows. Resume a compatible worker to drain
work; never reverse these migrations while live submissions exist.

## Verification

```bash
pnpm --filter @my-tuums/video-worker test:unit
pnpm --filter @my-tuums/video-worker test:media
pnpm --filter @my-tuums/e2e e2e tests/specs/video-upload.spec.ts
docker build -f apps/video-worker/Dockerfile -t mytuums-video-worker:local .
```

The Docker build runs real encoding tests with its FFmpeg build. After migrating
a disposable `_test` database, run `node apps/video-worker/dist/smoke.js` in the
image with only its `DATABASE_URL`; it starts the real worker, exercises local
storage maintenance, checks health, and observes a queue delivery complete.
CI performs this in the existing image job, without bucket secrets.

The benchmark command accepts a local source:
`pnpm --filter @my-tuums/video-worker benchmark /absolute/path/video.mp4`.
It emits JSON and removes its derivatives. Its CPU/RSS scope and limitations are
documented in the output and [measurement record](video-implementation.md#measurements).
