import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  VIDEO_MAX_FPS,
} from "@my-tuums/api/constants";

import { preflightVideo, type FrameRateReader, type VideoMetadataLoader } from "./video-preflight";

/**
 * Both inspection seams are parameters (issue #404's boundary logic), so these
 * tests inject snapshots and frame rates through the real interfaces — the
 * container parsing itself is pinned in `video-frame-rate.test.ts` against
 * synthetic MP4/WebM bytes, and the element-driven loader runs in a browser.
 */
const AT_BOUNDARY = {
  duration: VIDEO_MAX_DURATION_SECONDS,
  width: 1920,
  height: 1080,
};

/** A metadata loader pinned to one snapshot; null models a failed inspection. */
function metadata(snapshot: typeof AT_BOUNDARY | null): VideoMetadataLoader {
  return () => Promise.resolve(snapshot);
}

/** A frame-rate reader pinned to one rate; null models an unknowable one. */
function frameRateOf(rate: number | null): FrameRateReader {
  return () => Promise.resolve(rate);
}

function videoFile(size = 1024, type = "video/mp4"): File {
  return new File([new Uint8Array(size)], "clip.mp4", { type });
}

const reader = frameRateOf(VIDEO_MAX_FPS);

describe("preflightVideo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a file at exactly every boundary", async () => {
    const file = videoFile(VIDEO_MAX_BYTES);
    const readFrameRate = vi.fn(reader);
    await expect(preflightVideo(file, metadata(AT_BOUNDARY), readFrameRate)).resolves.toEqual({
      ok: true,
    });
    expect(readFrameRate).toHaveBeenCalledWith(file);
  });

  it("refuses an empty or oversized file before any inspection", async () => {
    const loader = vi.fn(metadata(AT_BOUNDARY));
    await expect(preflightVideo(videoFile(0), loader, reader)).resolves.toEqual({
      ok: false,
      reason: "size",
    });
    await expect(preflightVideo(videoFile(VIDEO_MAX_BYTES + 1), loader, reader)).resolves.toEqual({
      ok: false,
      reason: "size",
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it("refuses a container outside the accepted input types before any inspection", async () => {
    const loader = vi.fn(metadata(AT_BOUNDARY));
    await expect(
      preflightVideo(videoFile(1024, "video/x-matroska"), loader, reader),
    ).resolves.toEqual({ ok: false, reason: "type" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("refuses a duration one increment past the boundary", async () => {
    const readFrameRate = vi.fn(reader);
    await expect(
      preflightVideo(videoFile(), metadata({ ...AT_BOUNDARY, duration: 300.5 }), readFrameRate),
    ).resolves.toEqual({ ok: false, reason: "duration" });
    // The frame-rate reader is never reached once an earlier check refuses.
    expect(readFrameRate).not.toHaveBeenCalled();
  });

  it("accepts portrait orientation at the same bounds", async () => {
    await expect(
      preflightVideo(videoFile(), metadata({ ...AT_BOUNDARY, width: 1080, height: 1920 }), reader),
    ).resolves.toEqual({ ok: true });
  });

  it.each([
    ["landscape long edge", 1921, 1080],
    ["portrait long edge", 1080, 1921],
    ["square short edge", 1081, 1081],
  ])("refuses %s one pixel over", async (_kind, width, height) => {
    await expect(
      preflightVideo(videoFile(), metadata({ ...AT_BOUNDARY, width, height }), reader),
    ).resolves.toEqual({ ok: false, reason: "dimensions" });
  });

  it("refuses a frame rate above the cap but tolerates nanosecond rounding of it", async () => {
    await expect(
      preflightVideo(videoFile(), metadata(AT_BOUNDARY), frameRateOf(VIDEO_MAX_FPS + 0.0000024)),
    ).resolves.toEqual({ ok: true });
    await expect(
      preflightVideo(videoFile(), metadata(AT_BOUNDARY), frameRateOf(VIDEO_MAX_FPS + 0.5)),
    ).resolves.toEqual({ ok: false, reason: "frameRate" });
  });

  it("fails safely when neither the element nor the container can describe the file", async () => {
    const readFrameRate = vi.fn(reader);
    await expect(preflightVideo(videoFile(), metadata(null), readFrameRate)).resolves.toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(readFrameRate).not.toHaveBeenCalled();
    await expect(
      preflightVideo(videoFile(), metadata(AT_BOUNDARY), frameRateOf(null)),
    ).resolves.toEqual({ ok: false, reason: "unreadable" });
  });
});
