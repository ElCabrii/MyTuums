import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { encodeVideo } from "./transcode.js";

const filename = process.argv[2];
if (!filename) throw new Error("Usage: pnpm --filter @my-tuums/video-worker benchmark <source>");

const started = performance.now();
const result = await encodeVideo(filename, { signal: AbortSignal.timeout(60 * 60 * 1000) });
try {
  const outputBytes = result.assets.reduce((total, asset) => total + asset.byteSize, 0);
  console.log(
    JSON.stringify(
      {
        source: result.source,
        renditions: result.renditions,
        wallSeconds: (performance.now() - started) / 1000,
        encodingCpuSeconds: result.encodingCpuSeconds,
        encoderPeakMemoryBytes: result.encoderPeakMemoryBytes,
        outputBytes,
        temporaryDiskBytes: result.source.byteSize + outputBytes,
        assets: result.assets.length,
        settings: { threads: 2, preset: "veryfast", crf: 22, segmentSeconds: 4 },
        measurementNote:
          "Encoder CPU/RSS are FFmpeg-reported; probe CPU and combined process RSS require external measurement. No queue wait is included.",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(result.directory, { recursive: true, force: true });
}
