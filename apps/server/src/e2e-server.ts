import { z } from "zod";
import { VIDEO_MAX_BYTES } from "@my-tuums/api/constants";
import {
  E2E_STREAM_ACCOUNT,
  E2E_STREAM_NAMESPACE,
  E2E_STREAM_TOKEN,
  E2E_STREAM_ORIGIN,
  streamFixtureKey,
  type E2eStreamUpload,
} from "../../../e2e/stream-fixture.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Response as LocalResponse } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { runMigrations } from "@my-tuums/db/migrate";
import {
  createE2eRuntime,
  testPlatform,
  closeTestPlatform,
} from "../../../e2e/support/platform.js";
import {
  E2E_ACCESS_AUDIENCE,
  E2E_ACCESS_ISSUER,
  E2E_BUCKET_NAME,
  E2E_DATABASE_ID,
} from "../../../e2e/constants.js";

const output = fileURLToPath(new URL("../.wrangler/e2e-bundle", import.meta.url));
await build({
  config: false,
  entry: {
    index: fileURLToPath(new URL("../worker/tests/e2e-entry.ts", import.meta.url)),
    jobs: fileURLToPath(new URL("../../jobs/src/index.ts", import.meta.url)),
    stream: fileURLToPath(new URL("../worker/tests/e2e-stream.ts", import.meta.url)),
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
const key = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(key.publicKey)), kid: "e2e-synthetic", alg: "RS256", use: "sig" };
const token = await new SignJWT({
  iss: E2E_ACCESS_ISSUER,
  aud: [E2E_ACCESS_AUDIENCE],
  exp: Math.floor(Date.now() / 1000) + 24 * 3600,
})
  .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
  .sign(key.privateKey);

const platform = await testPlatform();
let application: Awaited<ReturnType<typeof createE2eRuntime>> | undefined;
try {
  await runMigrations(
    platform.db,
    fileURLToPath(new URL("../../../packages/db/drizzle-d1", import.meta.url)),
  );
  application = await createE2eRuntime(
    [
      {
        config: {
          name: "e2e-application",
          type: "worker",
          compatibilityDate: "2026-09-11",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: await readFile(`${output}/index.js`, "utf8") },
            },
          },
          exports: { RateLimitCounter: { type: "durable-object", storage: "sqlite" } },
          env: {
            DB: { type: "d1", id: E2E_DATABASE_ID },
            MEDIA: { type: "r2", name: E2E_BUCKET_NAME, jurisdiction: "eu" },
            IMAGES: { type: "images", dev: { remote: false } },
            API_COUNTERS: {
              type: "durable-object",
              worker: "e2e-application",
              exportName: "RateLimitCounter",
            },
            STREAM: { type: "worker", worker: "e2e-stream" },
            VIDEO_WORKFLOW: {
              type: "workflow",
              name: "e2e-video",
              worker: "e2e-jobs",
              exportName: "VideoWorkflow",
            },
            ACCESS_TOKEN: { type: "json", value: token },
            ASSETS: { type: "assets" },
          },
          assets: {
            directory: fileURLToPath(new URL("../../web/dist", import.meta.url)),
            hasUserWorker: true,
            runWorkerFirst: true,
            htmlHandling: "none",
            notFoundHandling: "none",
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            async handler(request) {
              if (request.url === `${E2E_ACCESS_ISSUER}/cdn-cgi/access/certs`)
                return LocalResponse.json({ keys: [jwk] });
              if (
                request.method !== "POST" ||
                request.url !==
                  `https://api.cloudflare.com/client/v4/accounts/${E2E_STREAM_ACCOUNT}/stream?direct_user=true`
              )
                return new LocalResponse(null, { status: 502 });
              const creator = request.headers.get("Upload-Creator") ?? "";
              const id = z.uuid().safeParse(creator.slice(`${E2E_STREAM_NAMESPACE}:`.length));
              const byteSize = Number(request.headers.get("Upload-Length"));
              if (
                !creator.startsWith(`${E2E_STREAM_NAMESPACE}:`) ||
                !id.success ||
                !Number.isSafeInteger(byteSize) ||
                byteSize <= 0 ||
                byteSize > VIDEO_MAX_BYTES ||
                request.headers.get("Authorization") !== `Bearer ${E2E_STREAM_TOKEN}` ||
                request.headers.get("Tus-Resumable") !== "1.0.0" ||
                !request.headers.get("Upload-Metadata")?.split(",").includes("requiresignedurls")
              )
                return new LocalResponse(null, { status: 400 });
              const uid = id.data.replaceAll("-", "");
              const upload: E2eStreamUpload = { creator, byteSize, offset: 0 };
              await platform.bucket.put(streamFixtureKey(uid), JSON.stringify(upload));
              return new LocalResponse(null, {
                status: 201,
                headers: {
                  "stream-media-id": uid,
                  Location: `${E2E_STREAM_ORIGIN}/${uid}`,
                },
              });
            },
          },
        },
      },
      {
        config: {
          name: "e2e-stream",
          type: "worker",
          compatibilityDate: "2026-09-11",
          manifest: {
            mainModule: "stream.js",
            modules: {
              "stream.js": { type: "esm", contents: await readFile(`${output}/stream.js`, "utf8") },
            },
          },
          env: { MEDIA: { type: "r2", name: E2E_BUCKET_NAME, jurisdiction: "eu" } },
        },
      },
      {
        config: {
          name: "e2e-jobs",
          type: "worker",
          compatibilityDate: "2026-09-11",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "jobs.js",
            modules: {
              "jobs.js": { type: "esm", contents: await readFile(`${output}/jobs.js`, "utf8") },
            },
          },
          env: {
            DB: { type: "d1", id: E2E_DATABASE_ID },
            MEDIA: { type: "r2", name: E2E_BUCKET_NAME, jurisdiction: "eu" },
            STREAM: { type: "worker", worker: "e2e-stream" },
            CLOUDFLARE_ACCOUNT_ID: { type: "json", value: E2E_STREAM_ACCOUNT },
            STREAM_NAMESPACE: { type: "json", value: E2E_STREAM_NAMESPACE },
            STREAM_API_TOKEN: { type: "json", value: E2E_STREAM_TOKEN },
            VIDEO_WORKFLOW: {
              type: "workflow",
              name: "e2e-video",
              worker: "e2e-jobs",
              exportName: "VideoWorkflow",
            },
          },
        },
        dev: {
          outboundService: {
            type: "fetcher",
            handler: () => Promise.resolve(new LocalResponse(null, { status: 502 })),
          },
        },
      },
    ],
    3101,
  );
  console.log("Native E2E Worker listening on loopback port 3101.");
} catch (error) {
  await application?.dispose();
  await closeTestPlatform();
  throw error;
}

let closing: Promise<void> | undefined;
function close() {
  closing ??= (async () => {
    try {
      await application?.dispose();
    } finally {
      await closeTestPlatform();
    }
  })();
  return closing;
}
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
