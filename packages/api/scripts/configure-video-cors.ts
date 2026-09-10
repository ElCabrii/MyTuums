import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";

const env = z
  .object({
    S3_ENDPOINT: z.url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_REGION: z.string().optional(),
  })
  .safeParse(process.env);
if (!env.success)
  throw new Error("Configure the complete S3 environment before planning browser access.");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const origins = args
  .filter((argument) => argument !== "--apply")
  .map((argument) => {
    const url = new URL(argument);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Supply exact HTTPS origins (HTTP is allowed for localhost).");
    return url.origin;
  });
if (!origins.length)
  throw new Error(
    "Usage: storage:video-cors <origin> [origin...] [--apply]. Without --apply this only previews the rules.",
  );
const s3 = new S3Client({
  endpoint: env.data.S3_ENDPOINT,
  region: env.data.S3_REGION ?? "auto",
  credentials: {
    accessKeyId: env.data.S3_ACCESS_KEY_ID,
    secretAccessKey: env.data.S3_SECRET_ACCESS_KEY,
  },
});
const input = { Bucket: env.data.S3_BUCKET };
const existing = await s3.send(new GetBucketCorsCommand(input)).catch((error) => {
  if (error instanceof Error && error.name === "NoSuchCORSConfiguration") return { CORSRules: [] };
  throw new Error("Could not read the bucket CORS configuration.");
});
const rule = {
  ID: "mytuums-video-browser",
  AllowedOrigins: [...new Set(origins)],
  AllowedMethods: ["GET", "HEAD", "PUT"],
  AllowedHeaders: ["content-type", "range"],
  ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
  MaxAgeSeconds: 3600,
};
const rules = [...(existing.CORSRules ?? []).filter((entry) => entry.ID !== rule.ID), rule];
console.info(
  JSON.stringify({ action: apply ? "apply" : "plan", preservedRules: rules.length - 1, rule }),
);
if (apply) {
  await s3.send(new PutBucketCorsCommand({ ...input, CORSConfiguration: { CORSRules: rules } }));
  const result = await s3.send(new GetBucketCorsCommand(input));
  const stored = result.CORSRules?.find((entry) => entry.ID === rule.ID);
  if (
    !stored ||
    !rule.AllowedOrigins.every((origin) => stored.AllowedOrigins?.includes(origin)) ||
    !rule.AllowedMethods.every((method) => stored.AllowedMethods?.includes(method))
  )
    throw new Error("Bucket did not confirm the requested browser access rules.");
  console.info("Video browser access rules verified.");
}
