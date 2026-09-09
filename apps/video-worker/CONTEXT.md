# apps/video-worker context

## Responsibility

The dedicated video processor for issue #368. TypeScript supervises native
FFmpeg processes; the API owns submission, publication, and storage lifecycle
rules. Deployment and recovery are documented in
[video operations](../../docs/video-operations.md); verification evidence is in
[the implementation record](../../docs/video-implementation.md).

## Start here

- `src/probe.ts` validates the actual source and every decoded video frame.
- `src/transcode.ts` produces playback renditions, a cover, and timeline previews.
- `src/process.ts` owns subprocess cancellation, deadlines, and bounded output.
- `src/benchmark.ts` measures the same processing pipeline used by the worker.
- `src/job.ts` coordinates one leased attempt, storage, source removal and publication.
- `src/index.ts` owns consumers, maintenance, health and shutdown.
- `src/env.ts` validates the worker's database, bucket and resource settings.
- `src/temporary-files.ts` reclaims crash leftovers in the dedicated scratch directory.
- `src/smoke.ts` boots the built worker against a migrated `_test` database and local storage stub.

## Language

- **Upload**: temporary input selected by an author; selection is not publication consent.
- **Submission**: an author-confirmed pending post, private to its author until published.
- **Attempt**: one leased processing execution with its own output prefix.
- **Playback assets**: the complete validated derivative set required for publication.
- **Cleanup work**: durable deletion obligations; contains identifiers and keys, never post text.

## Change map

Input policy belongs to `packages/api/src/constants.ts`; actual-media validation
and encoding belong here. Database transitions and permissions belong to
`packages/api`, while schema changes belong to `packages/db`.

## Invariants

- FFmpeg receives local filenames and explicit arguments, never shell commands
  or author-provided URLs. Its environment does not contain application secrets.
- Validate input limits before scaling, including rotation and sample aspect ratio.
- Never upscale. Higher renditions preserve source frame rates up to 60 fps.
- Temporary files and subprocesses must be reclaimed on failure or cancellation.
- The scratch directory belongs exclusively to video processing. Cleanup removes
  recognized directories older than two processing deadlines; live jobs have a
  30-minute deadline. Do not point it at shared application data.
- Queue redelivery cannot bypass publication or terminal-state guards.
- Queue payloads and logs contain IDs and measurements, never post/caption content,
  source metadata, credentials, signed URLs or raw native diagnostics.
- Each environment's database and bucket are a pair. Reconciliation assumes that
  the database owns every `videos/` object in its bucket.
- Migrations belong to the server pre-deploy step. Queue startup never creates or
  upgrades the pg-boss schema; its version is pinned to the committed migration.

## Verification

- `pnpm --filter @my-tuums/video-worker test:unit` checks validation policy.
- `pnpm --filter @my-tuums/video-worker test:media` executes the real FFmpeg binaries.
- `pnpm --filter @my-tuums/video-worker benchmark <source>` measures processing.
- The Docker build runs the native media tests; CI also runs `dist/smoke.js` in
  that image to prove queue delivery, maintenance and readiness.
- Run `pnpm format` and `pnpm verify` before completing the change.
