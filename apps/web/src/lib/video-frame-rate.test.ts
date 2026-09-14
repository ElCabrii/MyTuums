import { describe, expect, it } from "vitest";
import { readVideoFrameRate } from "./video-frame-rate";

/**
 * Synthetic containers, hand-assembled from the smallest valid boxes. The
 * parser is a boundary against real-world container quirks (moov at the tail,
 * audio-first tracks, fragmented files), so the fixtures reproduce exactly
 * those shapes rather than depending on binary fixtures nobody can read.
 */

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u64(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(value / 2 ** 32));
  view.setUint32(4, value % 2 ** 32);
  return out;
}

function u16be(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function fourcc(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function zeros(length: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length);
}

function box(type: string, content: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat(u32(content.length + 8), fourcc(type), content);
}

/** One trak with the movie-header fields the parser reads. */
function mp4Track(options: {
  handler: "vide" | "soun";
  timescale: number;
  duration: number;
  sampleCount: number;
  durationVersion?: 0 | 1;
}): Uint8Array<ArrayBuffer> {
  const hdlr = box("hdlr", concat(zeros(8), fourcc(options.handler), zeros(12)));
  const mdhd =
    options.durationVersion === 1
      ? box(
          "mdhd",
          concat(
            Uint8Array.of(1),
            zeros(3),
            u64(0),
            u64(0),
            u32(options.timescale),
            u64(options.duration),
          ),
        )
      : box(
          "mdhd",
          concat(zeros(4), u32(0), u32(0), u32(options.timescale), u32(options.duration)),
        );
  const stsz = box("stsz", concat(zeros(4), u32(0), u32(options.sampleCount)));
  const stbl = box("stbl", stsz);
  const minf = box("minf", stbl);
  return box("trak", box("mdia", concat(hdlr, mdhd, minf)));
}

function mp4File(options: {
  timescale: number;
  duration: number;
  sampleCount: number;
  /** Padding inserted before the movie header, as a media-data box would be. */
  bytesBeforeMoov?: number;
  durationVersion?: 0 | 1;
  audioTrack?: boolean;
}): File {
  const tracks = [
    mp4Track({
      handler: "vide",
      timescale: options.timescale,
      duration: options.duration,
      sampleCount: options.sampleCount,
      durationVersion: options.durationVersion,
    }),
    ...(options.audioTrack
      ? [mp4Track({ handler: "soun", timescale: 48000, duration: 8000, sampleCount: 768 })]
      : []),
  ];
  const moov = box("moov", concat(...tracks));
  const ftyp = box("ftyp", fourcc("isom"));
  const filler = options.bytesBeforeMoov
    ? box("mdat", zeros(options.bytesBeforeMoov))
    : new Uint8Array();
  return new File([concat(ftyp, filler, moov)], "clip.mp4", { type: "video/mp4" });
}

/** Minimal one-byte vint ids and sizes for the WebM fixtures. */
function ebml(id: number[], payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = sizeVint(payload.length);
  return concat(Uint8Array.from(id), Uint8Array.from(size), payload);
}

function sizeVint(value: number): number[] {
  for (let length = 1; length <= 8; length++) {
    const capacity = 2 ** (7 * length) - 1;
    if (value <= capacity) {
      const bytes = [];
      for (let index = length - 1; index >= 0; index--) {
        bytes.push((value >> (7 * index)) & 0x7f);
      }
      bytes[0] |= 1 << (8 - length);
      return bytes;
    }
  }
  return [0xff];
}

/** Big-endian integer bytes of the shortest length that holds the value. */
function beBytes(value: number): Uint8Array<ArrayBuffer> {
  const bytes = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Uint8Array.from(bytes.length === 0 ? [0] : bytes);
}

const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const TRACKS_ID = [0x16, 0x54, 0xae, 0x6b];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

function webmTrack(number: number, defaultDurationNs: number | null): Uint8Array<ArrayBuffer> {
  const fields = [
    ebml([0xd7], beBytes(number)),
    ebml([0x83], beBytes(1)),
    ...(defaultDurationNs !== null ? [ebml([0x23, 0xe3, 0x83], beBytes(defaultDurationNs))] : []),
  ];
  return ebml([0xae], concat(...fields));
}

function webmCluster(
  timecode: number,
  blocks: { track: number; relativeMs: number }[],
): Uint8Array<ArrayBuffer> {
  const children = [ebml([0xe7], beBytes(timecode))];
  for (const block of blocks) {
    // Track number keeps its vint marker inside a block payload.
    const trackVint = Uint8Array.of(0x80 | block.track);
    const payload = concat(trackVint, u16be(block.relativeMs), Uint8Array.of(0), Uint8Array.of(0));
    children.push(ebml([0xa3], payload));
  }
  return ebml(CLUSTER_ID, concat(...children));
}

function webmFile(options: {
  defaultDurationNs: number | null;
  blocks?: { track: number; relativeMs: number }[];
  videoTrackNumber?: number;
}): File {
  const videoTrackNumber = options.videoTrackNumber ?? 1;
  const segmentChildren = [
    ebml(TRACKS_ID, webmTrack(videoTrackNumber, options.defaultDurationNs)),
    ...(options.blocks ? [webmCluster(0, options.blocks)] : []),
  ];
  return new File([ebml(SEGMENT_ID, concat(...segmentChildren))], "clip.webm", {
    type: "video/webm",
  });
}

/** 60 fps worth of block timestamps at millisecond resolution. */
function sixtyFpsBlocks(count: number, track = 1): { track: number; relativeMs: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    track,
    relativeMs: Math.round((index * 1000) / 60),
  }));
}

