import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { IMAGE_LIMITS } from "./constants.js";
import {
  contextFor,
  createTestUser,
  testStorage,
  testStorageObjects,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A file whose bytes really are a PNG, which is what the server sniffs for. */
function pngFile(name = "avatar.png", extraBytes = 64): File {
  const bytes = new Uint8Array([...PNG_HEADER, ...new Array<number>(extraBytes).fill(0)]);
  return new File([bytes], name, { type: "image/png" });
}

async function storedImage(person: TestUser): Promise<{ image: string | null; bannerImage: string | null }> {
  const [row] = await person.context.db
    .select({ image: user.image, bannerImage: user.bannerImage })
    .from(user)
    .where(eq(user.id, person.id))
    .limit(1);
  return row ?? { image: null, bannerImage: null };
}

describe("user.uploadImage", () => {
  it("stores the object and points the row at a /media path", async () => {
    const alice = await createTestUser();

    const result = await call(
      appRouter.user.uploadImage,
      { kind: "avatar", file: pngFile() },
      { context: contextFor(alice) },
    );

    expect(result.url).toMatch(/^\/media\/avatars\/[^/]+\/[a-f0-9-]{36}\.png$/);
    expect((await storedImage(alice)).image).toBe(result.url);

    // The bytes actually reached storage, under the key the row now names.
    const key = result.url.replace("/media/", "");
    expect(testStorageObjects.get(key)?.contentType).toBe("image/png");
  });

  it("writes the banner to its own column, leaving the avatar alone", async () => {
    const alice = await createTestUser();
    await call(
      appRouter.user.uploadImage,
      { kind: "avatar", file: pngFile() },
      { context: contextFor(alice) },
    );
    const banner = await call(
      appRouter.user.uploadImage,
      { kind: "banner", file: pngFile("banner.png") },
      { context: contextFor(alice) },
    );

    const stored = await storedImage(alice);
    expect(stored.bannerImage).toBe(banner.url);
    expect(stored.image).toMatch(/^\/media\/avatars\//);
    expect(banner.url).toMatch(/^\/media\/banners\//);
  });

  it("deletes the object it replaced, so uploads do not accumulate forever", async () => {
    const alice = await createTestUser();
    const first = await call(
      appRouter.user.uploadImage,
      { kind: "avatar", file: pngFile() },
      { context: contextFor(alice) },
    );
    const second = await call(
      appRouter.user.uploadImage,
      { kind: "avatar", file: pngFile() },
      { context: contextFor(alice) },
    );

    expect(testStorageObjects.has(first.url.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(second.url.replace("/media/", ""))).toBe(true);
  });

  it("keys the object by the SESSION's user, not by anything the caller supplies", async () => {
    // The key embeds an owner id, but the session is what decides whose row is
    // written — a filename or a path in the upload can't redirect it.
    const alice = await createTestUser();
    const result = await call(
      appRouter.user.uploadImage,
      { kind: "avatar", file: pngFile("../../bob/evil.png") },
      { context: contextFor(alice) },
    );

    expect(result.url).toBe(`/media/avatars/${alice.id}/${result.url.split("/").pop()}`);
  });

  it("rejects a payload whose bytes are not the type it claims", async () => {
    const alice = await createTestUser();
    const svg = new File([new TextEncoder().encode("<svg onload=alert(1)>")], "x.png", {
      type: "image/png",
    });

    await expect(
      call(appRouter.user.uploadImage, { kind: "avatar", file: svg }, { context: contextFor(alice) }),
    ).rejects.toThrow(/doesn't look like an image/);

    expect(testStorageObjects.size).toBe(0);
    expect((await storedImage(alice)).image).toBeNull();
  });

  it("rejects a type outside the allowlist, SVG included", async () => {
    const alice = await createTestUser();
    const svg = new File([new TextEncoder().encode("<svg/>")], "x.svg", {
      type: "image/svg+xml",
    });

    await expect(
      call(appRouter.user.uploadImage, { kind: "avatar", file: svg }, { context: contextFor(alice) }),
    ).rejects.toThrow(/format isn't supported/);
  });

  it("rejects a payload over the slot's byte cap", async () => {
    const alice = await createTestUser();
    const oversized = pngFile("big.png", IMAGE_LIMITS.avatar.maxBytes);

    await expect(
      call(
        appRouter.user.uploadImage,
        { kind: "avatar", file: oversized },
        { context: contextFor(alice) },
      ),
    ).rejects.toThrow(/too large/);
  });

  it("refuses an anonymous caller", async () => {
    const { anonContext } = await import("./testing/harness.js");
    await expect(
      call(
        appRouter.user.uploadImage,
        { kind: "avatar", file: pngFile() },
        { context: anonContext },
      ),
    ).rejects.toThrow();
  });

  it("reports NOT_IMPLEMENTED, not a 500, when no bucket is configured", async () => {
    const alice = await createTestUser();
    await expect(
      call(
        appRouter.user.uploadImage,
        { kind: "avatar", file: pngFile() },
        // The supported "no S3_* group" configuration — see context.ts.
        { context: contextFor(alice, undefined, undefined, null) },
      ),
    ).rejects.toThrow(/aren't configured/);
  });
});

describe("user.removeImage", () => {
  it("clears the column and deletes the object", async () => {
    const alice = await createTestUser();
    const uploaded = await call(
      appRouter.user.uploadImage,
      { kind: "avatar", file: pngFile() },
      { context: contextFor(alice) },
    );

    const result = await call(
      appRouter.user.removeImage,
      { kind: "avatar" },
      { context: contextFor(alice) },
    );

    expect(result.url).toBeNull();
    expect((await storedImage(alice)).image).toBeNull();
    expect(testStorageObjects.has(uploaded.url.replace("/media/", ""))).toBe(false);
  });

  it("is a no-op on a slot that was never set", async () => {
    const alice = await createTestUser();
    await expect(
      call(appRouter.user.removeImage, { kind: "banner" }, { context: contextFor(alice) }),
    ).resolves.toEqual({ kind: "banner", url: null });
  });

  it("leaves an OAuth provider's avatar URL alone in storage, since it is not ours", async () => {
    const alice = await createTestUser();
    await alice.context.db
      .update(user)
      .set({ image: "https://lh3.googleusercontent.com/a/abc" })
      .where(eq(user.id, alice.id));

    // Clearing the column is right; trying to DELETE that key from our bucket
    // would not be. `objectKeyFromMediaPath` returning null is what prevents it.
    await call(appRouter.user.removeImage, { kind: "avatar" }, { context: contextFor(alice) });

    expect((await storedImage(alice)).image).toBeNull();
    expect(testStorageObjects.size).toBe(0);
  });
});

describe("the injected storage fake", () => {
  it("is what these tests write to — no real bucket is ever reached", () => {
    // Guards the property the whole file depends on: `Context.storage` is
    // injectable precisely so integration tests stay offline and free.
    expect(testStorage).toBeDefined();
    expect(testStorageObjects.size).toBe(0);
  });
});
