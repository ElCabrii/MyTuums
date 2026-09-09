# Video implementation — issue #368

Implementation record for [issue #368](https://github.com/ElCabrii/MyTuums/issues/368).
The complete issue remains the acceptance contract. The staged implementation is
present in the codebase, with local verification recorded below. No Railway
service was created or deployed; rollout settings and recovery procedures are in
[video operations](video-operations.md).

## Stages and evidence

1. **Processing and transport proof — implemented and locally verified.** TypeScript
   worker workspace, actual-media validation, segmented encoding, and a benchmark
   command. Real multipart upload and signed playback passed against the development
   bucket. Five-minute landscape and rotated portrait 1080p60 measurements are below.
2. **Durable lifecycle — implemented and locally verified.** Generated Drizzle migrations; PostgreSQL queue;
   separate pending submissions; atomic publication and terminal failure notification;
   content-free durable cleanup that survives account cascades.
3. **Resumable uploads — implemented and locally verified.** Server-owned multipart sessions, bounded parts,
   cancellation, network recovery, expiration, and attachment policy.
4. **Worker and authorized playback — implemented and locally verified.** Lease fencing, retries, derivative
   inventory, source deletion, publication, per-asset authorization, reconciliation,
   moderation and deletion races, and the Railway service image.
5. **Product integration — implemented and locally verified.** Composer, pending cards, localized failure
   notification, custom accessible adaptive player, captions, timeline previews,
   coordinated muted autoplay and preference, and every existing attachment surface.
6. **Release preparation — implemented.** Integration/browser regressions, real
   browser inspection, native tests in the Docker build, worker image smoke in CI,
   environment-isolated Railway settings, local measurements, and synchronized
   product/security/architecture/operations documentation. Check results and the
   remaining deployment measurements are recorded below.

## Decisions

- TypeScript on Node 24 supervises native FFmpeg; `apps/video-worker` is a
  separate executable workspace and Railway service.
- Keep pending submissions outside `post`. Insert the published post, its
  attachment, and ordinary notifications in one guarded transaction.
- Use pg-boss on the existing PostgreSQL database. Job payloads contain IDs only.
  Queue scheduling must commit with the submission through its Drizzle adapter.
  Application transitions own idempotency, independently of queue redelivery.
- Start with H.264/AAC, fragmented MP4 HLS, four-second aligned segments,
  applicable 360p/720p/1080p renditions, and two-second preview images.
- The 500 MB source limit is decimal: 500,000,000 bytes, shared by API and UI.
- Explicitly distinguish the bounded processing retry budget from persistent
  cleanup obligations. A provider outage must not erase evidence that deletion
  is still owed. Retained cleanup state must contain no failed text or captions.
- No added daily upload quota or per-user processing-concurrency cap.

## References

- [FFmpeg formats](https://ffmpeg.org/ffmpeg-formats.html)
- [FFprobe](https://ffmpeg.org/ffprobe.html)
- [pg-boss transaction adapters](https://github.com/timgit/pg-boss/blob/master/docs/api/adapters.md)
- [Railway buckets](https://docs.railway.com/storage-buckets): multipart supported;
  bucket lifecycle configuration unavailable, so application cleanup is required.
- [Railway bucket billing](https://docs.railway.com/storage-buckets/billing): bucket
  egress is free; service uploads to buckets incur service egress. Verified 2026-09-08.

## Measurements

Measured locally with FFmpeg 8.0.1, two encoder/filter threads, libx264
`veryfast`/CRF 22, H.264/AAC, sequential 360p30/720p60/1080p60 renditions.
The source is a 299.933-second, 137,746,248-byte excerpt from Blender's
[Big Buck Bunny test movie](https://download.blender.org/demo/movies/BBB/).
The portrait sample adds 90-degree display rotation to that same excerpt;
it is not independent portrait camera footage.

| Sample                             | Wall time | Encoding CPU time | Largest encoder RSS | Temporary disk | Playback assets            |
| ---------------------------------- | --------- | ----------------- | ------------------- | -------------- | -------------------------- |
| 1920×1080, 60 fps                  | 400.43 s  | 951.93 s          | 387,276,800 B       | 326,872,743 B  | 189,126,495 B; 240 objects |
| 1080×1920 display rotation, 60 fps | 416.96 s  | 1,046.75 s        | 391,835,648 B       | 327,312,615 B  | 189,566,367 B; 240 objects |

CPU/RSS above are FFmpeg's encoder-process measurements. They exclude the
supervisor and validation probes, and RSS is not combined process-tree memory.
GNU time measured 1,019.38 CPU seconds for the entire landscape command's
processes. Temporary disk counts the input and completed derivatives. The
benchmark does not include source download or derivative upload time.

These are local measurements, not Railway throughput or cost estimates.
Before making capacity or cost claims, measure process-tree memory and temporary
disk under overlapping work and repeat the benchmark in the deployed service at
its configured resource limits. Queue/redelivery and actual bucket transport
were verified separately from these encoding benchmarks.

## Verification

- `pnpm verify` passed on 2026-09-09: build, lint, typechecks, formatting,
  documentation, migration checks, 1,463 unit tests and 519 database integration
  tests. This includes the existing appeal-preview regression coverage after
  qualifying the shared attachment query's columns for the added video join.
- Nine lifecycle/queue integration tests: explicit submission, atomic publication,
  bounded retries, duplicate/stale worker fencing, cancellation, account cascade,
  durable failure notification, and pg-boss schedule/array binding compatibility.
- Five upload/media integration tests: incomplete parts, lost completion responses,
  upload ownership/expiry, provider deletion outage, late orphan writes, and
  authorization/manifest rewriting for every asset kind.
- Twelve worker unit tests covering validation and scratch cleanup, plus four
  actual FFmpeg tests including rotation, spoofed containers, playable output,
  and native-process cancellation.
- Three playback-coordination tests covering autoplay preference, explicit playback,
  single selection, manual pause, and offscreen shutdown.
- The worker Docker image built successfully and ran all four native tests with
  its own FFmpeg. Its smoke check booted the real worker against a disposable
  migrated database and a local storage stub, checked maintenance and health,
  and observed a queue delivery complete.
- The focused Playwright upload journey passed, together with its two auth setup
  tests. It interrupts the second multipart request, verifies recovery without
  resending the first part, checks explicit submission and private pending state
  across reload, and cancels the submission. The full E2E suite was not run to
  completion for this change.
- Real Chromium inspection used a 30-second 1080p60 source with WebVTT captions:
  upload, pending state after reload, native processing and publication, adaptive
  playback and manual 1080p60 selection, captions, seek/hover previews, volume,
  speed, fullscreen and picture-in-picture worked. Desktop and mobile viewport
  screenshots were inspected, with no browser errors in the final flow.
- Muted visible autoplay, offscreen shutdown, single-player coordination and the
  persisted autoplay-off preference worked. A second real upload confirmed that
  publication refreshes the feed automatically. Mobile viewport inspection does
  not establish Safari or physical-device support.
- Both browser-created posts were deleted through the normal UI. Scoped durable
  cleanup completed for all four task uploads, with no remaining objects or
  multipart sessions. The browser session and task servers were closed. The
  explicitly approved development CORS rule remains in place.
