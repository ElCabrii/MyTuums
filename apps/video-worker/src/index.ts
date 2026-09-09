import { env } from "./env.js";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { db, closeDb, pingDb } from "@my-tuums/db";
import {
  createVideoQueue,
  configureVideoQueues,
  createVideoStorage,
  cleanVideoStorage,
  reconcileVideoObjects,
  reconcileVideoRecords,
  VIDEO_PROCESS_QUEUE,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESS_TIMEOUT_SECONDS,
} from "@my-tuums/api/video-worker";
import { z } from "zod";
import type { JobResult } from "pg-boss";
import { processVideoJob } from "./job.js";
import { runMediaProcess } from "./process.js";
import { cleanTemporaryVideoFiles } from "./temporary-files.js";

const stop = new AbortController();
const storage = createVideoStorage({
  endpoint: env.S3_ENDPOINT,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  region: env.S3_REGION,
});
const queue = createVideoQueue(db, true);
const payload = z.object({ videoId: z.uuid() }).strict();
let healthy = false;
let maintenanceHealthy = true;
let startupStage = "native_tools";
const health = createServer((_request, response) => {
  response.writeHead(healthy && maintenanceHealthy ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ status: healthy && maintenanceHealthy ? "ok" : "unavailable" }));
});
queue.on("error", () => {
  maintenanceHealthy = false;
  console.error(JSON.stringify({ event: "video_queue_error" }));
});

async function main(): Promise<void> {
  await mkdir(env.VIDEO_TEMP_DIRECTORY, { recursive: true, mode: 0o700 });
  await cleanTemporaryVideoFiles(env.VIDEO_TEMP_DIRECTORY);
  for (const executable of ["ffmpeg", "ffprobe"] as const)
    await runMediaProcess(executable, ["-version"], {
      signal: AbortSignal.timeout(10_000),
      cwd: env.VIDEO_TEMP_DIRECTORY,
    });
  startupStage = "database";
  await pingDb();
  startupStage = "queue";
  await queue.start();
  await configureVideoQueues(queue);
  startupStage = "consumers";
  await queue.work(
    VIDEO_PROCESS_QUEUE,
    {
      localConcurrency: env.VIDEO_WORKER_CONCURRENCY,
      batchSize: 1,
      pollingIntervalSeconds: 2,
      perJobResults: true,
    },
    async (jobs) => {
      const results: JobResult[] = [];
      for (const job of jobs) {
        const parsed = payload.safeParse(job.data);
        if (!parsed.success) {
          results.push({ id: job.id, status: "deadletter", output: { reason: "invalid_payload" } });
          continue;
        }
        try {
          await processVideoJob(parsed.data.videoId, {
            db,
            storage,
            threads: env.VIDEO_FFMPEG_THREADS,
            temporaryDirectory: env.VIDEO_TEMP_DIRECTORY,
            signal: AbortSignal.any([
              stop.signal,
              job.signal,
              AbortSignal.timeout(VIDEO_PROCESS_TIMEOUT_SECONDS * 1000),
            ]),
          });
          results.push({ id: job.id, status: "completed" });
        } catch {
          // Persist a closed, content-free result. Internal causal errors may
          // contain SQL parameters, provider responses or source metadata.
          results.push({
            id: job.id,
            status: "failed",
            output: { reason: "processing_interrupted" },
          });
        }
      }
      return results;
    },
  );
  await queue.work(
    VIDEO_MAINTENANCE_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: 5, perJobResults: true },
    async (jobs) => {
      const results: JobResult[] = [];
      for (const job of jobs) {
        try {
          const temporaryDirectoriesRemoved = await cleanTemporaryVideoFiles(
            env.VIDEO_TEMP_DIRECTORY,
          );
          await reconcileVideoRecords(db, queue);
          await reconcileVideoObjects(db, storage);
          const result = await cleanVideoStorage(db, storage);
          maintenanceHealthy = true;
          console.info(
            JSON.stringify({ event: "video_cleanup", temporaryDirectoriesRemoved, ...result }),
          );
          results.push({ id: job.id, status: "completed" });
        } catch {
          maintenanceHealthy = false;
          results.push({ id: job.id, status: "failed", output: { reason: "cleanup_interrupted" } });
        }
      }
      return results;
    },
  );
  startupStage = "schedule";
  await queue.schedule(VIDEO_MAINTENANCE_QUEUE, "* * * * *");
  await queue.send(VIDEO_MAINTENANCE_QUEUE);
  healthy = true;
  health.listen(env.PORT, "0.0.0.0");
  console.info(
    JSON.stringify({
      event: "video_worker_ready",
      concurrency: env.VIDEO_WORKER_CONCURRENCY,
      threads: env.VIDEO_FFMPEG_THREADS,
    }),
  );
}

let shutdownStarted = false;
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  healthy = false;
  stop.abort();
  health.close();
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  try {
    await queue.stop({ graceful: true, timeout: 20_000 });
    await closeDb();
  } catch {
    console.error(JSON.stringify({ event: "video_worker_shutdown_failed" }));
    process.exitCode = 1;
  }
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
main().catch(async (error) => {
  console.error(
    JSON.stringify({
      event: "video_worker_start_failed",
      stage: startupStage,
      error: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  await shutdown();
  process.exitCode = 1;
});
