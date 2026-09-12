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

const previewConfigPath = fileURLToPath(
  new URL("../../../apps/server/wrangler.preview.jsonc", import.meta.url),
);
const targets = {
  poc: {
    app: "mytuums-poc-app",
    database: POC_DATABASE_NAME,
    id: "f4334c85-cca9-4437-976e-b52038047c62",
    bucket: POC_MEDIA_BUCKET_NAME,
  },
  preview: {
    app: "mytuums-preview-app",
    database: "mytuums-preview",
    id: "c8ce4268-2a4c-4175-b574-93c1c45aac92",
    bucket: "mytuums-preview-media",
  },
} as const;

const appConfigPath = fileURLToPath(
  new URL("../../../apps/server/wrangler.jsonc", import.meta.url),
);
const localStatePath = fileURLToPath(
  new URL("../../../apps/server/.wrangler/state/v3", import.meta.url),
);
function configuration(environment: keyof typeof targets) {
  const target = targets[environment];
  return z.object({
    name: z.literal(target.app),
    account_id: z.literal("734f3b84571b1967e6940140a0b7d75f"),
    compatibility_date: z.string().min(1),
    d1_databases: z.tuple([
      z.object({
        binding: z.literal("DB"),
        database_name: z.literal(target.database),
        database_id: z.literal(target.id),
      }),
    ]),
    r2_buckets: z.tuple([
      z.object({
        binding: z.literal("MEDIA"),
        bucket_name: z.literal(target.bucket),
        jurisdiction: z.literal("eu"),
      }),
    ]),
  });
}

/** Open only requested environment resources; never inherit unrelated application bindings. */
async function openBindings(
  remote: boolean,
  includeMedia: boolean,
  environment: keyof typeof targets,
) {
  const app = configuration(environment).parse(
    unstable_readConfig({ config: environment === "poc" ? appConfigPath : previewConfigPath }),
  );
  // Admin commands load no application secrets, Stream, email or job bindings.
  // Database-only callers do not start R2 or need its remote permissions.
  const directory = await mkdtemp(join(tmpdir(), "mytuums-poc-admin-"));
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(
      configPath,
      JSON.stringify({
        name: `mytuums-${environment}-admin`,
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
      persist: { path: environment === "poc" ? localStatePath : `${localStatePath}-preview` },
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
  const { db, dispose } = await openBindings(remote, false, "poc");
  return { db, dispose };
}

/** Media maintenance always uses the same validated D1/EU-R2 environment pair. */
export async function openPocMedia(remote: boolean) {
  const resources = await openBindings(remote, true, "poc");
  if (!resources.bucket) {
    await resources.dispose();
    throw new Error("The PoC media binding is unavailable.");
  }
  return { db: resources.db, bucket: resources.bucket, dispose: resources.dispose };
}

/** Preview migrations never inherit PoC or production resource identities. */
export async function openPreviewDatabase(remote: boolean) {
  const { db, dispose } = await openBindings(remote, false, "preview");
  return { db, dispose };
}
