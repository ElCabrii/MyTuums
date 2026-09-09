import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMediaProcess } from "./process.js";
import { encodeVideo } from "./transcode.js";
import { probeVideo } from "./probe.js";

let directory: string;
const signal = AbortSignal.timeout(120_000);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mytuums-video-test-"));
  await runMediaProcess(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      "-preset",
      "ultrafast",
      "-c:a",
      "aac",
      "-y",
      "source.mp4",
    ],
    { cwd: directory, signal },
  );
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("issue #368 native video processing", () => {
  it.each([0.5, 50.1])(
    "generates every advertised preview for a %s-second clip (issue #368)",
    async (duration) => {
      const filename = `preview-${duration}.mp4`;
      await runMediaProcess(
        "ffmpeg",
        [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=30",
          "-t",
          String(duration),
          "-c:v",
          "libx264",
          "-threads",
          "2",
          "-preset",
          "ultrafast",
          filename,
        ],
        { cwd: directory, signal },
      );
      const result = await encodeVideo(join(directory, filename), {
        signal,
        temporaryDirectory: directory,
      });
      const previews = await readFile(join(result.directory, "previews.vtt"), "utf8");
      const references = [...previews.matchAll(/(preview_\d+\.jpg)#xywh=/g)];
      expect(references).toHaveLength(Math.ceil(duration / 2));
      const names = result.assets.map((asset) => asset.name);
      for (const reference of references) expect(names).toContain(reference[1]);
    },
  );

  it("produces complete decodable HLS, a cover, and two-second preview cues", async () => {
    const result = await encodeVideo(join(directory, "source.mp4"), {
      signal,
      temporaryDirectory: directory,
    });
    const names = result.assets.map((asset) => asset.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "master.m3u8",
        "360.m3u8",
        "360_init.mp4",
        "360_0000.m4s",
        "360_0001.m4s",
        "cover.jpg",
        "previews.vtt",
        "preview_001.jpg",
      ]),
    );
    expect(names).not.toContain("source.mp4");
    const playlist = await readFile(join(result.directory, "360.m3u8"), "utf8");
    expect(playlist).toContain("#EXTINF:4.000000");
    expect(playlist).toContain("#EXT-X-ENDLIST");
    const previews = await readFile(join(result.directory, "previews.vtt"), "utf8");
    expect(previews.match(/ --> /g)).toHaveLength(3);
    expect(previews).toContain("00:00:02.000 --> 00:00:04.000");
    const decoded = await runMediaProcess(
      "ffmpeg",
      ["-v", "error", "-xerror", "-i", "master.m3u8", "-f", "null", "-"],
      { cwd: result.directory, signal },
    );
    expect(decoded.stderr).toBe("");
    expect(result.encodingCpuSeconds).toBeGreaterThan(0);
    expect(result.encoderPeakMemoryBytes).toBeGreaterThan(0);
  });

  it("reads actual rotation metadata", async () => {
    await runMediaProcess(
      "ffmpeg",
      ["-v", "error", "-display_rotation", "90", "-i", "source.mp4", "-c", "copy", "rotated.mov"],
      { cwd: directory, signal },
    );
    const source = await probeVideo(join(directory, "rotated.mov"), signal);
    expect(source).toMatchObject({ width: 360, height: 640 });
  });

  it("rejects a spoofed type and reclaims partial processing directories", async () => {
    await writeFile(join(directory, "fake.mp4"), "<html>not video</html>");
    const before = await readdir(directory);
    await expect(
      encodeVideo(join(directory, "fake.mp4"), { signal, temporaryDirectory: directory }),
    ).rejects.toThrow("MP4, MOV, or WebM");
    expect(await readdir(directory)).toEqual(before);
  });

  it("cancels an active native process and removes its output directory", async () => {
    const before = await readdir(directory);
    const controller = new AbortController();
    const encoding = encodeVideo(join(directory, "source.mp4"), {
      signal: controller.signal,
      temporaryDirectory: directory,
    });
    const cancel = setTimeout(() => controller.abort(), 50);
    try {
      await expect(encoding).rejects.toThrow();
    } finally {
      clearTimeout(cancel);
    }
    expect(await readdir(directory)).toEqual(before);
  });
});
