import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { decompressFrames, parseGIF } from "gifuct-js";
import { describe, expect, it } from "vitest";
import { processAnimatedGif } from "@/lib/gif-pipeline";

const GIF_WIDTH = 2;
const GIF_HEIGHT = 2;

function solidFrame(red: number, green: number, blue: number): Uint8ClampedArray {
  return new Uint8ClampedArray([
    red,
    green,
    blue,
    255,
    red,
    green,
    blue,
    255,
    red,
    green,
    blue,
    255,
    red,
    green,
    blue,
    255,
  ]);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sourceGif(repeat = 3): ArrayBuffer {
  const encoder = GIFEncoder();
  for (const [frame, delay] of [
    [solidFrame(255, 0, 0), 40],
    [solidFrame(0, 255, 0), 60],
  ] as const) {
    const palette = quantize(frame, 256, { format: "rgb565" });
    const index = applyPalette(frame, palette, "rgb565");
    encoder.writeFrame(index, GIF_WIDTH, GIF_HEIGHT, {
      palette,
      delay,
      repeat,
    });
  }
  encoder.finish();
  return copyBuffer(encoder.bytes());
}

function sourceGifWithOpaqueBackgroundDisposal(): ArrayBuffer {
  const encoder = GIFEncoder();
  const palette = [
    [0, 0, 255],
    [255, 0, 0],
    [0, 255, 0],
  ] as const;

  for (const [pixels, width, dispose] of [
    [Uint8Array.of(1, 1), 2, 1],
    [Uint8Array.of(1, 1), 2, 2],
    [Uint8Array.of(2), 1, 1],
  ] as const) {
    encoder.writeFrame(pixels, width, 1, { palette, delay: 10, repeat: -1, dispose });
  }
  encoder.finish();

  const bytes = encoder.bytes();
  // gifenc sizes the logical screen from the first frame. Widen it by one
  // background-only pixel so the first composited frame also exercises the
  // logical-screen background before any disposal runs.
  bytes[6] = 3;
  bytes[7] = 0;

  return copyBuffer(bytes);
}

function rgbaAt(frame: Uint8ClampedArray, x: number): number[] {
  const offset = x * 4;
  return Array.from(frame.slice(offset, offset + 4));
}

describe("processAnimatedGif", () => {
  it("decodes, preserves, and re-encodes the animation frames", () => {
    const result = processAnimatedGif(sourceGif(), {
      maxWidth: GIF_WIDTH,
      maxHeight: GIF_HEIGHT,
      maxBytes: 64 * 1024,
    });
    const parsed = parseGIF(copyBuffer(result.bytes));
    const frames = decompressFrames(parsed, true);
    const loopExtension = parsed.frames.find((frame) => "application" in frame);

    expect(result.frameCount).toBe(2);
    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => [frame.dims.width, frame.dims.height, frame.delay])).toEqual([
      [GIF_WIDTH, GIF_HEIGHT, 40],
      [GIF_WIDTH, GIF_HEIGHT, 60],
    ]);
    expect(
      loopExtension && "application" in loopExtension
        ? {
            id: loopExtension.application.id,
            blocks: Array.from(loopExtension.application.blocks),
          }
        : null,
    ).toEqual({ id: "NETSCAPE2.0", blocks: [1, 3, 0] });
  });

  it("restores disposal-2 rectangles to the opaque logical-screen background", () => {
    const result = processAnimatedGif(sourceGifWithOpaqueBackgroundDisposal(), {
      maxWidth: 3,
      maxHeight: 1,
      maxBytes: 64 * 1024,
    });
    const frames = decompressFrames(parseGIF(copyBuffer(result.bytes)), true);

    expect(frames).toHaveLength(3);
    const background = rgbaAt(frames[0].patch, 2);
    expect(background[3]).toBe(255);
    expect(background[2]).toBeGreaterThan(200);
    expect(rgbaAt(frames[2].patch, 1)).toEqual(background);
    expect(rgbaAt(frames[2].patch, 2)).toEqual(background);
  });

  it("rejects a re-encoded result that exceeds the target byte cap", () => {
    expect(() =>
      processAnimatedGif(sourceGif(), {
        maxWidth: GIF_WIDTH,
        maxHeight: GIF_HEIGHT,
        maxBytes: 1,
      }),
    ).toThrowError("size");
  });

  it("crops a banner to its default window, frame for frame — never letterboxes", () => {
    // A square source in the banner slot: the largest 3:1 rectangle inside it
    // is the 2x1 band, and even a crop asking to zoom out past that (scale
    // 0.1, the shape that used to encode black bars — issue #273) clamps to
    // it. Each composited frame is drawn once, edge to edge.
    const result = processAnimatedGif(sourceGif(), {
      kind: "banner",
      crop: { x: 0.5, y: 0.5, scale: 0.1 },
      maxBytes: 64 * 1024,
    });
    const frames = decompressFrames(parseGIF(copyBuffer(result.bytes)), true);

    expect(result.frameCount).toBe(2);
    const frameColors = [
      [255, 0, 0],
      [0, 255, 0],
    ] as const;
    for (const [index, frame] of frames.entries()) {
      expect([frame.dims.width, frame.dims.height]).toEqual([2, 1]);
      const [r, g, b] = frameColors[index] ?? [0, 0, 0];
      expect(rgbaAt(frame.patch, 0)).toEqual([r, g, b, 255]);
      expect(rgbaAt(frame.patch, 1)).toEqual([r, g, b, 255]);
    }
  });
});
