/**
 * Image dimensions read from header bytes, with no decode.
 *
 * This is the browser-safe sibling of `./constants.ts`: dependency-free and
 * exposed under `@my-tuums/api/dimensions`, so BOTH sides of an upload use the
 * same parser. The server enforces the caps against it (`./image.ts`), and the
 * web app sizes its `createImageBitmap` resize options with it
 * (`apps/web/src/lib/media.ts`) — without it, the client would have to decode
 * a 12 MP photo at full resolution just to learn it should downscale it.
 *
 * All three formats carry their dimensions near the start of the file, so no
 * pixel data is ever read. `null` means "not a parseable image of this type".
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function be32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function le32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

/**
 * PNG: 8-byte signature, then an IHDR chunk whose 13-byte payload starts with
 * width (BE32) and height (BE32) at offsets 16 and 20.
 */
function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/**
 * JPEG: segments between the SOI marker (FF D8) and the first SOF. Each segment
 * is FF, a marker byte, then a 2-byte BE length; the SOF's payload is
 * precision, then height (BE16) and width (BE16). Everything else — APPn, DQT,
 * DHT, COM — is skipped by length. A file that reaches SOS or EOI without an
 * SOF is not a JPEG we can size.
 */
const SOF_MARKERS = new Set<number>([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let p = 2;
  while (p + 3 < bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1];

    if (SOF_MARKERS.has(marker)) {
      if (p + 9 > bytes.length) return null;
      return { height: be16(bytes, p + 5), width: be16(bytes, p + 7) };
    }

    // SOS starts the compressed scan — no SOF came before it.
    if (marker === 0xda || marker === 0xd9) return null;

    const length = be16(bytes, p + 2);
    if (length < 2) return null;
    p += 2 + length;
  }
  return null;
}

/**
 * WebP is a RIFF container: "RIFF" + size + "WEBP", then chunks of
 * fourcc + size + payload. The three chunk types carry dimensions differently:
 *
 * - VP8 (lossy): a fixed 3-byte tag, then 14-bit width and height (LE), masked
 *   because the top two bits of each word hold a scale flag.
 * - VP8L (lossless): a 1-byte tag, then a 4-byte LE word with width-1 in bits
 *   0-13 and height-1 in bits 14-27.
 * - VP8X (extended): a flags byte, then 24-bit width-1 and height-1 (LE).
 */
function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 25) return null;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return null;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return null;

  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);

  if (fourcc === "VP8 " && bytes[20] === 0x9d && bytes[21] === 0x01 && bytes[22] === 0x2a) {
    if (bytes.length < 27) return null;
    // 14-bit little-endian words; the top two bits of each hold a scale flag.
    return { width: (bytes[23] | (bytes[24] << 8)) & 0x3fff, height: (bytes[25] | (bytes[26] << 8)) & 0x3fff };
  }

  if (fourcc === "VP8L" && bytes[20] === 0x2f) {
    const packed = le32(bytes, 21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }

  if (fourcc === "VP8X") {
    if (bytes.length < 27) return null;
    const width = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16);
    const height = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    return { width: width + 1, height: height + 1 };
  }

  return null;
}

const PARSERS: Record<string, (bytes: Uint8Array) => ImageDimensions | null> = {
  "image/png": pngDimensions,
  "image/jpeg": jpegDimensions,
  "image/webp": webpDimensions,
};

/**
 * The dimensions a file of `type` declares in its header, or `null` when the
 * bytes are too short or malformed to say.
 */
export function imageDimensions(bytes: Uint8Array, type: string): ImageDimensions | null {
  return PARSERS[type]?.(bytes) ?? null;
}
