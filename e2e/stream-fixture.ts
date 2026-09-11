import { z } from "zod";

// Synthetic provider state shared through the local test bucket. No video bytes
// or real Stream credentials leave the browser fixture.
export const E2E_STREAM_ACCOUNT = "a".repeat(32);
export const E2E_STREAM_NAMESPACE = "mytuums-e2e";
export const E2E_STREAM_TOKEN = "synthetic-stream-token";
export const E2E_STREAM_ORIGIN = "https://e2e-upload.cloudflarestream.com";

export const streamFixtureUpload = z
  .object({
    creator: z.string(),
    byteSize: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .refine((upload) => upload.offset <= upload.byteSize);
export type E2eStreamUpload = z.infer<typeof streamFixtureUpload>;

export function streamFixtureKey(uid: string): string {
  if (!/^[a-f0-9]{32}$/.test(uid)) throw new Error("Invalid synthetic Stream ID.");
  return `__e2e_stream/${uid}.json`;
}
