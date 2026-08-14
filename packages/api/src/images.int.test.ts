import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { MAX_IMAGE_MEGAPIXELS } from "./constants.js";
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

/**
 * A real PNG header — signature AND a 256x128 IHDR — followed by padding.
 * `acceptImage` reads dimensions now, so a positive fixture needs a parseable
 * header, not just a magic number.
 */
const PNG_BODY = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x01,
  0x00, // width: 256
  0x00,
  0x00,
  0x00,
  0x80, // height: 128
]);

/** A PNG header declaring arbitrary dimensions, for the bound tests. */
function pngWithDimensions(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(PNG_BODY);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

/** A file whose bytes really are a PNG, which is what the server sniffs for. */
function pngFile(name = "avatar.png"): File {
  const bytes = new Uint8Array(PNG_BODY.length + 64);
  bytes.set(PNG_BODY);
  return new File([bytes], name, { type: "image/png" });
}

/** The two-object input every upload procedure call needs. */
function uploadInput(
  kind: "avatar" | "banner",
  overrides: Partial<{ original: File; display: File }> = {},
) {
  return {
    kind,
    original: pngFile("original.png"),
    display: pngFile(),
    ...overrides,
  };
}

async function storedImage(person: TestUser): Promise<{
  image: string | null;
  bannerImage: string | null;
  imageOriginal: string | null;
  bannerImageOriginal: string | null;
}> {
  const [row] = await person.context.db
    .select({
      image: user.image,
      bannerImage: user.bannerImage,
      imageOriginal: user.imageOriginal,
      bannerImageOriginal: user.bannerImageOriginal,
    })
    .from(user)
    .where(eq(user.id, person.id))
    .limit(1);
  return row ?? { image: null, bannerImage: null, imageOriginal: null, bannerImageOriginal: null };
}

describe("user.uploadImage", () => {
  it("stores both objects and points both columns at their /media paths", async () => {
    const alice = await createTestUser();

    const result = await call(appRouter.user.uploadImage, uploadInput("avatar"), {
      context: contextFor(alice),
    });

    expect(result.url).toMatch(/^\/media\/avatars\/[^/]+\/[a-f0-9-]{36}\.png$/);
    // The original shares the display object's uuid, differing only in the
    // `.orig` infix — the pairing a future editor and reaper rely on.
    expect(result.originalUrl).toBe(result.url.replace(/\.png$/, ".orig.png"));

    const stored = await storedImage(alice);
    expect(stored.image).toBe(result.url);
    expect(stored.imageOriginal).toBe(result.originalUrl);

    // The bytes actually reached storage, under the keys the row now names.
    expect(testStorageObjects.get(result.url.replace("/media/", ""))?.contentType).toBe(
      "image/png",
    );
    expect(testStorageObjects.get(result.originalUrl.replace("/media/", ""))?.contentType).toBe(
      "image/png",
    );
  });

  it("writes the banner to its own columns, leaving the avatar alone", async () => {
    const alice = await createTestUser();
    await call(appRouter.user.uploadImage, uploadInput("avatar"), { context: contextFor(alice) });
    const banner = await call(appRouter.user.uploadImage, uploadInput("banner"), {
      context: contextFor(alice),
    });

    const stored = await storedImage(alice);
    expect(stored.bannerImage).toBe(banner.url);
    expect(stored.bannerImageOriginal).toBe(banner.originalUrl);
    expect(stored.image).toMatch(/^\/media\/avatars\//);
    expect(banner.url).toMatch(/^\/media\/banners\//);
  });

  it("deletes the objects it replaced, so uploads do not accumulate forever", async () => {
    const alice = await createTestUser();
    const first = await call(appRouter.user.uploadImage, uploadInput("avatar"), {
      context: contextFor(alice),
    });
    const second = await call(appRouter.user.uploadImage, uploadInput("avatar"), {
      context: contextFor(alice),
    });

    for (const key of [first.url, first.originalUrl ?? ""].map((p) => p.replace("/media/", ""))) {
      expect(testStorageObjects.has(key)).toBe(false);
    }
    expect(testStorageObjects.has(second.url.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(second.originalUrl.replace("/media/", ""))).toBe(true);
  });

  it("keys the objects by the SESSION's user, not by anything the caller supplies", async () => {
    // The keys embed an owner id, but the session is what decides whose row is
    // written — a filename or a path in the upload can't redirect it.
    const alice = await createTestUser();
    const result = await call(
      appRouter.user.uploadImage,
      uploadInput("avatar", { display: pngFile("../../bob/evil.png") }),
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
      call(appRouter.user.uploadImage, uploadInput("avatar", { display: svg }), {
        context: contextFor(alice),
      }),
    ).rejects.toThrow(/doesn't look like an image/);

    expect(testStorageObjects.size).toBe(0);
    const stored = await storedImage(alice);
    expect(stored.image).toBeNull();
    expect(stored.imageOriginal).toBeNull();
  });

  it("rejects a type outside the allowlist, SVG included", async () => {
    const alice = await createTestUser();
    const svg = new File([new TextEncoder().encode("<svg/>")], "x.svg", {
      type: "image/svg+xml",
    });

    await expect(
      call(appRouter.user.uploadImage, uploadInput("avatar", { display: svg }), {
        context: contextFor(alice),
      }),
    ).rejects.toThrow(/format isn't supported/);
  });

  // The three size-class rules — the per-slot byte cap, the display pixel
  // bounds and the megapixel ceiling — all live in `acceptImage` and are
  // covered there, including the discriminating cases this layer cannot see
  // (avatar's cap rejecting what banner's accepts; the same bytes passing as an
  // original but not as a display). What the procedure adds is only that a
  // `size` verdict becomes `/too large/` and writes nothing, and it has exactly
  // two call sites — so one display case and one original case is the whole of
  // it. A third would re-assert the same `IMAGE_REJECTIONS.size` lookup at the
  // cost of another Postgres round trip.
  it("rejects a display object beyond the slot's pixel bounds", async () => {
    // The display object is what lands in every feed; a hostile client naming
    // a 600px-wide image "the avatar's display object" must be refused.
    const alice = await createTestUser();
    const wide = new File([pngWithDimensions(600, 300)], "wide.png", { type: "image/png" });

    await expect(
      call(appRouter.user.uploadImage, uploadInput("avatar", { display: wide }), {
        context: contextFor(alice),
      }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects an original beyond the megapixel ceiling, even with tiny bytes", async () => {
    // ~400 MP in 24 bytes: the byte cap never sees it; the megapixel rule does.
    const alice = await createTestUser();
    const bomb = new File([pngWithDimensions(20_000, 20_000)], "bomb.png", { type: "image/png" });
    expect(MAX_IMAGE_MEGAPIXELS * 1_000_000).toBeLessThan(20_000 * 20_000);

    await expect(
      call(appRouter.user.uploadImage, uploadInput("avatar", { original: bomb }), {
        context: contextFor(alice),
      }),
    ).rejects.toThrow(/too large/);
    expect(testStorageObjects.size).toBe(0);
  });

  it("refuses an anonymous caller", async () => {
    const { anonContext } = await import("./testing/harness.js");
    await expect(
      call(appRouter.user.uploadImage, uploadInput("avatar"), { context: anonContext }),
    ).rejects.toThrow();
  });

  it("reports NOT_IMPLEMENTED, not a 500, when no bucket is configured", async () => {
    const alice = await createTestUser();
    await expect(
      call(
        appRouter.user.uploadImage,
        uploadInput("avatar"),
        // The supported "no S3_* group" configuration — see context.ts.
        { context: contextFor(alice, undefined, null) },
      ),
    ).rejects.toThrow(/aren't configured/);
  });
});

describe("user.removeImage", () => {
  it("clears both columns and deletes both objects", async () => {
    const alice = await createTestUser();
    const uploaded = await call(appRouter.user.uploadImage, uploadInput("avatar"), {
      context: contextFor(alice),
    });

    const result = await call(
      appRouter.user.removeImage,
      { kind: "avatar" },
      { context: contextFor(alice) },
    );

    expect(result.url).toBeNull();
    const stored = await storedImage(alice);
    expect(stored.image).toBeNull();
    expect(stored.imageOriginal).toBeNull();
    expect(testStorageObjects.has(uploaded.url.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(uploaded.originalUrl.replace("/media/", ""))).toBe(false);
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

    const stored = await storedImage(alice);
    expect(stored.image).toBeNull();
    expect(stored.imageOriginal).toBeNull();
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

describe("concurrent replacements", () => {
  it("serialize on the row lock: the loser's cleanup never deletes the winner's committed pair", async () => {
    const alice = await createTestUser();

    // Two uploads race the same slot. The row lock in the swap makes the
    // read-then-write one step, so the loser's swap observes the winner's
    // committed pair and deletes THAT — never the pair the winner just
    // committed. Without the lock, both could read the same old keys, both
    // delete them, and leave the winner's row pointing at objects that were
    // removed (the exact race `swapImageColumns`'s `FOR UPDATE` in
    // `src/profile-media.ts` exists for).
    const [first, second] = await Promise.all([
      call(appRouter.user.uploadImage, uploadInput("avatar"), { context: contextFor(alice) }),
      call(appRouter.user.uploadImage, uploadInput("avatar"), { context: contextFor(alice) }),
    ]);

    const stored = await storedImage(alice);
    const winner = stored.image === first.url ? first : second;
    const loser = winner === first ? second : first;

    // The row points at exactly one of the two pairs, and that pair is the
    // only one left in the bucket.
    expect(stored.image).toBe(winner.url);
    expect(stored.imageOriginal).toBe(winner.originalUrl);
    expect(testStorageObjects.has(winner.url.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(winner.originalUrl.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(loser.url.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(loser.originalUrl.replace("/media/", ""))).toBe(false);
  });
});
