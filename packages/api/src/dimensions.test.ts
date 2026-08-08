import { describe, expect, it } from "vitest";
import { imageDimensions } from "./dimensions.js";

/**
 * Hand-crafted headers, not real files: the parser reads only the leading
 * bytes, so a synthetic header IS the file, as far as it is concerned. Each
 * fixture is built byte-by-byte so a shift in an offset fails loudly rather
 * than silently parsing a different field.
 */

describe("imageDimensions", () => {
  it("parses PNG width and height from the IHDR chunk", () => {
    // Signature, then IHDR: length (0x0D), name, then width=256, height=128.
    const png = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52,
      0x00,
      0x00,
      0x01,
      0x00, // width: 256
      0x00,
      0x00,
      0x00,
      0x80, // height: 128
    ]);

    expect(imageDimensions(png, "image/png")).toEqual({ width: 256, height: 128 });
  });

  it("skips JPEG segments and reads the first SOF", () => {
    // SOI, an APP0 segment of 16 bytes, then SOF0 with height=300, width=400.
    const jpeg = new Uint8Array([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // APP0
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08, // SOF0, length 17, precision 8
      0x01,
      0x2c, // height: 300
      0x01,
      0x90, // width: 400
    ]);

    expect(imageDimensions(jpeg, "image/jpeg")).toEqual({ width: 400, height: 300 });
  });

  it("returns null for a JPEG that reaches the scan without an SOF", () => {
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xda,
      0x00,
      0x08, // SOS straight away
    ]);

    expect(imageDimensions(jpeg, "image/jpeg")).toBeNull();
  });

  it("parses lossy WebP (VP8) dimensions as 14-bit little-endian", () => {
    // "RIFF" + size + "WEBP", then a "VP8 " chunk. The payload opens with a
    // 3-byte FRAME TAG, and only then the start code — reading the start code
    // at the payload's first byte is what used to make every simple lossy WebP
    // unparseable, and therefore refused as "not an image".
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x20,
      0x00,
      0x00,
      0x00,
      0x00,
      0xb0,
      0x5f,
      0x00, // frame tag
      0x9d,
      0x01,
      0x2a, // start code
      0x00,
      0x02, // width: 512
      0x00,
      0x01, // height: 256
    ]);

    expect(imageDimensions(webp, "image/webp")).toEqual({ width: 512, height: 256 });
  });

  it("returns null for a VP8 chunk with no start code after the frame tag", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
      0x20, 0x00, 0x00, 0x00, 0x00, 0xb0, 0x5f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01,
    ]);

    expect(imageDimensions(webp, "image/webp")).toBeNull();
  });

  it("parses lossless WebP (VP8L) dimensions from the packed word", () => {
    // VP8L packs width-1 in bits 0-13, height-1 in bits 14-27, little-endian.
    // width=257 -> 0x100; height=129 -> 0x80 << 14.
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x4c,
      0x00,
      0x00,
      0x00,
      0x00,
      0x2f,
      0x00,
      0x01,
      0x20,
      0x00, // 0x00200100 -> width 257, height 129
    ]);

    expect(imageDimensions(webp, "image/webp")).toEqual({ width: 257, height: 129 });
  });

  it("parses extended WebP (VP8X) dimensions as 24-bit little-endian", () => {
    // VP8X: flags byte, a 3-byte RESERVED field, then width-1 and height-1 as
    // 24-bit LE. Skipping the reserved field read it as the width — and since
    // it is always zero, every VP8X image measured 1px wide.
    // width=1000 -> 0x3E7 + 1; height=2000 -> 0x7CF + 1.
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x58,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x20, // flags (ICC profile present)
      0x00,
      0x00,
      0x00, // reserved
      0xe7,
      0x03,
      0x00, // width - 1
      0xcf,
      0x07,
      0x00, // height - 1
    ]);

    expect(imageDimensions(webp, "image/webp")).toEqual({ width: 1000, height: 2000 });
  });

  /**
   * The one fixture here that is NOT hand-crafted: these are the real leading
   * bytes of `canvas.toBlob(..., "image/webp")` in Chrome, captured from a
   * 667x500 canvas — the shape `apps/web/src/lib/media.ts` produces for a
   * banner. Chrome attaches an ICC profile to canvas WebP output, which forces
   * the extended VP8X container, so this is what the upload procedure actually
   * receives for EVERY image the web app re-encodes. A hand-built fixture can
   * agree with a misreading of the spec; this cannot.
   */
  it("measures a real Chrome canvas WebP at its true dimensions", () => {
    const chromeBanner = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x8e,
      0x0f,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x56,
      0x50,
      0x38,
      0x58,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x20,
      0x00,
      0x00,
      0x00,
      0x9a,
      0x02,
      0x00,
      0xf3,
      0x01,
      0x00,
      0x49,
      0x43,
      0x43,
      0x50, // the ICCP chunk that forced VP8X
    ]);

    expect(imageDimensions(chromeBanner, "image/webp")).toEqual({ width: 667, height: 500 });
  });

  it("returns null for an unknown type, a short header, or a garbled chunk", () => {
    expect(imageDimensions(new Uint8Array(64), "image/svg+xml")).toBeNull();
    expect(imageDimensions(new Uint8Array(8), "image/png")).toBeNull();
    // A WebP container whose first chunk is not one of the three image chunks.
    const webp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x00,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50,
      0x58,
      0x58,
      0x58,
      0x58,
      0x00,
      0x00,
      0x00,
      0x00,
      ...new Array<number>(32).fill(0),
    ]);
    expect(imageDimensions(webp, "image/webp")).toBeNull();
  });
});
