import {
  GIF_MAX_CUMULATIVE_PIXELS,
  GIF_MAX_FRAMES,
  GIF_MAX_TOTAL_DURATION_MS,
  type AllowedImageType,
} from "./constants.js";

/**
 * Checks the container structure of a post attachment without decoding pixels.
 *
 * `imageDimensions` intentionally remains a small browser-safe header parser:
 * the web client uses it before it re-encodes a selected file. Post uploads
 * need one stricter pass as well, because a signature and a header
 * are not enough to make an object a complete image. This pass checks the
 * format's chunk/marker boundaries and required terminators, but leaves costly
 * raster decoding to clients that render the image.
 *
 * For GIF this is structure only — a well-formed block walk with at least one
 * image descriptor and a terminal trailer. The animation-wide magnitude limits
 * (frame count, total duration, cumulative pixels) are enforced separately by
 * `gifWithinLimits`, at the accept layer, so an excessive-frame GIF is rejected
 * as `size` (a bound on stored/decoded work) rather than `content`.
 */
export function isStructurallyValidPostImage(bytes: Uint8Array, type: AllowedImageType): boolean {
  switch (type) {
    case "image/png":
      return validPng(bytes);
    case "image/jpeg":
      return validJpeg(bytes);
    case "image/webp":
      return validWebp(bytes);
    case "image/gif":
      return gifFrameSummary(bytes) !== null;
  }
}

function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function le16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  return (
    bytes[offset] === value.charCodeAt(0) &&
    bytes[offset + 1] === value.charCodeAt(1) &&
    bytes[offset + 2] === value.charCodeAt(2) &&
    bytes[offset + 3] === value.charCodeAt(3)
  );
}

