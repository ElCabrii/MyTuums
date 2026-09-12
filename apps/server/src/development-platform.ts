import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Miniflare, Response as LocalResponse, type MiniflareWorkerConfig } from "miniflare";
import { createDatabase } from "@my-tuums/db";
import { runMigrations } from "@my-tuums/db/migrate";
import { createLinkFetchTransport } from "../../../packages/api/src/link-card-node.js";
import { createLinkFetchHandler, linkFetchRequestSchema } from "../../link-fetcher/src/handler.js";

/** One owner for local app/jobs storage; no cloud config, secrets or test-suite state is loaded. */
export async function createDevelopmentPlatform(directory: string, port = 3001) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = join(directory, "bundle");
  await build({
    config: false,
    entry: {
      app: fileURLToPath(new URL("../worker/development.ts", import.meta.url)),
      jobs: fileURLToPath(new URL("../../jobs/src/index.ts", import.meta.url)),
    },
    platform: "neutral",
    target: "es2022",
    format: ["esm"],
    bundle: true,
    splitting: false,
    noExternal: [/^(?!cloudflare:|node:)/],
    external: [/^node:/, /^cloudflare:/],
    esbuildOptions(options) {
      options.conditions = ["workerd", "worker", "browser"];
    },
    outDir: output,
    silent: true,
  });
  const database = { type: "d1", id: "mytuums_development_test" } as const;
  const media = { type: "r2", name: "mytuums-development_test", jurisdiction: "eu" } as const;
  const workflows = {
    VIDEO_WORKFLOW: {
      type: "workflow",
      name: "development-video",
      worker: "development-jobs",
      exportName: "VideoWorkflow",
    },
    MAINTENANCE_WORKFLOW: {
      type: "workflow",
      name: "development-maintenance",
      worker: "development-jobs",
      exportName: "MaintenanceWorkflow",
    },
    GAME_SYNC_WORKFLOW: {
      type: "workflow",
      name: "development-game-sync",
      worker: "development-jobs",
      exportName: "GameSyncWorkflow",
    },
  } as const;
  async function config(name: string, module: string): Promise<MiniflareWorkerConfig> {
    return {
      name,
      type: "worker",
      compatibilityDate: "2026-09-12",
      compatibilityFlags: ["nodejs_compat"],
      manifest: {
        mainModule: `${module}.js`,
        modules: {
          [`${module}.js`]: {
            type: "esm",
            contents: await readFile(join(output, `${module}.js`), "utf8"),
          },
        },
      },
    };
  }
  const linkFetch = createLinkFetchHandler(createLinkFetchTransport());
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port,
    resourcePersistencePath: join(directory, "resources"),
    isolatedResourcePersistencePath: join(directory, "runtime"),
    workers: [
      {
        config: {
          ...(await config("development-app", "app")),
          exports: {
            RateLimitCounter: { type: "durable-object", storage: "sqlite" },
            AuthRateLimitCounter: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            DB: database,
            MEDIA: media,
            IMAGES: { type: "images", dev: { remote: false } },
            API_COUNTERS: {
              type: "durable-object",
              worker: "development-app",
              exportName: "RateLimitCounter",
            },
            AUTH_COUNTERS: {
              type: "durable-object",
              worker: "development-app",
              exportName: "AuthRateLimitCounter",
            },
            ...workflows,
            LINK_FETCHER: {
              type: "fetcher",
              async handler(request) {
                try {
                  const input = linkFetchRequestSchema.parse({
                    path: new URL(request.url).pathname,
                    input: await request.json(),
                  });
                  const response = await linkFetch(input);
                  return new LocalResponse(await response.arrayBuffer(), {
                    status: response.status,
                    headers: Object.fromEntries(response.headers),
                  });
                } catch {
                  return new LocalResponse(null, { status: 502 });
                }
              },
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: () => new LocalResponse(null, { status: 502 }),
          },
        },
      },
      {
        config: {
          ...(await config("development-jobs", "jobs")),
          env: {
            DB: database,
            MEDIA: media,
            ...workflows,
            EMAIL: { type: "worker", worker: "development-app", exportName: "DevelopmentEmail" },
            STREAM: { type: "stream", dev: { remote: false } },
            CLOUDFLARE_ACCOUNT_ID: { type: "json", value: "00000000000000000000000000000000" },
            STREAM_NAMESPACE: { type: "json", value: "mytuums-development" },
            STREAM_API_TOKEN: { type: "json", value: "local-development-no-provider-access" },
            APPEAL_TOKEN_SECRET: {
              type: "json",
              value: "mytuums-local-development-only-not-a-hosted-secret",
            },
            EMAIL_FROM: { type: "json", value: "noreply@mytuums.test" },
            WEB_ORIGIN: { type: "json", value: "http://localhost:5173" },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: () => new LocalResponse(null, { status: 502 }),
          },
        },
      },
    ],
  });
  try {
    await runtime.ready;
    const db = createDatabase(await runtime.getD1Database("DB", "development-app"));
    await runMigrations(
      db,
      fileURLToPath(new URL("../../../packages/db/drizzle-d1", import.meta.url)),
    );
    return { runtime, db, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
