import { describe, expect, it } from "vitest";
import { parseVideoProbe, validateVideoFrames } from "./probe.js";
import { videoRenditions } from "./transcode.js";

const video = {
  index: 0,
  codec_type: "video",
  codec_name: "h264",
  width: 1920,
  height: 1080,
  avg_frame_rate: "60000/1001",
  r_frame_rate: "60000/1001",
  sample_aspect_ratio: "1:1",
};
function probe(
  stream: typeof video & { side_data_list?: { rotation: number }[]; time_base?: string } = video,
  duration = "300",
) {
  return JSON.stringify({
    streams: [stream],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration },
  });
}

describe("issue #368 video input policy", () => {
  it("interprets rotation before planning portrait renditions and preserves high frame rates", () => {
    const source = parseVideoProbe(
      probe({ ...video, side_data_list: [{ rotation: -90 }] }),
      500_000_000,
      "mov",
    );
    expect(source).toMatchObject({ width: 1080, height: 1920 });
    expect(videoRenditions(source)).toMatchObject([
      { width: 360, height: 640, frameRate: 30 },
      { width: 720, height: 1280, frameRate: 60000 / 1001 },
      { width: 1080, height: 1920, frameRate: 60000 / 1001 },
    ]);
  });

  it.each([
    ["duration", probe(video, "300.01"), 100, "5 minutes"],
    ["bytes", probe(), 500_000_001, "500 MB"],
    ["4K", probe({ ...video, width: 3840, height: 2160 }), 100, "dimensions"],
    ["oversized square", probe({ ...video, width: 1920, height: 1920 }), 100, "dimensions"],
    ["frame rate", probe({ ...video, avg_frame_rate: "120/1" }), 100, "60 fps"],
    ["unsupported codec", probe({ ...video, codec_name: "ffv1" }), 100, "codec"],
    ["display aspect", probe({ ...video, sample_aspect_ratio: "2:1" }), 100, "dimensions"],
  ])("rejects over-limit or unsupported %s before encoding", (_name, json, bytes, message) => {
    expect(() => parseVideoProbe(json, bytes, "mov")).toThrow(message);
  });

  it("keeps sub-360p videos at native size and never produces an upscaled rendition", () => {
    const source = parseVideoProbe(probe({ ...video, width: 320, height: 240 }), 100, "mov");
    expect(videoRenditions(source)).toMatchObject([{ width: 320, height: 240 }]);
  });

  it("rejects a fast decoded burst hidden by a normal advertised frame rate", () => {
    const source = parseVideoProbe(probe(), 100, "mov");
    const frames = Array.from({ length: 120 }, (_, index) => index / 120).map((time) => ({
      best_effort_timestamp_time: String(time),
      width: 1920,
      height: 1080,
    }));
    expect(() => validateVideoFrames(JSON.stringify({ frames }), source)).toThrow("60 fps");
  });

  it.each([
    ["screencast final frame", [16.716667, 16.75, 16.783333, 16.797]],
    ["mid-recording jitter", [0, 0.033333, 0.047, 0.083333, 0.12]],
    ["variable-rate footage", Array.from({ length: 180 }, (_, i) => i / 60 + (i % 2) * 0.003)],
  ])("accepts isolated timing irregularities: %s", (_name, times) => {
    const source = parseVideoProbe(probe({ ...video, time_base: "1/3000" }), 100, "mov");
    const frames = times.map((time) => ({
      best_effort_timestamp_time: String(time),
      width: 1920,
      height: 1080,
    }));
    expect(() => validateVideoFrames(JSON.stringify({ frames }), source)).not.toThrow();
  });

  it("rejects duplicate decoded timestamps even below the rolling rate limit", () => {
    const source = parseVideoProbe(probe(), 100, "mov");
    const frames = [0, 0.033333, 0.033333].map((time) => ({
      best_effort_timestamp_time: String(time),
      width: 1920,
      height: 1080,
    }));
    expect(() => validateVideoFrames(JSON.stringify({ frames }), source)).toThrow();
  });

  it("keeps a rolling window after quiet footage and reports a safe rate failure code", () => {
    const source = parseVideoProbe(probe(), 100, "mov");
    const times = [0, 1, 2, ...Array.from({ length: 120 }, (_, i) => 3 + i / 120)];
    const frames = times.map((time) => ({
      best_effort_timestamp_time: String(time),
      width: 1920,
      height: 1080,
    }));
    expect(() => validateVideoFrames(JSON.stringify({ frames }), source)).toThrow(
      expect.objectContaining({ code: "frame_rate_exceeded" }),
    );
  });

  it("allows the millisecond timestamp quantization of a 60 fps WebM", () => {
    const source = parseVideoProbe(probe({ ...video, time_base: "1/1000" }), 100, "mov");
    const frames = [0, 0.017, 0.033, 0.05].map((time) => ({
      best_effort_timestamp_time: String(time),
      width: 1920,
      height: 1080,
    }));
    expect(() => validateVideoFrames(JSON.stringify({ frames }), source)).not.toThrow();
  });
});