/** PNG's chunk CRC covers the four-byte chunk name and its payload. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= bytes[offset];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes: Uint8Array): boolean {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return false;
  }

  let offset = 8;
  let hasHeader = false;
  let hasData = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;

    const length = be32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;

    if (crc32(bytes, offset + 4, dataEnd) !== be32(bytes, dataEnd)) return false;

    if (!hasHeader) {
      if (!ascii(bytes, offset + 4, "IHDR") || length !== 13 || !validPngHeader(bytes, dataStart)) {
        return false;
      }
      hasHeader = true;
    } else if (ascii(bytes, offset + 4, "IHDR")) {
      // IHDR is required exactly once and must be the first chunk.
      return false;
    }

    if (ascii(bytes, offset + 4, "IDAT")) hasData = true;

    if (ascii(bytes, offset + 4, "IEND")) {
      // IEND is the terminal chunk; accepting bytes after it would accept a
      // valid-looking image prefix followed by an unrelated payload.
      return length === 0 && hasData && chunkEnd === bytes.length;
    }

    offset = chunkEnd;
  }

  return false;
}

function validPngHeader(bytes: Uint8Array, offset: number): boolean {
  const width = be32(bytes, offset);
  const height = be32(bytes, offset + 4);
  const depth = bytes[offset + 8];
  const colorType = bytes[offset + 9];
  const compression = bytes[offset + 10];
  const filter = bytes[offset + 11];
  const interlace = bytes[offset + 12];

  if (width === 0 || height === 0 || compression !== 0 || filter !== 0 || interlace > 1) {
    return false;
  }

  // These are the bit-depth combinations defined by the PNG specification.
  switch (colorType) {
    case 0:
      return depth === 1 || depth === 2 || depth === 4 || depth === 8 || depth === 16;
    case 2:
      return depth === 8 || depth === 16;
    case 3:
      return depth === 1 || depth === 2 || depth === 4 || depth === 8;
    case 4:
    case 6:
      return depth === 8 || depth === 16;
    default:
      return false;
  }
}

const SOF_MARKERS = new Set<number>([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function isRestartMarker(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function validJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;

  let offset = 2;
  let hasSof = false;
  let hasSos = false;
  let hasScanData = false;
  let inScan = false;
  let componentCount = 0;

  while (offset < bytes.length) {
    let marker: number | undefined;

    if (inScan) {
      // Entropy-coded data may contain arbitrary bytes. Only an FF byte starts
      // a marker, and FF 00 is the byte-stuffed representation of data FF.
      let scanData = false;
      while (offset < bytes.length) {
        const value = bytes[offset];
        offset += 1;
        if (value !== 0xff) {
          scanData = true;
          continue;
        }

        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.length) return false;

        const next = bytes[offset];
        offset += 1;
        if (next === 0x00) {
          scanData = true;
          continue;
        }
        if (isRestartMarker(next)) continue;

        inScan = false;
        marker = next;
        break;
      }

      if (inScan) return false;
      if (scanData) hasScanData = true;
    } else {
      if (bytes[offset] !== 0xff) return false;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      marker = bytes[offset];
      offset += 1;
    }

    if (marker === undefined) return false;

    if (marker === 0xd9) {
      return hasSof && hasSos && hasScanData && offset === bytes.length;
    }
    if (marker === 0xd8 || marker === 0x00 || isRestartMarker(marker)) return false;
    if (marker === 0x01) continue; // TEM is the one standalone non-restart marker.

    if (offset + 2 > bytes.length) return false;
    const length = be16(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return false;

    if (SOF_MARKERS.has(marker)) {
      if (hasSof || length < 11) return false;
      const payloadLength = length - 2;
      const precision = bytes[offset + 2];
      const height = be16(bytes, offset + 3);
      const width = be16(bytes, offset + 5);
      componentCount = bytes[offset + 7];
      if (
        precision === 0 ||
        width === 0 ||
        height === 0 ||
        componentCount === 0 ||
        payloadLength !== 6 + componentCount * 3
      ) {
        return false;
      }
      hasSof = true;
    }

    if (marker === 0xda) {
      if (!hasSof || length !== 6 + bytes[offset + 2] * 2 || bytes[offset + 2] === 0) {
        return false;
      }
      // The scan header's component count cannot exceed the frame's count.
      if (bytes[offset + 2] > componentCount) return false;
      hasSos = true;
      inScan = true;
    }

    offset += length;
  }

  return false;
}

function validWebp(bytes: Uint8Array): boolean {
  if (
    bytes.length < 20 ||
    !ascii(bytes, 0, "RIFF") ||
    !ascii(bytes, 8, "WEBP") ||
    le32(bytes, 4) !== bytes.length - 8
  ) {
    return false;
  }

  let offset = 12;
  let hasFrame = false;

  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return false;

    const length = le32(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;

    if (ascii(bytes, offset, "VP8 ")) {
      const frameTag =
        bytes[dataStart] | (bytes[dataStart + 1] << 8) | (bytes[dataStart + 2] << 16);
      const firstPartitionLength = frameTag >>> 5;
      if (
        length <= 10 ||
        (frameTag & 1) !== 0 ||
        firstPartitionLength < 7 ||
        3 + firstPartitionLength >= length ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a ||
        ((bytes[dataStart + 6] | (bytes[dataStart + 7] << 8)) & 0x3fff) === 0 ||
        ((bytes[dataStart + 8] | (bytes[dataStart + 9] << 8)) & 0x3fff) === 0
      ) {
        return false;
      }
      hasFrame = true;
    } else if (ascii(bytes, offset, "VP8L")) {
      if (length <= 5 || bytes[dataStart] !== 0x2f) return false;
      hasFrame = true;
    } else if (ascii(bytes, offset, "VP8X")) {
      if (length !== 10) return false;
      const width =
        bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16);
      const height =
        bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16);
      if (width === 0xffffff || height === 0xffffff) return false;
    }

    offset = chunkEnd;
  }

  return offset === bytes.length && hasFrame;
}

/**
 * The animation-wide totals a GIF's block structure reports.
 *
 * `frames` is the number of image descriptors; `totalDurationMs` is the sum of
 * every frame's Graphic Control Extension delay (the GCE preceding an image
 * owns that image's delay); `cumulativePixels` is the sum of every frame's
 * `width × height` — the measure of decode work, which a byte cap alone cannot
 * bound because LZW-compressed flat colour compresses many large frames into
 * few bytes.
 */
export interface GifFrameSummary {
  frames: number;
  totalDurationMs: number;
  cumulativePixels: number;
}

/**
 * Advances past one GIF sub-block sequence: length-prefixed chunks terminated by
 * a zero byte. Returns the offset after the terminator, or `null` when the bytes
 * overrun before terminating. Every GIF extension and image-data payload uses
 * this framing, so one walker skips them all.
 */
function skipGifSubBlocks(bytes: Uint8Array, offset: number): number | null {
  while (true) {
    if (offset >= bytes.length) return null;
    const length = bytes[offset];
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) return null;
  }
}

