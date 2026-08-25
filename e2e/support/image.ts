import { deflateSync } from "node:zlib";

/** CRC-32 for the chunks in the small PNG fixtures used by upload journeys. */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A genuine RGB PNG of arbitrary size for storage-backed browser journeys.
 * The gradient keeps compression realistic enough to exercise byte limits,
 * while the dimensions remain visible at each call site.
 */
export function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: truecolour RGB

  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = Math.floor((x * 255) / width);
      raw[pixel + 1] = Math.floor((y * 255) / height);
      raw[pixel + 2] = 0x80;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The camera-make string planted in the EXIF fixture, greppable in responses. */
export const EXIF_PROBE_STRING = "MyTuumsExifProbeCam";

function be16(n: number): Buffer {
  return Buffer.from([(n >> 8) & 0xff, n & 0xff]);
}

function le16(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff]);
}

function le32(n: number): Buffer {
  return Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
}

/**
 * A baseline grayscale JPEG's segments after the SOI marker.
 *
 * Spec-conformant but minimal: a flat quantization table and one-bit Huffman
 * codes — DC difference category 0 and AC end-of-block are both code "0" —
 * so every 8x8 block of the solid mid-gray frame encodes as two zero bits.
 * Browsers decode it like any other JPEG.
 */
function grayJpegSegments(width: number, height: number): Buffer[] {
  // One Huffman code of length 1; its symbol is 0x00 for both tables.
  const huffmanCounts = Buffer.alloc(16);
  huffmanCounts[0] = 1;

  const dht = Buffer.concat([
    Buffer.from([0xff, 0xc4]),
    be16(2 + 2 * (1 + 16 + 1)),
    Buffer.from([0x00]),
    huffmanCounts,
    Buffer.from([0x00]), // DC table 0: symbol 0x00
    Buffer.from([0x10]),
    huffmanCounts,
    Buffer.from([0x00]), // AC table 0: symbol 0x00 (end of block)
  ]);

  const dqt = Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]), Buffer.alloc(64, 1)]);

  const sof0 = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08]),
    be16(height),
    be16(width),
    // One grayscale component, sampled 1x1, quantized by table 0.
    Buffer.from([0x01, 0x01, 0x11, 0x00]),
  ]);

  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);

  const bitCount = Math.ceil(width / 8) * Math.ceil(height / 8) * 2;
  const padBits = (8 - (bitCount % 8)) % 8;
  const entropy = Buffer.alloc(Math.ceil(bitCount / 8));
  if (padBits > 0) entropy[entropy.length - 1] |= (1 << padBits) - 1;

  return [
    dqt,
    dht,
    sof0,
    sos,
    entropy,
    Buffer.from([0xff, 0xd9]), // EOI
  ];
}

/**
 * A genuine JPEG carrying an EXIF APP1 segment, for journeys that must prove
 * uploaded attachments do not keep their metadata (issue #207).
 *
 * The EXIF is well-formed enough for real parsers: little-endian TIFF, an
 * IFD0 naming a camera (`EXIF_PROBE_STRING`) plus a GPS IFD holding real
 * latitude/longitude RATIONALs. The pixel data itself is solid mid-gray.
 */
export function jpegWithExif(width: number, height: number): Buffer {
  const make = Buffer.from(`${EXIF_PROBE_STRING}\0`, "ascii");
  const model = Buffer.from("GPS Spy Unit\0", "ascii");

  const gpsRationals = Buffer.alloc(48);
  const rational = (index: number, numerator: number, denominator = 1) => {
    gpsRationals.writeUInt32LE(numerator, index * 8);
    gpsRationals.writeUInt32LE(denominator, index * 8 + 4);
  };
  rational(0, 37);
  rational(1, 46);
  rational(2, 2219, 100); // latitude 37°46'22.19"N
  rational(3, 122);
  rational(4, 25);
  rational(5, 1206, 100); // longitude 122°25'12.06"W

  /** One 12-byte TIFF IFD entry whose value field holds a data-block offset. */
  const offsetEntry = (tag: number, type: number, count: number, offset: number) => {
    const out = Buffer.alloc(12);
    out.writeUInt16LE(tag, 0);
    out.writeUInt16LE(type, 2);
    out.writeUInt32LE(count, 4);
    out.writeUInt32LE(offset, 8);
    return out;
  };

  /** One 12-byte TIFF IFD entry whose value fits in the four-byte field. */
  const inlineEntry = (tag: number, type: number, count: number, value: Buffer) => {
    if (value.length > 4) throw new Error("inline EXIF value too large");
    const out = Buffer.alloc(12);
    out.writeUInt16LE(tag, 0);
    out.writeUInt16LE(type, 2);
    out.writeUInt32LE(count, 4);
    value.copy(out, 8);
    return out;
  };

  // Layout within the TIFF block: header, IFD0, then the value and IFD data
  // the entries point at.
  const makeOffset = 8 + (2 + 3 * 12 + 4);
  const modelOffset = makeOffset + make.length;
  const rationalsOffset = modelOffset + model.length;
  const gpsIfdOffset = rationalsOffset + gpsRationals.length;

  const ifd0 = Buffer.concat([
    le16(3),
    offsetEntry(0x010f, 2, make.length, makeOffset), // Make
    offsetEntry(0x0110, 2, model.length, modelOffset), // Model
    offsetEntry(0x8825, 4, 1, gpsIfdOffset), // GPS Info IFD pointer
    le32(0),
  ]);

  const gpsIfd = Buffer.concat([
    le16(5),
    inlineEntry(0x0000, 1, 4, Buffer.from([2, 3, 0, 0])), // GPSVersionID
    inlineEntry(0x0001, 2, 2, Buffer.from([0x4e, 0x00])), // latitude ref "N"
    offsetEntry(0x0002, 5, 3, rationalsOffset), // GPSLatitude
    inlineEntry(0x0003, 2, 2, Buffer.from([0x57, 0x00])), // longitude ref "W"
    offsetEntry(0x0004, 5, 3, rationalsOffset + 24), // GPSLongitude
    le32(0),
  ]);

  const tiff = Buffer.concat([
    Buffer.from([0x49, 0x49, 0x2a, 0x00]), // "II" little-endian TIFF
    le32(8), // IFD0 follows the 8-byte header
    ifd0,
    make,
    model,
    gpsRationals,
    gpsIfd,
  ]);

  const exifPayload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    be16(exifPayload.length + 2),
    exifPayload,
  ]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    app1,
    ...grayJpegSegments(width, height),
  ]);
}
