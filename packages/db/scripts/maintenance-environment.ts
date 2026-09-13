import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy, unstable_readConfig } from "wrangler";
import { z } from "zod";
import { createDatabase } from "../src/index.js";

export const MAINTENANCE_ENVIRONMENTS = ["local", "preview", "production"] as const;
export type MaintenanceEnvironment = (typeof MAINTENANCE_ENVIRONMENTS)[number];

const localConfigPath = fileURLToPath(
  new URL("../../../apps/server/wrangler.jsonc", import.meta.url),
);
const previewConfigPath = fileURLToPath(
  new URL("../../../apps/server/wrangler.preview.jsonc", import.meta.url),
);
const productionConfigPath = fileURLToPath(
  new URL("../../../apps/server/wrangler.production.jsonc", import.meta.url),
);
const localStatePath = fileURLToPath(
  new URL("../../../apps/server/.wrangler/maintenance", import.meta.url),
);

const targets = {
  local: {
    app: "mytuums-build-app",
    database: "mytuums-local",
    id: "00000000-0000-0000-0000-000000000001",
    bucket: "mytuums-local-media",
    config: localConfigPath,
  },
  preview: {
    app: "mytuums-preview-app",
    database: "mytuums-preview",
    id: "c8ce4268-2a4c-4175-b574-93c1c45aac92",
    bucket: "mytuums-preview-media",
    config: previewConfigPath,
  },
  production: {
    app: "mytuums-production-app",
    database: "mytuums-production",
    id: "e80d3f42-4fe5-41fb-90b7-32de79d25e0b",
    bucket: "mytuums-production-media",
    config: productionConfigPath,
  },
} as const;

export function resolveMaintenanceEnvironment(
  environment: string | undefined,
  remote: boolean,
): MaintenanceEnvironment {
  const selected = z.enum(MAINTENANCE_ENVIRONMENTS).parse(environment ?? "local");
  if (selected === "local" && remote)
    throw new Error("Local maintenance cannot use remote Cloudflare bindings.");
  if (selected !== "local" && !remote)
    throw new Error("Preview and production maintenance require --remote.");
  return selected;
}

export function maintenanceResourceNames(environment: MaintenanceEnvironment) {
  const target = targets[environment];
  return { database: target.database, bucket: target.bucket };
}

function configuration(environment: MaintenanceEnvironment) {
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

/** Open only the selected D1/R2 pair; never inherit application secrets or provider bindings. */
async function openBindings(
  environment: MaintenanceEnvironment,
  remote: boolean,
  includeMedia: boolean,
) {
  const target = targets[environment];
  const app = configuration(environment).parse(unstable_readConfig({ config: target.config }));
  const directory = await mkdtemp(join(tmpdir(), "mytuums-maintenance-"));
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

export async function openMaintenanceDatabase(
  environment: MaintenanceEnvironment,
  remote: boolean,
) {
  const { db, dispose } = await openBindings(environment, remote, false);
  return { db, dispose };
}

/** Media maintenance always uses the selected environment's matching D1/EU-R2 pair. */
export async function openMaintenanceMedia(environment: MaintenanceEnvironment, remote: boolean) {
  const resources = await openBindings(environment, remote, true);
  if (!resources.bucket) {
    await resources.dispose();
    throw new Error("The selected media binding is unavailable.");
  }
  return { db: resources.db, bucket: resources.bucket, dispose: resources.dispose };
}