/**
 * Walks a GIF's block structure and totals its animation work, or returns
 * `null` when the bytes are not a well-formed GIF.
 *
 * "Well-formed" means: a valid signature, a parseable Logical Screen Descriptor,
 * every block consumed by its own length (no overrun), at least one image
 * descriptor, and the `0x3B` trailer as the final byte. A truncated file — one
 * that ends mid-sub-block or never reaches a trailer — is `null`, the same way
 * a PNG missing IEND is. The LZW image data itself is NOT decoded here: the
 * server never rasterises an upload, so the compressed sub-blocks are skipped
 * by length, not decompressed.
 */
export function gifFrameSummary(bytes: Uint8Array): GifFrameSummary | null {
  // 6-byte signature ("GIF87a" or "GIF89a") + 7-byte Logical Screen Descriptor.
  if (bytes.length < 13) return null;
  if (
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x38 ||
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
    bytes[5] !== 0x61
  ) {
    return null;
  }

  const packed = bytes[10];
  const logicalWidth = le16(bytes, 6);
  const logicalHeight = le16(bytes, 8);
  if (logicalWidth === 0 || logicalHeight === 0) return null;

  let offset = 13;
  // Global Color Table: present when the LSD's packed byte sets bit 7; its size
  // is 3 × 2^(N+1) bytes where N is the low three bits.
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
  if (offset > bytes.length) return null;

  let frames = 0;
  let totalDurationMs = 0;
  let cumulativePixels = 0;
  // The GCE preceding an image owns that image's delay, in centiseconds.
  let pendingDelayCs = 0;

  while (offset < bytes.length) {
    const introducer = bytes[offset];
    offset += 1;

    if (introducer === 0x3b) {
      // Trailer — must be the final byte, and only after at least one frame.
      return frames > 0 && offset === bytes.length
        ? { frames, totalDurationMs, cumulativePixels }
        : null;
    }

    if (introducer === 0x2c) {
      // Image Descriptor: left, top, width, height (all LE16), then a packed
      // byte — 9 bytes after the introducer.
      if (offset + 9 > bytes.length) return null;
      const left = le16(bytes, offset);
      const top = le16(bytes, offset + 2);
      const width = le16(bytes, offset + 4);
      const height = le16(bytes, offset + 6);
      const imagePacked = bytes[offset + 8];
      offset += 9;
      if (width === 0 || height === 0) return null;
      if (left + width > logicalWidth || top + height > logicalHeight) return null;
      // Optional Local Color Table, sized the same way as the global one.
      if (imagePacked & 0x80) {
        offset += 3 * (1 << ((imagePacked & 0x07) + 1));
        if (offset > bytes.length) return null;
      }
      // LZW minimum code size, then the image-data sub-blocks.
      if (offset >= bytes.length) return null;
      if (bytes[offset] < 2 || bytes[offset] > 8) return null;
      offset += 1;
      const afterData = skipGifSubBlocks(bytes, offset);
      if (afterData === null) return null;
      offset = afterData;

      frames += 1;
      cumulativePixels += width * height;
      totalDurationMs += pendingDelayCs * 10;
      pendingDelayCs = 0;
      continue;
    }

    if (introducer === 0x21) {
      // Extension: a label byte, then sub-blocks.
      if (offset >= bytes.length) return null;
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        // Graphic Control Extension: blockSize (4), 4 data bytes, terminator.
        // The delay is the LE16 at data bytes 1-2, in centiseconds.
        if (offset + 6 > bytes.length || bytes[offset] !== 4) return null;
        // The low two bits of the GCE packed field are reserved and must be 0.
        if (bytes[offset + 1] & 0x03) return null;
        pendingDelayCs = le16(bytes, offset + 2);
      }
      const afterExt = skipGifSubBlocks(bytes, offset);
      if (afterExt === null) return null;
      offset = afterExt;
      continue;
    }

    // Any other introducer is not part of a GIF this app will accept.
    return null;
  }

  // Ran out of bytes before the trailer.
  return null;
}

/**
 * Whether a GIF's animation totals fit the centrally-defined limits. Enforced
 * at the accept layer (post and profile) so an excessive-frame, over-long, or
 * decode-bomb GIF is rejected as `size` before storage.
 */
export function gifWithinLimits(summary: GifFrameSummary): boolean {
  return (
    summary.frames <= GIF_MAX_FRAMES &&
    summary.totalDurationMs <= GIF_MAX_TOTAL_DURATION_MS &&
    summary.cumulativePixels <= GIF_MAX_CUMULATIVE_PIXELS
  );
}
