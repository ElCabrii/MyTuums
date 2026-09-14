/**
 * Local video selection preflight (issue #404).
 *
 * Inspects a chosen file's duration, dimensions and encoded frame rate before
 * the composer creates any server upload record or contacts the provider: no
 * draft state, no `video.begin`, no tus transport, until every available
 * check passes. This is a cooperative early refusal with specific localized
 * copy — the server's byte cap and the provider's `maxDurationSeconds` remain
 * the enforcement boundary, so a modified client gains nothing.
 */

import {
  VIDEO_INPUT_TYPES,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  VIDEO_MAX_FPS,
  VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SHORT_EDGE,
} from "@my-tuums/api/constants";

/** Why a selected video was refused before any upload attempt. */
export type VideoPreflightRejection =
  "type" | "size" | "duration" | "dimensions" | "frameRate" | "unreadable";

export type VideoPreflightVerdict = { ok: true } | { ok: false; reason: VideoPreflightRejection };

/** What `loadedmetadata` knows; the frame rate is deliberately absent. */
export interface VideoMetadataSnapshot {
  duration: number;
  width: number;
  height: number;
}

/** Overridable so the boundary logic runs in the Node test project, no DOM. */
export type VideoMetadataLoader = (file: File) => Promise<VideoMetadataSnapshot | null>;

/** Reads the encoded video track's average frame rate; null when unknowable. */
export type FrameRateReader = (file: File) => Promise<number | null>;

/**
 * The whole local check, as one callable. Atoms and components receive this
 * as their injection point, so their tests substitute verdicts through a real
 * interface instead of module mocks.
 */
export type VideoVerifier = (file: File) => Promise<VideoPreflightVerdict>;

/** Metadata inspection must never hang the composer behind a stuck element. */
const METADATA_TIMEOUT_MS = 15_000;

/**
 * Container timestamps round to whole nanoseconds, so a nominal 60 fps track
 * can present as 60.0000024. The boundary compares with that rounding in
 * mind: a genuinely faster track clears it by whole frames.
 */
const FRAME_RATE_BOUNDARY_TOLERANCE = 0.05;

/**
 * Drives a detached `<video>` to `loadedmetadata`. The element is never
 * attached, muted, and asks for metadata only — no frame is decoded, so a
 * 100 MB file costs the same inspection as a 1 MB one.
 */
const loadMetadataThroughVideoElement: VideoMetadataLoader = (file) =>
  new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const finish = (snapshot: VideoMetadataSnapshot | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish(null), METADATA_TIMEOUT_MS);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const { duration, videoWidth, videoHeight } = video;
      finish(
        Number.isFinite(duration) && duration > 0 && videoWidth > 0 && videoHeight > 0
          ? { duration, width: videoWidth, height: videoHeight }
          : null,
      );
    };
    video.onerror = () => finish(null);
    video.src = url;
  });

/** The frame-rate reader as a lazy default: the parser's bundle is only paid on selection. */
const lazyFrameRateReader: FrameRateReader = async (file) => {
  const { readVideoFrameRate } = await import("./video-frame-rate.js");
  return readVideoFrameRate(file);
};

/**
 * Runs every available local check. Synchronous refusals (type, size) come
 * first so an obviously invalid selection never waits on metadata. Both
 * inspection seams are parameters — the boundary logic itself runs in the
 * Node test project with no DOM and no module mocks.
 */
export async function preflightVideo(
  file: File,
  loadMetadata: VideoMetadataLoader = loadMetadataThroughVideoElement,
  readFrameRate: FrameRateReader = lazyFrameRateReader,
): Promise<VideoPreflightVerdict> {
  if (!VIDEO_INPUT_TYPES.some((type) => type === file.type)) return { ok: false, reason: "type" };
  if (file.size <= 0 || file.size > VIDEO_MAX_BYTES) return { ok: false, reason: "size" };

  const metadata = await loadMetadata(file);
  if (!metadata) return { ok: false, reason: "unreadable" };
  if (metadata.duration > VIDEO_MAX_DURATION_SECONDS) return { ok: false, reason: "duration" };
  const longEdge = Math.max(metadata.width, metadata.height);
  const shortEdge = Math.min(metadata.width, metadata.height);
  // Orientation-aware bounds: 1920×1080 landscape or 1080×1920 portrait, the
  // policy the provider enforces after upload too.
  if (longEdge > VIDEO_MAX_LONG_EDGE || shortEdge > VIDEO_MAX_SHORT_EDGE) {
    return { ok: false, reason: "dimensions" };
  }

  const frameRate = await readFrameRate(file);
  if (frameRate === null) return { ok: false, reason: "unreadable" };
  if (frameRate > VIDEO_MAX_FPS + FRAME_RATE_BOUNDARY_TOLERANCE) {
    return { ok: false, reason: "frameRate" };
  }
  return { ok: true };
}
