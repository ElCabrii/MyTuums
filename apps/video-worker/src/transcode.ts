import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  VIDEO_PREVIEW_SECONDS,
  VIDEO_RENDITION_HEIGHTS,
  VIDEO_SEGMENT_SECONDS,
} from "@my-tuums/api/constants";
import { InvalidVideoError, probeVideo, VIDEO_INPUT_OPTIONS, type VideoSource } from "./probe.js";
import { runMediaProcess } from "./process.js";

export interface VideoRendition {
  name: string;
  width: number;
  height: number;
  frameRate: number;
  bandwidth: number;
}

export interface VideoAsset {
  name: string;
  contentType: string;
  byteSize: number;
}

export interface EncodedVideo {
  directory: string;
  source: VideoSource;
  renditions: VideoRendition[];
  assets: VideoAsset[];
  encodingCpuSeconds: number;
  encoderPeakMemoryBytes: number;
}

interface EncodingOptions {
  signal: AbortSignal;
  threads?: number;
  temporaryDirectory?: string;
}

export function videoRenditions(source: VideoSource): VideoRendition[] {
  const shortEdge = Math.min(source.width, source.height);
  const sizes: number[] = VIDEO_RENDITION_HEIGHTS.filter((size) => size <= shortEdge);
  if (sizes.length === 0) sizes.push(Math.floor(shortEdge));
  return sizes.map((size) => {
    const scale = size / shortEdge;
    const width = Math.floor((source.width * scale) / 2) * 2;
    const height = Math.floor((source.height * scale) / 2) * 2;
    if (width < 2 || height < 2) throw new InvalidVideoError("Video is too small to encode.");
    const frameRate = size <= 360 ? Math.min(30, source.frameRate) : source.frameRate;
    const bitrate = size <= 360 ? 1_000_000 : size <= 720 ? 3_500_000 : 6_000_000;
    return {
      name: String(size),
      width,
      height,
      frameRate,
      bandwidth: Math.ceil(bitrate * (frameRate > 30 ? 1.5 : 1)) + 128_000,
    };
  });
}

function colorFilter(source: VideoSource) {
  return source.hdr
    ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
    : "";
}

function timestamp(seconds: number) {
  return new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
}

function assetContentType(name: string): string {
  if (name.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (name.endsWith(".m4s")) return "video/iso.segment";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".vtt")) return "text/vtt; charset=utf-8";
  throw new Error("Unexpected encoder output.");
}

/**
 * Owns a fresh output directory. On success the caller uploads and removes it;
 * on any error (including abort) this function removes every partial output.
 */
