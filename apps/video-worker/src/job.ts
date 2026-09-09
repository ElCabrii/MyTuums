import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Database } from "@my-tuums/db";
import { VIDEO_MAX_BYTES } from "@my-tuums/api/constants";
import {
  claimVideo,
  confirmVideoSourceDeleted,
  failVideoWork,
  finishVideoEncoding,
  publishVideo,
  renewVideoLease,
  type VideoStorage,
  type VideoWork,
} from "@my-tuums/api/video-worker";
import { InvalidVideoError } from "./probe.js";
import { encodeVideo, type EncodedVideo } from "./transcode.js";

interface JobOptions {
  db: Database;
  storage: VideoStorage;
  signal: AbortSignal;
  threads: number;
  temporaryDirectory: string;
}

async function downloadSource(
  storage: VideoStorage,
  work: VideoWork,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const source = await storage.readSource(work.sourceKey, signal);
  if (source.byteSize !== work.byteSize || source.byteSize > VIDEO_MAX_BYTES) {
    source.body.destroy();
    throw new InvalidVideoError("The uploaded video size does not match its session.");
  }
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(
        bytes > work.byteSize
          ? new InvalidVideoError("The video source exceeds its registered size.")
          : null,
        chunk,
      );
    },
  });
  await pipeline(
    source.body,
    bounded,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (bytes !== work.byteSize) throw new InvalidVideoError("The uploaded video is incomplete.");
}

/** One queue delivery; cancellation waits for native processes before disk cleanup. */
export async function processVideoJob(videoId: string, options: JobOptions): Promise<void> {
  const work = await claimVideo(options.db, videoId);
  if (!work) return;
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  const renewals = new Set<Promise<void>>();
  const heartbeat = setInterval(() => {
    if (renewals.size > 0) return;
    const renewing = renewVideoLease(options.db, work)
      .then((owned) => {
        if (!owned) abort.abort();
      })
      .catch(() => {
        abort.abort();
      })
      .finally(() => {
        renewals.delete(renewing);
      });
    renewals.add(renewing);
  }, 30_000);
  const started = performance.now();
  let directory: string | undefined;
  let encoded: EncodedVideo | undefined;
  try {
    if (!work.ready) {
      directory = await mkdtemp(join(options.temporaryDirectory, "source-"));
      const sourcePath = join(directory, "source");
      await downloadSource(options.storage, work, sourcePath, signal);
      encoded = await encodeVideo(sourcePath, {
        signal,
        threads: options.threads,
        temporaryDirectory: options.temporaryDirectory,
      });
      if (work.caption) {
        const bytes = Buffer.from(work.caption, "utf8");
        await writeFile(join(encoded.directory, "captions.vtt"), bytes);
        encoded.assets.push({
          name: "captions.vtt",
          contentType: "text/vtt",
          byteSize: bytes.byteLength,
        });
      }
      for (const asset of encoded.assets) {
        signal.throwIfAborted();
        const stream = createReadStream(join(encoded.directory, asset.name));
        try {
          await options.storage.putAsset(
            `${work.prefix}${asset.name}`,
            stream,
            asset.byteSize,
            asset.contentType,
            signal,
          );
        } finally {
          stream.destroy();
        }
      }
      if (
        !(await finishVideoEncoding(
          options.db,
          work,
          {
            width: encoded.source.width,
            height: encoded.source.height,
            duration: encoded.source.duration,
            frameRate: encoded.source.frameRate,
            captionLanguage: work.captionLanguage,
            renditions: encoded.renditions,
          },
          encoded.assets,
        ))
      )
        throw new Error("Video processing ownership changed.");
    }
    signal.throwIfAborted();
    await options.storage.remove(work.sourceKey);
    if ((await options.storage.sourceSize(work.sourceKey)) !== null)
      throw new Error("Source deletion is not yet confirmed.");
    if (!(await confirmVideoSourceDeleted(options.db, work)))
      throw new Error("Video processing ownership changed.");
    const published = await publishVideo(options.db, work);
    console.info(
      JSON.stringify({
        event: "video_processed",
        videoId,
        published,
        wallSeconds: (performance.now() - started) / 1000,
        encodingCpuSeconds: encoded?.encodingCpuSeconds,
        encoderPeakMemoryBytes: encoded?.encoderPeakMemoryBytes,
        outputBytes: encoded?.assets.reduce((sum, asset) => sum + asset.byteSize, 0),
      }),
    );
  } catch (error) {
    const interrupted = signal.aborted;
    abort.abort();
    const terminal = await failVideoWork(options.db, work, !(error instanceof InvalidVideoError));
    console.error(
      JSON.stringify({
        event: "video_processing_failed",
        videoId,
        terminal,
        reason:
          error instanceof InvalidVideoError
            ? "invalid_media"
            : interrupted
              ? "interrupted"
              : "processing_error",
      }),
    );
    if (!terminal) throw new Error("Video processing will be retried.", { cause: error });
  } finally {
    clearInterval(heartbeat);
    await Promise.all(renewals);
    if (encoded) await rm(encoded.directory, { recursive: true, force: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
