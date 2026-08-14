import { closeDb } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { replaceProfileMedia, removeProfileMedia } from "./profile-media.js";
import {
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
 * The lifecycle is tested through the same seam production callers cross —
 * a real Postgres `Database` and the harness's in-memory bucket. Assertions
 * are about observable state: the `user` row and what the bucket holds.
 * No private helper is called, and no drizzle internals are parsed.
 *
 * The write-failure and rollback tests use a real transaction so the
 * database's snapshot-and-discard behaviour is exercised, not simulated:
 * `transaction` really runs the lifecycle's queries and really discards
 * them on throw.
 */

const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);

function replaceInput(kind: "avatar" | "banner") {
  return {
    kind,
    displayBytes: PNG_BYTES,
    displayType: "image/png" as const,
    originalBytes: PNG_BYTES,
    originalType: "image/png" as const,
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

/** Seats the row with a stored pair whose keys `isSafeObjectKey` accepts. */
async function seedStoredPair(
  person: TestUser,
  kind: "avatar" | "banner",
): Promise<{ display: string; original: string }> {
  const display = `/media/${kind}s/${person.id}/11111111-1111-4111-8111-111111111111.webp`;
  const original = `/media/${kind}s/${person.id}/11111111-1111-4111-8111-111111111111.orig.jpg`;
  await person.context.db
    .update(user)
    .set(
      kind === "avatar"
        ? { image: display, imageOriginal: original }
        : { bannerImage: display, bannerImageOriginal: original },
    )
    .where(eq(user.id, person.id));
  await testStorage.put(display.replace("/media/", ""), PNG_BYTES, "image/webp");
  await testStorage.put(original.replace("/media/", ""), PNG_BYTES, "image/jpeg");
  return { display, original };
}

describe("replaceProfileMedia", () => {
  it("stores both objects and points the slot's columns at them, then returns the pair", async () => {
    const alice = await createTestUser();

    const result = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("avatar"),
      displayBytes: PNG_BYTES,
    });

    expect(result.url).toMatch(/^\/media\/avatars\/[^/]+\/[a-f0-9-]{36}\.png$/);
    expect(result.originalUrl).toBe(result.url.replace(/\.png$/, ".orig.png"));

    const stored = await storedImage(alice);
    expect(stored.image).toBe(result.url);
    expect(stored.imageOriginal).toBe(result.originalUrl);
    expect(stored.bannerImage).toBeNull();
    expect(testStorageObjects.has(result.url.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(result.originalUrl.replace("/media/", ""))).toBe(true);
  });

  it("writes to the banner slot and leaves the avatar alone", async () => {
    const alice = await createTestUser();
    await replaceProfileMedia(alice.context.db, testStorage, alice.id, replaceInput("avatar"));

    const banner = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("banner"),
    });

    expect(banner.url).toMatch(/^\/media\/banners\//);
    const stored = await storedImage(alice);
    expect(stored.bannerImage).toBe(banner.url);
    expect(stored.image).toMatch(/^\/media\/avatars\//);
  });

  it("deletes the superseded pair after the swap, and never the new one", async () => {
    const alice = await createTestUser();
    const old = await seedStoredPair(alice, "avatar");

    const result = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("avatar"),
    });

    expect(testStorageObjects.has(old.display.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(old.original.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(result.url.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(result.originalUrl.replace("/media/", ""))).toBe(true);
  });

  it("leaves the profile untouched when the first object write fails", async () => {
    const alice = await createTestUser();
    const old = await seedStoredPair(alice, "avatar");
    const put = vi.spyOn(testStorage, "put").mockRejectedValueOnce(new Error("bucket down"));

    await expect(
      replaceProfileMedia(alice.context.db, testStorage, alice.id, {
        ...replaceInput("avatar"),
      }),
    ).rejects.toThrow("bucket down");

    put.mockRestore();
    const stored = await storedImage(alice);
    expect(stored.image).toBe(old.display);
    expect(stored.imageOriginal).toBe(old.original);
    expect(testStorageObjects.has(old.display.replace("/media/", ""))).toBe(true);
    // No fresh object was ever written.
    expect(
      [...testStorageObjects.keys()].filter((key) => key.startsWith(`avatars/${alice.id}/`)).length,
    ).toBe(2);
  });

  it("leaks only the display object when the original write fails — the row never moved", async () => {
    const alice = await createTestUser();
    const old = await seedStoredPair(alice, "avatar");
    const realPut = testStorage.put.bind(testStorage);
    const put = vi.spyOn(testStorage, "put").mockImplementation((key, bytes, type) => {
      if (key.includes(".orig.")) return Promise.reject(new Error("original write failed"));
      return realPut(key, bytes, type);
    });

    await expect(
      replaceProfileMedia(alice.context.db, testStorage, alice.id, {
        ...replaceInput("avatar"),
      }),
    ).rejects.toThrow("original write failed");

    put.mockRestore();
    const stored = await storedImage(alice);
    expect(stored.image).toBe(old.display);
    expect(stored.imageOriginal).toBe(old.original);
    // Only the display object of the new pair was written before the failure
    // — an orphan for the reconciliation module to reap, never a column value.
    const newKeys = [...testStorageObjects.keys()].filter(
      (key) =>
        key !== old.display.replace("/media/", "") && key !== old.original.replace("/media/", ""),
    );
    expect(newKeys.length).toBe(1);
    expect(newKeys[0]).toMatch(/^avatars\/[^/]+\/[a-f0-9-]{36}\.png$/);
  });

  it("discards the swap when the enclosing transaction rolls back", async () => {
    const alice = await createTestUser();
    const old = await seedStoredPair(alice, "avatar");

    let freshKeys: string[] = [];
    await expect(
      alice.context.db.transaction(async (tx) => {
        const result = await replaceProfileMedia(tx, testStorage, alice.id, {
          ...replaceInput("avatar"),
        });
        freshKeys = [result.url.replace("/media/", ""), result.originalUrl.replace("/media/", "")];
        // Abort the transaction AFTER the lifecycle's own (nested) swap
        // committed: Postgres discards the swap with the abort, so the row
        // must keep pointing at the old pair — a real rollback of real row
        // mutations, not a simulated one.
        throw new Error("outer failure");
      }),
    ).rejects.toThrow("outer failure");

    const stored = await storedImage(alice);
    // The swap was discarded with the aborted transaction — the row never
    // moved off the old pair.
    expect(stored.image).toBe(old.display);
    expect(stored.imageOriginal).toBe(old.original);
    // The fresh pair is orphaned for reconciliation, exactly like a failed
    // write.
    expect(testStorageObjects.has(freshKeys[0])).toBe(true);
    expect(testStorageObjects.has(freshKeys[1])).toBe(true);
    // The superseded pair was already discarded by the lifecycle's cleanup,
    // which ran after its own swap committed but before this caller's
    // transaction aborted. That window is the caller's to own: production
    // procedures pass the bare `db` handle, so the lifecycle's transaction
    // is always the outermost one — the documented "profile renders the old
    // pair" guarantee holds exactly there.
    expect(testStorageObjects.has(old.display.replace("/media/", ""))).toBe(false);
  });

  it("does not delete a provider's absolute avatar URL — it is not ours", async () => {
    const alice = await createTestUser();
    await alice.context.db
      .update(user)
      .set({ image: "https://lh3.googleusercontent.com/a/abc", imageOriginal: null })
      .where(eq(user.id, alice.id));

    const result = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("avatar"),
    });

    expect(testStorageObjects.has(result.url.replace("/media/", ""))).toBe(true);
    // No object was ever deleted for the provider URL.
    const fresh = [...testStorageObjects.keys()].filter((key) =>
      key.startsWith(`avatars/${alice.id}/`),
    );
    expect(fresh.length).toBe(2);
  });
});