describe("readVideoFrameRate", () => {
  describe("ISO BMFF (MP4/MOV)", () => {
    it("reads the video track's rate with an audio track present", async () => {
      const file = mp4File({ timescale: 1000, duration: 4000, sampleCount: 240, audioTrack: true });
      await expect(readVideoFrameRate(file)).resolves.toBe(60);
    });

    it("finds the movie header at the tail without reading the media data", async () => {
      const file = mp4File({
        timescale: 1000,
        duration: 4000,
        sampleCount: 120,
        bytesBeforeMoov: 512 * 1024,
      });
      await expect(readVideoFrameRate(file)).resolves.toBe(30);
    });

    it("reads 64-bit version-1 media headers", async () => {
      const file = mp4File({
        timescale: 12800,
        duration: 51200,
        sampleCount: 240,
        durationVersion: 1,
      });
      await expect(readVideoFrameRate(file)).resolves.toBe(60);
    });

    it("reports a rate above the capture sanity limit as unreadable", async () => {
      const file = mp4File({ timescale: 1000, duration: 40, sampleCount: 240 });
      await expect(readVideoFrameRate(file)).resolves.toBeNull();
    });

    it("refuses a fragmented file whose sample table is not the track's", async () => {
      const file = mp4File({ timescale: 1000, duration: 4000, sampleCount: 0 });
      await expect(readVideoFrameRate(file)).resolves.toBeNull();
    });

    it("refuses a file with no video track in its movie header", async () => {
      const audioOnly = box(
        "moov",
        mp4Track({ handler: "soun", timescale: 48000, duration: 8000, sampleCount: 768 }),
      );
      const file = new File([box("ftyp", fourcc("isom")), audioOnly], "clip.mp4", {
        type: "video/mp4",
      });
      await expect(readVideoFrameRate(file)).resolves.toBeNull();
    });

    it("refuses truncation and garbage instead of guessing", async () => {
      const moov = box(
        "moov",
        mp4Track({ handler: "vide", timescale: 1000, duration: 4000, sampleCount: 240 }),
      );
      const truncated = moov.subarray(0, moov.length - 9);
      await expect(
        readVideoFrameRate(new File([truncated], "clip.mp4", { type: "video/mp4" })),
      ).resolves.toBeNull();
      await expect(
        readVideoFrameRate(new File([new Uint8Array(64)], "clip.mov", { type: "video/quicktime" })),
      ).resolves.toBeNull();
      await expect(
        readVideoFrameRate(new File([], "clip.mp4", { type: "video/mp4" })),
      ).resolves.toBeNull();
    });
  });

  describe("WebM", () => {
    it("reads the track's declared default duration", async () => {
      // 1e9 / 16666667 ns is 60 fps within a nanosecond's rounding.
      const file = webmFile({ defaultDurationNs: 16_666_667 });
      await expect(readVideoFrameRate(file)).resolves.toBeCloseTo(60, 5);
    });

    it("estimates from block timestamps when no default duration was written", async () => {
      const blocks = [...sixtyFpsBlocks(31), { track: 2, relativeMs: 250 }];
      const file = webmFile({ defaultDurationNs: null, blocks });
      await expect(readVideoFrameRate(file)).resolves.toBeCloseTo(60, 0);
    });

    it("refuses too little media to estimate a rate", async () => {
      const file = webmFile({ defaultDurationNs: null, blocks: sixtyFpsBlocks(4) });
      await expect(readVideoFrameRate(file)).resolves.toBeNull();
    });

    it("refuses a container with no rate information at all", async () => {
      await expect(readVideoFrameRate(webmFile({ defaultDurationNs: null }))).resolves.toBeNull();
    });

    it("matches the video track's number, not the audio's", async () => {
      const file = webmFile({
        defaultDurationNs: null,
        videoTrackNumber: 2,
        blocks: [
          ...sixtyFpsBlocks(31, 2),
          { track: 1, relativeMs: 0 },
          { track: 1, relativeMs: 3 },
        ],
      });
      await expect(readVideoFrameRate(file)).resolves.toBeCloseTo(60, 0);
    });
  });

  it("refuses containers outside the accepted input types", async () => {
    const bytes = new Uint8Array(32);
    await expect(
      readVideoFrameRate(new File([bytes], "clip.mkv", { type: "video/x-matroska" })),
    ).resolves.toBeNull();
  });
});
