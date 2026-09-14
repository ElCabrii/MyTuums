/**
 * Bounded local container-metadata parsing for the composer's 60 fps preflight
 * (issue #404).
 *
 * `HTMLVideoElement.loadedmetadata` exposes duration and dimensions but not
 * the encoded track frame rate, so this module reads it out of the container:
 * ISO BMFF (MP4/MOV) movie headers and WebM/Matroska track headers. It is
 * loaded lazily by `video-preflight.ts`, so ordinary page startup pays
 * neither its bundle nor its parsing cost.
 *
 * Every read is bounded: MP4 box headers are walked with tiny slices, so a
 * movie header at the tail is found without reading the media data before it,
 * and the movie header itself plus the WebM head are each capped below. Any
 * inconsistency — unknown layout, oversized or absent headers, a fragmented
 * MP4 whose sample table does not describe the whole track, a WebM muxer
 * that wrote no per-track duration and too little media to estimate one —
 * returns `null` rather than a guess, and the preflight refuses the file.
 * The provider's own processing remains the authority; this is a cooperative
 * early refusal, never the boundary.
 */

/** A `moov` box larger than this is treated as unparsable, not read. */
const MP4_MOVIE_HEADER_LIMIT = 4 * 1024 * 1024;
/** The WebM head parsed in one read: EBML header, Info, Tracks, first clusters. */
const WEBM_HEAD_LIMIT = 4 * 1024 * 1024;
/** Top-level ISO BMFF boxes walked before the `moov` search gives up. */
const MP4_TOP_LEVEL_BOX_LIMIT = 64;
/** Beyond a plausible capture rate the value is corruption, not a frame rate. */
const FRAME_RATE_SANITY_LIMIT = 240;
/** Timestamp sampling stops once this many video blocks have been seen. */
const WEBM_BLOCK_SAMPLE_LIMIT = 240;
/** Timestamp sampling needs at least this much media time to estimate a rate. */
const WEBM_MIN_SAMPLE_SPAN_MS = 250;