describe("removeProfileMedia", () => {
  it("clears the slot and deletes both objects behind it", async () => {
    const alice = await createTestUser();
    const old = await seedStoredPair(alice, "avatar");

    const result = await removeProfileMedia(alice.context.db, testStorage, alice.id, "avatar");

    expect(result).toEqual({ kind: "avatar", url: null });
    const stored = await storedImage(alice);
    expect(stored.image).toBeNull();
    expect(stored.imageOriginal).toBeNull();
    expect(testStorageObjects.has(old.display.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(old.original.replace("/media/", ""))).toBe(false);
  });

  it("is a no-op on a slot that was never set", async () => {
    const alice = await createTestUser();

    const result = await removeProfileMedia(alice.context.db, testStorage, alice.id, "banner");

    expect(result).toEqual({ kind: "banner", url: null });
    expect(testStorageObjects.size).toBe(0);
  });

  it("clears a provider URL's columns but never tries to delete the remote object", async () => {
    const alice = await createTestUser();
    await alice.context.db
      .update(user)
      .set({ image: "https://lh3.googleusercontent.com/a/abc", imageOriginal: null })
      .where(eq(user.id, alice.id));

    await removeProfileMedia(alice.context.db, testStorage, alice.id, "avatar");

    const stored = await storedImage(alice);
    expect(stored.image).toBeNull();
    expect(testStorageObjects.size).toBe(0);
  });
});

describe("cleanup failures and guarantees", () => {
  it("reports success when deleting the superseded pair fails — the profile is already correct", async () => {
    const alice = await createTestUser();
    const old = await seedStoredPair(alice, "avatar");
    const remove = vi.spyOn(testStorage, "remove").mockRejectedValue(new Error("remove failed"));

    const result = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("avatar"),
    });

    remove.mockRestore();
    // The replace still succeeds, the row is on the new pair, and the stale
    // objects remain for the reconciliation module to reap.
    expect(result.url).toMatch(/^\/media\/avatars\//);
    expect((await storedImage(alice)).image).toBe(result.url);
    expect(testStorageObjects.has(old.display.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(result.url.replace("/media/", ""))).toBe(true);
  });

  it("never deletes the newly committed pair, even when cleanup is retried by a second request", async () => {
    const alice = await createTestUser();

    const first = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("avatar"),
    });
    const second = await replaceProfileMedia(alice.context.db, testStorage, alice.id, {
      ...replaceInput("avatar"),
    });

    // The first request's pair was superseded and removed by the second; the
    // second request's pair is current and must not have been touched.
    expect(testStorageObjects.has(first.url.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(first.originalUrl.replace("/media/", ""))).toBe(false);
    expect(testStorageObjects.has(second.url.replace("/media/", ""))).toBe(true);
    expect(testStorageObjects.has(second.originalUrl.replace("/media/", ""))).toBe(true);
    const stored = await storedImage(alice);
    expect(stored.image).toBe(second.url);
    expect(stored.imageOriginal).toBe(second.originalUrl);
  });
});
