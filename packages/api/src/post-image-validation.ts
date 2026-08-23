import type { AllowedImageType } from "./constants.js";

/**
 * Checks the container structure of a post attachment without decoding pixels.
 *
 * `imageDimensions` intentionally remains a small browser-safe header parser:
 * the web client uses it before it re-encodes a selected file. Post uploads
 * need one stricter pass as well, because a signature and a header
 * are not enough to make an object a complete image. This pass checks the
 * format's chunk/marker boundaries and required terminators, but leaves costly
 * raster decoding to clients that render the image.
 */
export function isStructurallyValidPostImage(bytes: Uint8Array, type: AllowedImageType): boolean {
  switch (type) {
    case "image/png":
      return validPng(bytes);
    case "image/jpeg":
      return validJpeg(bytes);
    case "image/webp":
      return validWebp(bytes);
  }
}

function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
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
      if (
        length < 10 ||
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
      if (length < 5 || bytes[dataStart] !== 0x2f) return false;
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