async function readSlice(file: File, start: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

function ascii(view: Uint8Array, start: number, length: number): string {
  let value = "";
  for (let index = 0; index < length; index++) value += String.fromCharCode(view[start + index]);
  return value;
}

function readU32(view: Uint8Array, start: number): number {
  return (
    view[start] * 0x1000000 + view[start + 1] * 0x10000 + view[start + 2] * 0x100 + view[start + 3]
  );
}

function readU64(view: Uint8Array, start: number): number {
  let value = 0;
  for (let index = 0; index < 8; index++) value = value * 256 + view[start + index];
  return value;
}

function readI16(view: Uint8Array, start: number): number {
  const raw = (view[start] << 8) | view[start + 1];
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

// ---------------------------------------------------------------------------
// ISO BMFF (MP4, MOV)
// ---------------------------------------------------------------------------

interface Box {
  type: string;
  /** Content range, after the box header. */
  start: number;
  end: number;
}

/**
 * Reads one box header at `offset`. `null` when the bytes cannot describe a
 * box that fits inside the file — the caller stops walking.
 */
async function readBoxHeader(file: File, offset: number): Promise<Box | null> {
  if (offset < 0 || offset + 8 > file.size) return null;
  const header = await readSlice(file, offset, 16);
  if (header.length < 8) return null;
  let start = offset + 8;
  let length = readU32(header, 0);
  if (length === 1) {
    if (header.length < 16) return null;
    const large = readU64(header, 8);
    if (!Number.isSafeInteger(large)) return null;
    length = large;
    start = offset + 16;
  } else if (length === 0) {
    length = file.size - offset;
  }
  if (length < start - offset || offset + length > file.size) return null;
  return { type: ascii(header, 4, 4), start, end: offset + length };
}

/**
 * Walks the top-level boxes to the `moov` header. Slices are 16 bytes per
 * box, so a movie header at the tail of a large file costs the walk, not a
 * read of the media data before it.
 */
async function findMovieHeader(file: File): Promise<Uint8Array | null> {
  let offset = 0;
  for (let guard = 0; guard < MP4_TOP_LEVEL_BOX_LIMIT && offset < file.size; guard++) {
    const box = await readBoxHeader(file, offset);
    if (!box) return null;
    if (box.type === "moov") {
      if (box.end - box.start > MP4_MOVIE_HEADER_LIMIT) return null;
      return readSlice(file, box.start, box.end - box.start);
    }
    offset = box.end;
  }
  return null;
}

/** Iterates the direct child boxes of `[start, end)` inside an owned buffer. */
function* iterateBoxes(view: Uint8Array, start: number, end: number): Generator<Box> {
  for (let offset = start; offset + 8 <= end;) {
    const length = readU32(view, offset);
    const type = ascii(view, offset + 4, 4);
    const boxStart = offset + 8;
    let boxEnd: number;
    if (length === 1) {
      if (offset + 16 > end) return;
      const large = readU64(view, offset + 8);
      if (!Number.isSafeInteger(large)) return;
      boxEnd = offset + large;
    } else if (length === 0) {
      boxEnd = end;
    } else {
      boxEnd = offset + length;
    }
    if (boxEnd <= boxStart || boxEnd > end) return;
    yield { type, start: boxStart, end: boxEnd };
    offset = boxEnd;
  }
}

/**
 * The video track's average frame rate from its movie header:
 * `sampleCount × timescale ÷ duration`. An average is what a variable-rate
 * track can honestly report; the provider independently caps what it delivers
 * after upload.
 */
function parseMovieHeaderFrameRate(moov: Uint8Array): number | null {
  for (const trak of iterateBoxes(moov, 0, moov.length)) {
    if (trak.type !== "trak") continue;
    let isVideo = false;
    let timescale = 0;
    let duration = 0;
    let sampleCount = 0;
    for (const mdia of iterateBoxes(moov, trak.start, trak.end)) {
      if (mdia.type !== "mdia") continue;
      for (const leaf of iterateBoxes(moov, mdia.start, mdia.end)) {
        if (leaf.type === "hdlr" && leaf.end - leaf.start >= 12) {
          // version/flags (4) + pre_defined (4), then the fourcc.
          if (ascii(moov, leaf.start + 8, 4) === "vide") isVideo = true;
        } else if (leaf.type === "mdhd") {
          const version = moov[leaf.start];
          if (version === 1 && leaf.end - leaf.start >= 32) {
            timescale = readU32(moov, leaf.start + 20);
            duration = readU64(moov, leaf.start + 24);
          } else if (version === 0 && leaf.end - leaf.start >= 20) {
            timescale = readU32(moov, leaf.start + 12);
            duration = readU32(moov, leaf.start + 16);
          }
        } else if (leaf.type === "minf") {
          for (const stbl of iterateBoxes(moov, leaf.start, leaf.end)) {
            if (stbl.type !== "stbl") continue;
            for (const table of iterateBoxes(moov, stbl.start, stbl.end)) {
              // Both sample-size tables carry their entry count at the same
              // offset: eight bytes into the payload.
              if (
                (table.type === "stsz" || table.type === "stz2") &&
                table.end - table.start >= 12
              ) {
                sampleCount ||= readU32(moov, table.start + 8);
              }
            }
          }
        }
      }
    }
    // A zero sample count is the fragmented-MP4 shape: the table describes
    // only the movie-fragment preamble, so the count is not the track's.
    if (isVideo && timescale > 0 && duration > 0 && sampleCount > 0) {
      const frameRate = (sampleCount * timescale) / duration;
      if (Number.isFinite(frameRate) && frameRate > 0) return frameRate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// WebM / Matroska
// ---------------------------------------------------------------------------

const EBML_SEGMENT_ID = 0x18538067;
const EBML_INFO_ID = 0x1549a966;
const EBML_TIMECODE_SCALE_ID = 0x2ad7b1;
const EBML_TRACKS_ID = 0x1654ae6b;
const EBML_TRACK_ENTRY_ID = 0xae;
const EBML_TRACK_NUMBER_ID = 0xd7;
const EBML_TRACK_TYPE_ID = 0x83;
const EBML_DEFAULT_DURATION_ID = 0x23e383;
const EBML_CLUSTER_ID = 0x1f43b675;
const EBML_CLUSTER_TIMECODE_ID = 0xe7;
const EBML_SIMPLE_BLOCK_ID = 0xa3;

interface EbmlElement {
  id: number;
  /** Content range, after the id and size vints. */
  start: number;
  end: number;
}

/** Vint length from the marker bit of the first byte; 0 means the byte was 0. */
function vintLength(first: number): number {
  let length = 0;
  for (let mask = 0x80; mask > 0; mask >>= 1) {
    length++;
    if (first & mask) return length;
  }
  return 0;
}

/**
 * Reads an EBML id: ids keep all their bits, so the bytes are taken whole.
 * `null` when the vint is malformed or runs past the view.
 */
function readEbmlId(view: Uint8Array, offset: number): { id: number; length: number } | null {
  const length = vintLength(view[offset] ?? 0);
  if (length === 0 || length > 4 || offset + length > view.length) return null;
  let id = 0;
  for (let index = 0; index < length; index++) id = id * 256 + view[offset + index];
  return { id, length };
}

/** Reads an unsigned EBML vint with the marker bits stripped — sizes and block track numbers. */
function readEbmlUint(view: Uint8Array, offset: number): { value: number; length: number } | null {
  const length = vintLength(view[offset] ?? 0);
  if (length === 0 || length > 8 || offset + length > view.length) return null;
  let value = view[offset] & (0xff >> length);
  for (let index = 1; index < length; index++) value = value * 256 + view[offset + index];
  return { value, length };
}

/**
 * One leaf's unsigned value. Element data is a plain big-endian integer —
 * Matroska's known asymmetry: only the element's id and size (and a block's
 * track number) are self-delimiting vints.
 */
function ebmlUintAt(view: Uint8Array, element: EbmlElement): number | null {
  const length = element.end - element.start;
  if (length <= 0 || length > 6) return null;
  let value = 0;
  for (let index = element.start; index < element.end; index++) value = value * 256 + view[index];
  return value;
}

/**
 * Iterates the direct children of `[start, end)`. An unknown size (every size
 * bit set) extends the element to the end of the enclosing scope, which is
 * how streamed WebM segments present themselves; an element whose declared
 * size runs past the buffer yields what was read, since the sample caps —
 * not the buffer edge — bound the walk.
 */
function* iterateEbml(view: Uint8Array, start: number, end: number): Generator<EbmlElement> {
  for (let offset = start; offset < end;) {
    const id = readEbmlId(view, offset);
    if (!id) return;
    const size = readEbmlUint(view, offset + id.length);
    if (!size) return;
    const contentStart = offset + id.length + size.length;
    // A size whose vint bytes are all ones is "unknown", not a value.
    let unknownSize = true;
    for (let index = 0; index < size.length; index++) {
      if (view[offset + id.length + index] !== 0xff) unknownSize = false;
    }
    const contentEnd = unknownSize ? end : Math.min(contentStart + size.value, end);
    if (contentEnd < contentStart || contentEnd <= offset) return;
    yield { id: id.id, start: contentStart, end: contentEnd };
    offset = contentEnd;
  }
}

interface WebmTrack {
  number: number;
  isVideo: boolean;
  defaultDurationNs: number;
}

/** What the WebM head parse extracts: tracks plus the timestamp unit. */
interface WebmHead {
  tracks: WebmTrack[];
  timecodeScale: number;
}

function parseWebmTracks(head: Uint8Array): WebmHead {
  const tracks: WebmTrack[] = [];
  let timecodeScale = 1_000_000;
  for (const segment of iterateEbml(head, 0, head.length)) {
    if (segment.id !== EBML_SEGMENT_ID) continue;
    for (const child of iterateEbml(head, segment.start, segment.end)) {
      if (child.id === EBML_INFO_ID) {
        for (const field of iterateEbml(head, child.start, child.end)) {
          if (field.id === EBML_TIMECODE_SCALE_ID) {
            const value = ebmlUintAt(head, field);
            if (value && value > 0) timecodeScale = value;
          }
        }
      } else if (child.id === EBML_TRACKS_ID) {
        for (const entry of iterateEbml(head, child.start, child.end)) {
          if (entry.id !== EBML_TRACK_ENTRY_ID) continue;
          const track: WebmTrack = { number: 0, isVideo: false, defaultDurationNs: 0 };
          for (const leaf of iterateEbml(head, entry.start, entry.end)) {
            if (leaf.id === EBML_TRACK_NUMBER_ID) track.number = ebmlUintAt(head, leaf) ?? 0;
            else if (leaf.id === EBML_TRACK_TYPE_ID) track.isVideo = ebmlUintAt(head, leaf) === 1;
            else if (leaf.id === EBML_DEFAULT_DURATION_ID)
              track.defaultDurationNs = ebmlUintAt(head, leaf) ?? 0;
          }
          if (track.number > 0) tracks.push(track);
        }
      }
    }
  }
  return { tracks, timecodeScale };
}

/**
 * Estimates the rate from the video track's block timestamps when the muxer
 * wrote no DefaultDuration. Bounded by the head slice already in memory and
 * by the sample caps above.
 */
function estimateWebmFrameRate(
  head: Uint8Array,
  videoTrackNumber: number,
  timecodeScale: number,
): number | null {
  const timestamps: number[] = [];
  let clusterTimecode = 0;
  sample: for (const segment of iterateEbml(head, 0, head.length)) {
    if (segment.id !== EBML_SEGMENT_ID) continue;
    for (const child of iterateEbml(head, segment.start, segment.end)) {
      if (child.id !== EBML_CLUSTER_ID) continue;
      for (const block of iterateEbml(head, child.start, child.end)) {
        if (block.id === EBML_CLUSTER_TIMECODE_ID) {
          clusterTimecode = ebmlUintAt(head, block) ?? clusterTimecode;
        } else if (block.id === EBML_SIMPLE_BLOCK_ID && block.end - block.start >= 4) {
          const track = readEbmlUint(head, block.start);
          if (track && track.value === videoTrackNumber) {
            timestamps.push(clusterTimecode + readI16(head, block.start + track.length));
          }
        }
        if (timestamps.length >= WEBM_BLOCK_SAMPLE_LIMIT) break sample;
      }
    }
  }
  if (timestamps.length < 2) return null;
  const spanUnits = timestamps[timestamps.length - 1] - timestamps[0];
  const spanSeconds = (spanUnits * timecodeScale) / 1e9;
  if (spanSeconds < WEBM_MIN_SAMPLE_SPAN_MS / 1000) return null;
  const frameRate = (timestamps.length - 1) / spanSeconds;
  return Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null;
}

/**
 * The encoded video track's average frame rate, or `null` when the container
 * does not describe one within the bounded read. Cloudflare Stream does not
 * report the source clip's encoded rate after upload, so this local read is
 * the only place the 60 fps policy can see one.
 */
export async function readVideoFrameRate(file: File): Promise<number | null> {
  const sane = (rate: number | null): number | null =>
    rate !== null && rate > 0 && rate <= FRAME_RATE_SANITY_LIMIT ? rate : null;

  if (file.type === "video/mp4" || file.type === "video/quicktime") {
    const moov = await findMovieHeader(file);
    return moov ? sane(parseMovieHeaderFrameRate(moov)) : null;
  }
  if (file.type === "video/webm") {
    const head = await readSlice(file, 0, Math.min(file.size, WEBM_HEAD_LIMIT));
    const { tracks, timecodeScale } = parseWebmTracks(head);
    const video = tracks.find((track) => track.isVideo);
    if (!video) return null;
    if (video.defaultDurationNs > 0) return sane(1e9 / video.defaultDurationNs);
    return sane(estimateWebmFrameRate(head, video.number, timecodeScale));
  }
  return null;
}
