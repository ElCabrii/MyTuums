import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, closeDb } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import { createVideoQueue, VIDEO_PROCESS_QUEUE } from "@my-tuums/api/video-worker";

// Runs inside the production image against a migrated, disposable test DB.
// Storage is an empty local protocol stub; this command never uses a real bucket.
assertTestDatabase();
const storage = createServer((request, response) => {
  const uploads = new URL(request.url ?? "/", "http://localhost").searchParams.has("uploads");
  response.writeHead(200, { "content-type": "application/xml" });
  response.end(
    uploads
      ? '<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>'
      : '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>',
  );
});
await new Promise<void>((resolve) => storage.listen(0, "127.0.0.1", resolve));
const address = z.object({ port: z.number() }).parse(storage.address());
const child = spawn(process.execPath, [new URL("./index.js", import.meta.url).pathname], {
  env: {
    PATH: process.env.PATH,
    DATABASE_URL: process.env.DATABASE_URL,
    S3_ENDPOINT: `http://127.0.0.1:${address.port}`,
    S3_BUCKET: "worker-image-smoke",
    S3_ACCESS_KEY_ID: "smoke",
    S3_SECRET_ACCESS_KEY: "smoke",
    PORT: "3002",
    VIDEO_TEMP_DIRECTORY: "/tmp/mytuums-image-smoke",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk: Buffer) => {
  output = (output + chunk.toString()).slice(-32_768);
});
child.stderr.on("data", () => {
  /* Assertions report closed errors, never provider diagnostics. */
});
const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
const queue = createVideoQueue(db, false);
const deadline = AbortSignal.timeout(60_000);
try {
  while (!output.includes('"event":"video_cleanup"')) {
    if (child.exitCode !== null)
      throw new Error("Worker image exited before maintenance completed.");
    await setTimeout(200, undefined, { signal: deadline });
  }
  const health = await fetch("http://127.0.0.1:3002/health", { signal: deadline });
  if (!health.ok) throw new Error("Worker image did not become healthy.");
  await queue.start();
  const id = await queue.send(VIDEO_PROCESS_QUEUE, { videoId: randomUUID() });
  if (!id) throw new Error("Worker smoke job could not be scheduled.");
  for (;;) {
    const job = await queue.getJobById(VIDEO_PROCESS_QUEUE, id);
    if (job?.state === "completed") break;
    if (job?.state === "failed") throw new Error("Worker image could not acknowledge a delivery.");
    await setTimeout(200, undefined, { signal: deadline });
  }
  console.log(
    "Worker image: native tools, database, maintenance, health and queue delivery passed.",
  );
} finally {
  child.kill("SIGTERM");
  await Promise.race([exited, setTimeout(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await exited;
  await queue.stop();
  await closeDb();
  storage.close();
}
