import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy, unstable_readConfig } from "wrangler";
import { z } from "zod";
import { createDatabase } from "../src/index.js";

export const POC_DATABASE_NAME = "mytuums-poc";
export const POC_MEDIA_BUCKET_NAME = "mytuums-poc-media";

const appConfigPath = fileURLToPath(
  new URL("../../../apps/server/wrangler.jsonc", import.meta.url),
);
const localStatePath = fileURLToPath(
  new URL("../../../apps/server/.wrangler/state/v3", import.meta.url),
);
const configuration = z.object({
  name: z.literal("mytuums-poc-app"),
  account_id: z.literal("734f3b84571b1967e6940140a0b7d75f"),
  compatibility_date: z.string().min(1),
  d1_databases: z.tuple([
    z.object({
      binding: z.literal("DB"),
      database_name: z.literal(POC_DATABASE_NAME),
      database_id: z.literal("f4334c85-cca9-4437-976e-b52038047c62"),
    }),
  ]),
  r2_buckets: z.tuple([
    z.object({
      binding: z.literal("MEDIA"),
      bucket_name: z.literal(POC_MEDIA_BUCKET_NAME),
      jurisdiction: z.literal("eu"),
    }),
  ]),
});

/** Open only requested PoC resources; never inherit unrelated application bindings. */
async function openPocBindings(remote: boolean, includeMedia: boolean) {
  const app = configuration.parse(unstable_readConfig({ config: appConfigPath }));
  // Admin commands load no application secrets, Stream, email or job bindings.
  // Database-only callers do not start R2 or need its remote permissions.
  const directory = await mkdtemp(join(tmpdir(), "mytuums-poc-admin-"));
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: "mytuums-poc-admin",
        account_id: app.account_id,
        compatibility_date: app.compatibility_date,
        d1_databases: [{ ...app.d1_databases[0], remote }],
        r2_buckets: includeMedia ? [{ ...app.r2_buckets[0], remote }] : [],
      }),
    );
    const proxy = await getPlatformProxy<{ DB: D1Database; MEDIA?: R2Bucket }>({
      configPath,
      envFiles: [],
      remoteBindings: remote,
      persist: { path: localStatePath },
    });
    return {
      db: createDatabase(proxy.env.DB),
      bucket: proxy.env.MEDIA,
      async dispose(this: void) {
        try {
          await proxy.dispose();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** D1-only administration. Local state is shared with Wrangler dev. */
export async function openPocDatabase(remote: boolean) {
  const { db, dispose } = await openPocBindings(remote, false);
  return { db, dispose };
}

/** Media maintenance always uses the same validated D1/EU-R2 environment pair. */
export async function openPocMedia(remote: boolean) {
  const resources = await openPocBindings(remote, true);
  if (!resources.bucket) {
    await resources.dispose();
    throw new Error("The PoC media binding is unavailable.");
  }
  return { db: resources.db, bucket: resources.bucket, dispose: resources.dispose };
}
