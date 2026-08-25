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
