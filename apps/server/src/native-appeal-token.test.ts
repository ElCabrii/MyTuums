import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("signs and verifies legacy-compatible appeal tokens in workerd without Node compatibility", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-appeal-test-"));
  let runtime: Miniflare | undefined;
  try {
    await build({
      config: false,
      entry: {
        index: fileURLToPath(new URL("../worker/tests/appeal-token-entry.ts", import.meta.url)),
      },
      platform: "neutral",
      target: "es2022",
      format: ["esm"],
      bundle: true,
      noExternal: [/.*/],
      outDir: path,
      silent: true,
    });
    runtime = new Miniflare({
      workers: [
        {
          config: {
            type: "worker",
            name: "appeal-test",
            compatibilityDate: "2026-09-11",
            manifest: {
              mainModule: "index.js",
              modules: {
                "index.js": {
                  type: "esm",
                  contents: await readFile(join(path, "index.js"), "utf8"),
                },
              },
            },
          },
        },
      ],
    });
    const worker = await runtime.getWorker("appeal-test");
    const token = await (await worker.fetch("https://appeal.test/")).text();
    const body = token.slice(0, token.lastIndexOf("."));
    const signature = createHmac("sha256", "native-appeal-test-secret-at-least-32-chars")
      .update(body)
      .digest("base64url");
    expect(token).toBe(`${body}.${signature}`);
    const verify = async (raw: string) =>
      (await worker.fetch("https://appeal.test/", { method: "POST", body: raw })).json();
    expect(await verify(token)).toMatchObject({
      userId: "auteur-é🎮",
      nonce: "synthetic-nonce",
      purpose: "appeal",
    });
    expect(await verify(`${body}.` + "a".repeat(43))).toBeNull();
    expect(await verify("a".repeat(4097))).toBeNull();
    const expiredBody = Buffer.from(
      JSON.stringify({
        purpose: "appeal",
        actionId: "11111111-1111-4111-8111-111111111111",
        userId: "author",
        nonce: "old",
        iat: 1,
      }),
    ).toString("base64url");
    const expiredSignature = createHmac("sha256", "native-appeal-test-secret-at-least-32-chars")
      .update(expiredBody)
      .digest("base64url");
    expect(await verify(`${expiredBody}.${expiredSignature}`)).toBeNull();
  } finally {
    await runtime?.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);
