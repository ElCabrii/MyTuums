import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { Miniflare } from "miniflare";
import sharp from "sharp";
import { expect, it } from "vitest";

it("serves authorized R2 images and derives bounded variants in the Worker runtime", async () => {
  const path = await mkdtemp(join(tmpdir(), "mytuums-media-test-"));
  let runtime: Miniflare | undefined;
  try {
    await build({
      config: false,
      entry: { index: fileURLToPath(new URL("../worker/tests/media-entry.ts", import.meta.url)) },
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
            name: "media-test",
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
            env: {
              MEDIA: { type: "r2", name: "media-test", jurisdiction: "eu" },
              IMAGES: { type: "images", dev: { remote: false } },
            },
          },
        },
      ],
    });
    const bucket = await runtime.getR2Bucket("MEDIA", "media-test");
    const worker = await runtime.getWorker("media-test");
    const key = "avatars/owner/11111111-1111-4111-8111-111111111111.png";
    const variant = `${key}.w96.webp`;
    const bytes = await sharp({
      create: { width: 192, height: 96, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: "image/png", cacheControl: "public, max-age=31536000" },
    });
    const headers = { "x-authorized-key": key };
    expect((await worker.fetch(`https://media.test/${key}`)).status).toBe(404);
    expect((await worker.fetch(`https://media.test/${variant}`)).status).toBe(404);
    expect(await bucket.head(variant)).toBeNull();
    const source = await worker.fetch(`https://media.test/${key}`, { headers });
    expect(source.status).toBe(200);
    expect(source.headers.get("cache-control")).toBe("private, no-store");
    expect(source.headers.get("location")).toBeNull();
    expect(source.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await source.arrayBuffer())).toEqual(bytes);

    const derived = await worker.fetch(`https://media.test/${variant}`, { headers });
    expect(derived.status).toBe(200);
    expect(derived.headers.get("content-type")).toBe("image/webp");
    const metadata = await sharp(Buffer.from(await derived.arrayBuffer())).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 96, height: 48 });
    expect(await bucket.head(variant)).not.toBeNull();
    const larger = await worker.fetch(`https://media.test/${key}.w256.webp`, { headers });
    expect(await sharp(Buffer.from(await larger.arrayBuffer())).metadata()).toMatchObject({
      width: 192,
      height: 96,
    });

    // The persisted image remains private and authorization is revisited after I/O.
    expect(
      (
        await worker.fetch(`https://media.test/${variant}`, {
          headers: { ...headers, "x-revoke": "1" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(`https://media.test/${variant}`, {
          headers: { ...headers, "x-viewer": "other" },
        })
      ).status,
    ).toBe(404);
    const cached = await worker.fetch(`https://media.test/${variant}`, {
      headers: { ...headers, "x-fail-images": "1" },
    });
    expect(cached.headers.get("content-type")).toBe("image/webp");
    await cached.arrayBuffer();
    const head = await worker.fetch(`https://media.test/${variant}`, { method: "HEAD", headers });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await head.text()).toBe("");

    // Unknown widths are refused even if a similarly named object exists.
    const rogue = `${key}.w9999.webp`;
    await bucket.put(rogue, bytes, { httpMetadata: { contentType: "image/webp" } });
    expect(
      (
        await worker.fetch(`https://media.test/${rogue}`, {
          headers: { "x-authorized-key": rogue },
        })
      ).status,
    ).toBe(404);

    await bucket.delete(variant);
    const fallback = await worker.fetch(`https://media.test/${variant}`, {
      headers: { ...headers, "x-fail-images": "1" },
    });
    expect(fallback.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await fallback.arrayBuffer())).toEqual(bytes);
    expect(await bucket.head(variant)).toBeNull();
    expect(
      (
        await worker.fetch(`https://media.test/${variant}`, {
          headers: { ...headers, "x-fail-images": "1", "x-revoke": "1" },
        })
      ).status,
    ).toBe(404);

    const gifKey = key.replace(/png$/, "gif");
    const gif = await sharp(bytes).gif().toBuffer();
    await bucket.put(gifKey, gif, { httpMetadata: { contentType: "image/gif" } });
    const animation = await worker.fetch(`https://media.test/${gifKey}.w96.webp`, {
      headers: { "x-authorized-key": gifKey, "x-fail-images": "1" },
    });
    expect(animation.headers.get("content-type")).toBe("image/gif");
    expect(Buffer.from(await animation.arrayBuffer())).toEqual(gif);
    expect(await bucket.head(`${gifKey}.w96.webp`)).toBeNull();
    await bucket.put(key, "<svg></svg>", { httpMetadata: { contentType: "image/svg+xml" } });
    expect((await worker.fetch(`https://media.test/${key}`, { headers })).status).toBe(404);
  } finally {
    await runtime?.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);
