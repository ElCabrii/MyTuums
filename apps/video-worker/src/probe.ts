import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_SECONDS,
  VIDEO_MAX_FPS,
  VIDEO_MAX_LONG_EDGE,
  VIDEO_MAX_SHORT_EDGE,
} from "@my-tuums/api/constants";
import { runMediaProcess } from "./process.js";

const streamProbe = z.object({
  index: z.number().int().nonnegative(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sample_aspect_ratio: z.string().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  time_base: z.string().optional(),
  duration: z.string().optional(),
  color_transfer: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
});
const probeDocument = z.object({
  format: z.object({ format_name: z.string(), duration: z.string() }),
  streams: z.array(streamProbe),
});
const frameDocument = z.object({
  frames: z
    .array(
      z.object({
        best_effort_timestamp_time: z.string(),
        duration_time: z.string().optional(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        sample_aspect_ratio: z.string().optional(),
      }),
    )
    .min(1)
    .max(VIDEO_MAX_DURATION_SECONDS * VIDEO_MAX_FPS + 1),
});

function readProbe<T>(text: string, schema: z.ZodType<T>): T {
  try {
    const parsed: unknown = JSON.parse(text);
    return schema.parse(parsed);
  } catch {
    throw new InvalidVideoError("The video could not be read.");
  }
}

export class InvalidVideoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVideoError";
  }
}

export interface VideoSource {
  width: number;
  height: number;
  codedWidth: number;
  codedHeight: number;
  rotation: number;
  duration: number;
  frameRate: number;
  timestampPrecision: number;
  videoStream: number;
  audioStream: number | null;
  hdr: boolean;
  byteSize: number;
}

function fraction(value: string | undefined, separator: "/" | ":", fallback: number): number {
  if (!value || value === "N/A" || value === "0/0" || value === "0:1") return fallback;
  const [numerator, denominator] = value.split(separator).map(Number);
  const result = numerator / denominator;
  if (!Number.isFinite(result) || result <= 0)
    throw new InvalidVideoError("Invalid video timing or dimensions.");
  return result;
}

function displayedDimensions(width: number, height: number, sar: number, rotation: number) {
  const displayWidth = width * sar;
  const turned = Math.abs(rotation) % 180 === 90;
  return { width: turned ? height : displayWidth, height: turned ? displayWidth : height };
}

function validateDimensions(width: number, height: number) {
  if (
    Math.max(width, height) > VIDEO_MAX_LONG_EDGE ||
    Math.min(width, height) > VIDEO_MAX_SHORT_EDGE
  ) {
    throw new InvalidVideoError("Video dimensions must fit 1920×1080 or 1080×1920.");
  }
}

/** Parses only FFprobe output, never browser declarations. */
export function parseVideoProbe(
  json: string,
  byteSize: number,
  container: "mov" | "webm",
): VideoSource {
  if (byteSize <= 0 || byteSize > VIDEO_MAX_BYTES)
    throw new InvalidVideoError("Video must be at most 500 MB.");
  const { streams, format } = readProbe(json, probeDocument);
  const videos = streams.filter(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1 || audios.length > 1)
    throw new InvalidVideoError("Video must contain one video track and at most one audio track.");
  const video = videos[0];
  const audio = audios[0];
  const codecs = container === "webm" ? ["vp8", "vp9", "av1"] : ["h264", "hevc", "av1"];
  const audioCodecs =
    container === "webm"
      ? ["opus", "vorbis"]
      : ["aac", "mp3", "alac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le"];
  if (
    !codecs.includes(video.codec_name ?? "") ||
    (audio && !audioCodecs.includes(audio.codec_name ?? ""))
  ) {
    throw new InvalidVideoError("Unsupported video or audio codec.");
  }
  if (
    !(container === "mov"
      ? format.format_name.split(",").includes("mov")
      : format.format_name.split(",").includes("webm"))
  ) {
    throw new InvalidVideoError("Unsupported video container.");
  }
  if (!video.width || !video.height) throw new InvalidVideoError("Invalid video dimensions.");
  const rotation = video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0;
  if (rotation % 90 !== 0) throw new InvalidVideoError("Unsupported video rotation.");
  const sar = fraction(video.sample_aspect_ratio, ":", 1);
  const dimensions = displayedDimensions(video.width, video.height, sar, rotation);
  validateDimensions(dimensions.width, dimensions.height);
  // A non-square pixel aspect ratio cannot disguise an oversized coded input.
  validateDimensions(video.width, video.height);
  const duration = Math.max(
    Number(format.duration),
    Number(video.duration ?? format.duration),
    Number(audio?.duration ?? format.duration),
  );
  if (!Number.isFinite(duration) || duration <= 0 || duration > VIDEO_MAX_DURATION_SECONDS) {
    throw new InvalidVideoError("Video must be at most 5 minutes.");
  }
  const frameRate = Math.max(
    fraction(video.avg_frame_rate, "/", 0),
    fraction(video.r_frame_rate, "/", 0),
  );
  if (frameRate <= 0 || frameRate > VIDEO_MAX_FPS + 0.001)
    throw new InvalidVideoError("Video must be at most 60 fps.");
  return {
    ...dimensions,
    codedWidth: video.width,
    codedHeight: video.height,
    rotation,
    duration,
    frameRate,
    timestampPrecision: fraction(video.time_base, "/", 0.000001),
    videoStream: video.index,
    audioStream: audio?.index ?? null,
    hdr: video.color_transfer === "smpte2084" || video.color_transfer === "arib-std-b67",
    byteSize,
  };
}