export async function encodeVideo(
  filename: string,
  { signal, threads = 2, temporaryDirectory = tmpdir() }: EncodingOptions,
): Promise<EncodedVideo> {
  if (!Number.isInteger(threads) || threads < 1 || threads > 16)
    throw new Error("Encoder threads must be between 1 and 16.");
  const directory = await mkdtemp(join(temporaryDirectory, "mytuums-video-"));
  try {
    const input = resolve(filename);
    const source = await probeVideo(input, signal, threads);
    const renditions = videoRenditions(source);
    const inputArgs = [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-xerror",
      "-benchmark",
      ...VIDEO_INPUT_OPTIONS,
      "-threads",
      String(threads),
      "-filter_threads",
      String(threads),
      "-i",
      input,
    ];
    let encodingCpuSeconds = 0;
    let encoderPeakMemoryBytes = 0;
    const encode = async (args: string[]) => {
      const { stderr } = await runMediaProcess("ffmpeg", [...inputArgs, ...args], {
        cwd: directory,
        signal,
      });
      const cpu = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(stderr);
      const memory = /bench: maxrss=(\d+)KiB/.exec(stderr);
      if (cpu) encodingCpuSeconds += Number(cpu[1]) + Number(cpu[2]);
      if (memory)
        encoderPeakMemoryBytes = Math.max(encoderPeakMemoryBytes, Number(memory[1]) * 1024);
    };

    // Sequential renditions keep a job's working set and encoder thread count
    // bounded. The benchmark records their total CPU cost before concurrency
    // is raised; each independent job can use its own worker slot.
    for (const rendition of renditions) {
      const audio =
        source.audioStream === null
          ? ["-an"]
          : [
              "-map",
              `0:${source.audioStream}`,
              "-c:a",
              "aac",
              "-b:a",
              "128k",
              "-ac",
              "2",
              "-ar",
              "48000",
            ];
      await encode([
        "-map",
        `0:${source.videoStream}`,
        ...audio,
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-sn",
        "-dn",
        "-vf",
        `${colorFilter(source)}scale=${rendition.width}:${rendition.height}:flags=lanczos,setsar=1,fps=${rendition.frameRate}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-threads",
        String(threads),
        "-maxrate",
        String(rendition.bandwidth - 128_000),
        "-bufsize",
        String(2 * (rendition.bandwidth - 128_000)),
        "-g",
        String(Math.ceil(rendition.frameRate * VIDEO_SEGMENT_SECONDS)),
        "-sc_threshold",
        "0",
        "-force_key_frames",
        `expr:gte(t,n_forced*${VIDEO_SEGMENT_SECONDS})`,
        "-f",
        "hls",
        "-hls_time",
        String(VIDEO_SEGMENT_SECONDS),
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "fmp4",
        "-hls_flags",
        "independent_segments",
        "-hls_fmp4_init_filename",
        `${rendition.name}_init.mp4`,
        "-hls_segment_filename",
        `${rendition.name}_%04d.m4s`,
        `${rendition.name}.m3u8`,
      ]);
    }

    const cover = renditions.at(-1)!;
    await encode([
      "-map",
      `0:${source.videoStream}`,
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-vf",
      `${colorFilter(source)}scale=${cover.width}:${cover.height}:flags=lanczos,setsar=1`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-update",
      "1",
      "cover.jpg",
    ]);
    const previewScale = Math.min(1, 160 / source.width, 160 / source.height);
    const previewWidth = Math.max(2, Math.floor((source.width * previewScale) / 2) * 2);
    const previewHeight = Math.max(2, Math.floor((source.height * previewScale) / 2) * 2);
    await encode([
      "-map",
      `0:${source.videoStream}`,
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-vf",
      `${colorFilter(source)}fps=1/${VIDEO_PREVIEW_SECONDS}:start_time=0,scale=${previewWidth}:${previewHeight},setsar=1,tile=5x5`,
      "-q:v",
      "4",
      "preview_%03d.jpg",
    ]);
    const previews = ["WEBVTT", ""];
    for (let index = 0; index * VIDEO_PREVIEW_SECONDS < source.duration; index += 1) {
      const start = index * VIDEO_PREVIEW_SECONDS;
      const image = `preview_${String(Math.floor(index / 25) + 1).padStart(3, "0")}.jpg`;
      const x = (index % 5) * previewWidth;
      const y = Math.floor((index % 25) / 5) * previewHeight;
      previews.push(
        `${timestamp(start)} --> ${timestamp(Math.min(source.duration, start + VIDEO_PREVIEW_SECONDS))}`,
        `${image}#xywh=${x},${y},${previewWidth},${previewHeight}`,
        "",
      );
    }
    await writeFile(join(directory, "previews.vtt"), previews.join("\n"));

    const master = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
    for (const rendition of renditions) {
      const playlist = await readFile(join(directory, `${rendition.name}.m3u8`), "utf8");
      if (!playlist.includes("#EXT-X-ENDLIST") || !playlist.includes("#EXTINF:"))
        throw new Error("Incomplete video rendition.");
      master.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},RESOLUTION=${rendition.width}x${rendition.height},FRAME-RATE=${rendition.frameRate.toFixed(3)}`,
        `${rendition.name}.m3u8`,
      );
    }
    await writeFile(join(directory, "master.m3u8"), master.join("\n") + "\n");
    const names = await readdir(directory);
    const assets = await Promise.all(
      names.sort().map(async (name) => {
        const { size } = await stat(join(directory, name));
        if (size === 0) throw new Error("Empty video asset.");
        return { name, byteSize: size, contentType: assetContentType(name) };
      }),
    );
    return { directory, source, renditions, assets, encodingCpuSeconds, encoderPeakMemoryBytes };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
