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
    // The requested variant's bytes are already in the edge cache, so an
    // authorized request keeps receiving them after R2 no longer holds the
    // object. In production a deletion removes the database authorization
    // first; the revoked request below proves that gate still holds for
    // cached bytes.
    const cachedVariant = await worker.fetch(`https://media.test/${variant}`, {
      headers: { ...headers, "x-fail-images": "1" },
    });
    expect(cachedVariant.headers.get("content-type")).toBe("image/webp");
    expect(await bucket.head(variant)).toBeNull();
    expect(
      (
        await worker.fetch(`https://media.test/${variant}`, {
          headers: { ...headers, "x-fail-images": "1", "x-revoke": "1" },
        })
      ).status,
    ).toBe(404);

    // A variant never requested before was never cached, so its R2 deletion
    // semantics stay provable on a fresh key: generation fails closed and the
    // original is served.
    const freshBase = "avatars/owner/22222222-2222-4222-8222-222222222222.png";
    const freshVariant = `${freshBase}.w96.webp`;
    await bucket.put(freshBase, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    const freshFallback = await worker.fetch(`https://media.test/${freshVariant}`, {
      headers: { "x-authorized-key": freshBase, "x-fail-images": "1" },
    });
    expect(freshFallback.headers.get("content-type")).toBe("image/png");
    expect(await bucket.head(freshVariant)).toBeNull();

    // Issue #405: eligible immutable image bytes are served from the
    // datacenter's edge cache behind the same two authorizations. The proof is
    // deletion — with the R2 object gone, an authorized request still receives
    // byte-identical bytes that can only come from the cache, while a viewer
    // the authorizer refuses never sees them.
    const repeat = await worker.fetch(`https://media.test/${key}`, { headers });
    expect(Buffer.from(await repeat.arrayBuffer())).toEqual(bytes);
    expect(repeat.headers.get("cache-control")).toBe("private, no-store");
    await bucket.delete(key);
    await expect
      .poll(async () => (await worker.fetch(`https://media.test/${key}`, { headers })).status)
      .toBe(200);
    const cachedOnly = await worker.fetch(`https://media.test/${key}`, { headers });
    expect(Buffer.from(await cachedOnly.arrayBuffer())).toEqual(bytes);
    expect(
      (
        await worker.fetch(`https://media.test/${key}`, {
          headers: { ...headers, "x-revoke": "1" },
        })
      ).status,
    ).toBe(404);
    const cachedHead = await worker.fetch(`https://media.test/${key}`, { method: "HEAD", headers });
    expect(cachedHead.status).toBe(200);
    expect(Number(cachedHead.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await cachedHead.text()).toBe("");

    // Profile originals are excluded by design: owner-only source material
    // with little repeat-view value never enters the cache.
    const originalKey = "avatars/owner/33333333-3333-4333-8333-333333333333.orig.png";
    await bucket.put(originalKey, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
    const originalHeaders = { "x-authorized-key": originalKey };
    expect(
      (await worker.fetch(`https://media.test/${originalKey}`, { headers: originalHeaders }))
        .status,
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (await worker.fetch(`https://media.test/${originalKey}`, { headers: originalHeaders }))
            .status,
      )
      .toBe(200);
    await bucket.delete(originalKey);
    expect(
      (await worker.fetch(`https://media.test/${originalKey}`, { headers: originalHeaders }))
        .status,
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
    const voiceKey =
      "messages/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.webm";
    const voiceBytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    await bucket.put(voiceKey, voiceBytes, { httpMetadata: { contentType: "audio/webm" } });
    expect((await worker.fetch(`https://media.test/${voiceKey}`)).status).toBe(404);
    const voiceResponse = await worker.fetch(`https://media.test/${voiceKey}`, {
      headers: { "x-authorized-key": voiceKey },
    });
    expect(voiceResponse.headers.get("content-type")).toBe("audio/webm");
    expect(voiceResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await voiceResponse.arrayBuffer())).toEqual(voiceBytes);
    // MIME refusal on a fresh key: the immutable key this test cached earlier
    // cannot be overwritten in production — replacement mints a new UUID path
    // and removes the old row's authorization first.
    const svgKey = "avatars/owner/44444444-4444-4444-8444-444444444444.png";
    await bucket.put(svgKey, "<svg></svg>", { httpMetadata: { contentType: "image/svg+xml" } });
    expect(
      (
        await worker.fetch(`https://media.test/${svgKey}`, {
          headers: { "x-authorized-key": svgKey },
        })
      ).status,
    ).toBe(404);
  } finally {
    await runtime?.dispose();
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);