/** A low average rate or forged header cannot hide over-limit decoded frames. */
export function validateVideoFrames(json: string, source: VideoSource): void {
  const { frames } = readProbe(json, frameDocument);
  let previous: number | null = null;
  const first = Number(frames[0].best_effort_timestamp_time);
  for (const frame of frames) {
    const timestamp = Number(frame.best_effort_timestamp_time);
    const duration = Number(frame.duration_time ?? 0);
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0)
      throw new InvalidVideoError("Invalid video timestamps.");
    // WebM commonly uses millisecond ticks, so 60 fps alternates 16/17 ms.
    // Allow one input tick of quantization, while refusing duplicate times.
    if (
      previous !== null &&
      (timestamp <= previous ||
        timestamp - previous < 1 / VIDEO_MAX_FPS - source.timestampPrecision - 0.000001)
    ) {
      throw new InvalidVideoError("Video must be at most 60 fps.");
    }
    if (timestamp - first + duration > VIDEO_MAX_DURATION_SECONDS + 0.000002) {
      throw new InvalidVideoError("Video must be at most 5 minutes.");
    }
    if (frame.width !== source.codedWidth || frame.height !== source.codedHeight) {
      throw new InvalidVideoError("Video dimensions must remain constant.");
    }
    const dimensions = displayedDimensions(
      frame.width,
      frame.height,
      fraction(frame.sample_aspect_ratio, ":", 1),
      source.rotation,
    );
    if (dimensions.width !== source.width || dimensions.height !== source.height)
      throw new InvalidVideoError("Video dimensions must remain constant.");
    previous = timestamp;
  }
}

async function readContainer(filename: string): Promise<"mov" | "webm"> {
  const handle = await open(filename, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.length >= 12 && bytes.readUInt32BE(0) === 0x1a45dfa3) {
      // EBML DocType element 0x4282, size 4, value "webm". Matroska is
      // decoded by the same demuxer but is outside the accepted containers.
      if (bytes.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return "webm";
    }
    if (bytes.length >= 12) {
      const box = bytes.toString("ascii", 4, 8);
      const brand = bytes.toString("ascii", 8, 12);
      if (
        box === "ftyp" &&
        /^(isom|iso[2-9]|mp4[12]|avc1|hvc1|hev1|av01|qt {2}|M4V |MSNV)$/.test(brand)
      )
        return "mov";
      if (["moov", "mdat", "wide"].includes(box)) return "mov";
    }
    throw new InvalidVideoError("Upload an MP4, MOV, or WebM video.");
  } finally {
    await handle.close();
  }
}

export const VIDEO_INPUT_OPTIONS = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,matroska,webm",
  "-probesize",
  "8388608",
  "-analyzeduration",
  "10000000",
  "-max_alloc",
  "67108864",
] as const;

export async function probeVideo(
  filename: string,
  signal: AbortSignal,
  threads = 2,
): Promise<VideoSource> {
  const input = resolve(filename);
  const { size } = await stat(input);
  if (size <= 0 || size > VIDEO_MAX_BYTES)
    throw new InvalidVideoError("Video must be at most 500 MB.");
  const container = await readContainer(input);
  const options = { cwd: dirname(input), signal };
  const metadata = await runMediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      ...VIDEO_INPUT_OPTIONS,
      "-threads",
      String(threads),
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      input,
    ],
    options,
  );
  if (metadata.stderr) throw new InvalidVideoError("The video could not be decoded.");
  const source = parseVideoProbe(metadata.stdout, size, container);
  const frames = await runMediaProcess(
    "ffprobe",
    [
      "-v",
      "error",
      ...VIDEO_INPUT_OPTIONS,
      "-threads",
      String(threads),
      "-select_streams",
      String(source.videoStream),
      "-show_frames",
      "-show_entries",
      "frame=best_effort_timestamp_time,duration_time,width,height,sample_aspect_ratio:frame_side_data=",
      "-of",
      "json=compact=1",
      input,
    ],
    { ...options, maxOutputBytes: 8 * 1024 * 1024 },
  );
  if (frames.stderr) throw new InvalidVideoError("The video could not be decoded.");
  validateVideoFrames(frames.stdout, source);
  return source;
}
