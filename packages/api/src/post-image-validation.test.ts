import { describe, expect, it } from "vitest";
import {
  GIF_MAX_CUMULATIVE_PIXELS,
  GIF_MAX_FRAMES,
  GIF_MAX_TOTAL_DURATION_MS,
} from "./constants.js";
import {
  gifFrameSummary,
  gifWithinLimits,
  isStructurallyValidPostImage,
} from "./post-image-validation.js";

/**
 * Hand-crafted GIF bytes, not real files: the server's validator walks block
 * structure and never LZW-decodes, so a synthetic block layout IS the file as
 * far as it is concerned. The image-data sub-blocks carry no real compressed
 * pixels — a single 0x00 terminator — because nothing here decompresses them.
 */

/** Little-endian byte pair for a 16-bit value, the way GIF stores widths/heights/delays. */
function le16(value: number): [number, number] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/**
 * Builds a minimal well-formed GIF: a 13-byte header with no Global Color Table,
 * then for each frame an optional Graphic Control Extension (its delay), an Image
 * Descriptor, and an empty image-data sub-block sequence, then the 0x3B trailer.
 */
function buildGif(
  logicalScreen: { width: number; height: number },
  frames: ReadonlyArray<{ width: number; height: number; delayCs?: number }>,
): Uint8Array {
  const bytes: number[] = [
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61, // "GIF89a"
    ...le16(logicalScreen.width),
    ...le16(logicalScreen.height),
    0x00,
    0x00,
    0x00, // packed (no GCT), bg colour, pixel aspect ratio
  ];
  for (const frame of frames) {
    if (frame.delayCs !== undefined) {
      // Graphic Control Extension: introducer, label, blockSize(4), packed,
      // delay (LE16, centiseconds), transparent index, terminator.
      bytes.push(0x21, 0xf9, 0x04, 0x00, ...le16(frame.delayCs), 0x00, 0x00);
    }
    // Image Descriptor: introducer, left, top, width, height (all LE16), packed.
    bytes.push(0x2c, ...le16(0), ...le16(0), ...le16(frame.width), ...le16(frame.height), 0x00);
    // LZW minimum code size, then an empty image-data sub-block sequence (the
    // 0x00 terminator is itself a zero-length sub-block).
    bytes.push(0x02, 0x00);
  }
  bytes.push(0x3b); // trailer
  return new Uint8Array(bytes);
}

describe("gifFrameSummary", () => {
  it("totals one frame's pixels and reads no delay when no GCE precedes it", () => {
    const gif = buildGif({ width: 256, height: 128 }, [{ width: 256, height: 128 }]);
    expect(gifFrameSummary(gif)).toEqual({
      frames: 1,
      totalDurationMs: 0,
      cumulativePixels: 256 * 128,
    });
  });

  it("sums every frame's delay (centiseconds → ms) and cumulative pixels", () => {
    const gif = buildGif({ width: 10, height: 10 }, [
      { width: 10, height: 10, delayCs: 50 }, // 500 ms
      { width: 8, height: 8, delayCs: 25 }, // 250 ms
    ]);
    expect(gifFrameSummary(gif)).toEqual({
      frames: 2,
      totalDurationMs: 750,
      cumulativePixels: 100 + 64,
    });
  });

  it("accepts a Global Color Table and skips it before the first block", () => {
    // packed bit 7 set, size field 0 → a 2-entry (6-byte) Global Color Table.
    const gif = new Uint8Array([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // "GIF89a"
      0x02,
      0x00,
      0x02,
      0x00, // logical screen 2x2
      0x80,
      0x00,
      0x00, // packed (GCT present, size 0), bg, aspect
      0x00,
      0x00,
      0x00,
      0xff,
      0xff,
      0xff, // 6-byte GCT
      0x2c,
      0x00,
      0x00,
      0x00,
      0x00,
      0x02,
      0x00,
      0x02,
      0x00,
      0x00, // image descriptor 2x2
      0x02,
      0x00, // LZW min code size + empty data
      0x3b,
    ]);
    expect(gifFrameSummary(gif)).toEqual({ frames: 1, totalDurationMs: 0, cumulativePixels: 4 });
  });

  it("returns null for a bad signature version byte", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2 }]);
    gif[4] = 0x38; // "GIF88a" — neither 87a nor 89a
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null for a GIF with no image descriptors", () => {
    // Header + Logical Screen Descriptor, then the trailer — zero frames.
    const gif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x3b,
    ]);
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null for a zero-dimension frame", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 0, height: 2 }]);
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null for a zero-dimension logical screen", () => {
    const gif = buildGif({ width: 0, height: 2 }, [{ width: 1, height: 1 }]);
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null when a frame rectangle leaves the logical screen", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2 }]);
    // No GCE: the first descriptor's left coordinate starts at byte 14.
    gif[14] = 1;
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null for an invalid LZW minimum code size", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2 }]);
    // No GCE: the first descriptor's LZW minimum code size is byte 23.
    gif[23] = 1;
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null for a Graphic Control Extension with the wrong block size", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2, delayCs: 10 }]);
    // The extension starts immediately after the 13-byte header; byte 15 is
    // its fixed data block size and must be exactly 4.
    gif[15] = 3;
    expect(gifFrameSummary(gif)).toBeNull();
  });

  it("returns null when the trailer is missing", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2 }]);
    expect(gifFrameSummary(gif.slice(0, -1))).toBeNull();
  });

  it("returns null for a truncated image descriptor", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2 }]);
    // Drop the last four bytes: the trailer, the data terminator, the LZW
    // code-size byte and the descriptor's packed byte — leaving the 9-byte
    // image descriptor short of the offset+9 bound the walker requires.
    expect(gifFrameSummary(gif.slice(0, -4))).toBeNull();
  });
});

describe("gifWithinLimits", () => {
  it("accepts a summary at the limit boundary", () => {
    expect(
      gifWithinLimits({
        frames: GIF_MAX_FRAMES,
        totalDurationMs: GIF_MAX_TOTAL_DURATION_MS,
        cumulativePixels: GIF_MAX_CUMULATIVE_PIXELS,
      }),
    ).toBe(true);
  });

  it("rejects when the frame count exceeds the limit", () => {
    expect(
      gifWithinLimits({ frames: GIF_MAX_FRAMES + 1, totalDurationMs: 0, cumulativePixels: 1 }),
    ).toBe(false);
  });

  it("rejects when the total duration exceeds the limit", () => {
    expect(
      gifWithinLimits({
        frames: 1,
        totalDurationMs: GIF_MAX_TOTAL_DURATION_MS + 1,
        cumulativePixels: 1,
      }),
    ).toBe(false);
  });

  it("rejects when the cumulative pixels exceed the limit", () => {
    expect(
      gifWithinLimits({
        frames: 1,
        totalDurationMs: 0,
        cumulativePixels: GIF_MAX_CUMULATIVE_PIXELS + 1,
      }),
    ).toBe(false);
  });
});

describe("isStructurallyValidPostImage", () => {
  it("accepts a well-formed GIF and rejects a truncated one", () => {
    const gif = buildGif({ width: 2, height: 2 }, [{ width: 2, height: 2 }]);
    expect(isStructurallyValidPostImage(gif, "image/gif")).toBe(true);
    expect(isStructurallyValidPostImage(gif.slice(0, -1), "image/gif")).toBe(false);
  });
});
