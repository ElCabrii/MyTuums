import { z } from "zod";

const workerEnv = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  VIDEO_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  VIDEO_FFMPEG_THREADS: z.coerce.number().int().min(1).max(16).default(2),
  VIDEO_TEMP_DIRECTORY: z.string().default("/tmp/mytuums-video-worker"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
});

const result = workerEnv.safeParse(process.env);
if (!result.success) {
  // Paths identify missing settings; schema errors must not print credentials.
  console.error(
    "Invalid video worker configuration:",
    result.error.issues.map((issue) => issue.path.join(".")).join(", "),
  );
  process.exit(1);
}
export const env = result.data;
