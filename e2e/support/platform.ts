import { Miniflare, type WorkerOptions } from "miniflare";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@my-tuums/db";
import { E2E_BUCKET_NAME, E2E_DATABASE_ID } from "../constants.js";

const root = fileURLToPath(new URL("../.wrangler/e2e_test", import.meta.url));

export function assertTestPlatform(): void {
  if (
    !E2E_DATABASE_ID.endsWith("_test") ||
    !E2E_BUCKET_NAME.endsWith("_test") ||
    basename(root) !== "e2e_test"
  ) {
    throw new Error("Refusing to use non-test platform resources.");
  }
}

/** Share local storage through its registry owner, not concurrent SQLite file access. */
export async function createE2eRuntime(workers: WorkerOptions[], port = 0) {
  assertTestPlatform();
  await mkdir(join(root, "instances"), { recursive: true });
  const isolated = await mkdtemp(join(root, "instances", "client-"));
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port,
    unsafeEnableSharedStorage: true,
    resourcePersistencePath: join(root, "resources"),
    isolatedResourcePersistencePath: isolated,
    unsafeDevRegistryPath: join(root, "registry"),
    workers,
  });
  async function dispose() {
    try {
      await runtime.dispose();
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  }
  try {
    await runtime.ready;
    return { runtime, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function connect() {
  const local = await createE2eRuntime([
    {
      config: {
        name: "e2e-fixtures",
        type: "worker",
        compatibilityDate: "2026-09-11",
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": {
              type: "esm",
              contents:
                "export default { fetch() { return new Response(null, { status: 404 }); } }",
            },
          },
        },
        env: {
          DB: { type: "d1", id: E2E_DATABASE_ID },
          MEDIA: { type: "r2", name: E2E_BUCKET_NAME, jurisdiction: "eu" },
        },
      },
    },
  ]);
  try {
    const binding = await local.runtime.getD1Database("DB", "e2e-fixtures");
    const bucket = await local.runtime.getR2Bucket("MEDIA", "e2e-fixtures");
    return { db: createDatabase(binding), bucket, dispose: local.dispose };
  } catch (error) {
    await local.dispose();
    throw error;
  }
}

let platform: ReturnType<typeof connect> | undefined;
export function testPlatform() {
  platform ??= connect();
  return platform;
}

/** The setup process and each Playwright worker release their own registry client. */
export async function closeTestPlatform() {
  const current = platform;
  platform = undefined;
  await (await current)?.dispose();
}
