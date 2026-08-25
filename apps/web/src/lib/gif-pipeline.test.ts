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

function findSequence(bytes: Uint8Array, sequence: readonly number[]): number {
  return bytes.findIndex((_, start) =>
    sequence.every((value, offset) => bytes[start + offset] === value),
  );
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

  encoder.writeFrame(Uint8Array.of(1, 1), 2, 1, {
    palette,
    delay: 10,
    repeat: -1,
    dispose: 1,
  });
  encoder.writeFrame(Uint8Array.of(1), 1, 1, {
    palette,
    delay: 10,
    repeat: -1,
    dispose: 2,
  });
  encoder.writeFrame(Uint8Array.of(2), 1, 1, {
    palette,
    delay: 10,
    repeat: -1,
    dispose: 1,
  });
  encoder.finish();

  const bytes = encoder.bytes();
  // gifenc sizes the logical screen from the first frame. Widen it by one
  // background-only pixel so the first composited frame also exercises the
  // logical-screen background before any disposal runs.
  bytes[6] = 3;
  bytes[7] = 0;

  // Move the disposal-2 frame to the middle pixel. The final frame remains at
  // the left edge, leaving that middle pixel uncovered after disposal so its
  // restored background colour is observable in the re-encoded full frame.
  const disposalTwoGce = [0x21, 0xf9, 0x04, 0x08, 0x01, 0x00, 0x00, 0x00, 0x2c];
  const gceOffset = findSequence(bytes, disposalTwoGce);
  if (gceOffset < 0) throw new Error("Expected disposal-2 frame in GIF fixture");
  bytes[gceOffset + disposalTwoGce.length] = 1;

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
});
