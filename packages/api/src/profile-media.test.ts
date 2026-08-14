import { describe, expect, it, vi } from "vitest";
import type { Database } from "@my-tuums/db";
import { removeProfileMedia, replaceProfileMedia, requireStorage } from "./profile-media.js";
import type { Storage } from "./storage.js";

/**
 * The lifecycle is tested through the same seam production callers cross:
 * the injected `Storage` adapter and a `Database`-shaped handle. The fake
 * bucket below records every write and delete; the fake database is a plain
 * in-memory `user` table whose `transaction` runs its callback to
 * completion — except in the tests that override it, which is how the
 * rollback and the missing-user contract are exercised.
 *
 * Both fakes are shaped like the real interfaces (storage: `put`/`remove`,
 * db: `transaction` returning the callback's value), so the assertions are
 * about observable state — what the bucket holds and what the row holds —
 * never about private helper calls.
 */

interface StoredImage {
  contentType: string;
  bytes: Uint8Array;
}

const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);
const PNG_TYPE = "image/png";

function fakeBucket() {
  const objects = new Map<string, StoredImage>();
  const deletes: string[] = [];
  const storage: Storage = {
    put(key, body, contentType) {
      objects.set(key, { contentType, bytes: body });
      return Promise.resolve();
    },
    remove(key) {
      objects.delete(key);
      deletes.push(key);
      return Promise.resolve();
    },
    signedGetUrl: () => Promise.resolve(`https://storage.test.invalid/${"x"}`),
  };
  return { objects, deletes, storage };
}

type ImageRow = {
  image: string | null;
  bannerImage: string | null;
  imageOriginal: string | null;
  bannerImageOriginal: string | null;
};

/**
 * The query-builder chain the lifecycle needs, over one in-memory row.
 *
 * `select(...).from(user).where(eq(id, ...)).for("update").limit(1)` resolves
 * to the row (or an empty array), and `update(...).set(...).where(...)`
 * applies the new values. Only the two columns of the slot actually change —
 * the other slot is asserted to be untouched by the tests.
 *
 * The lifecycle's only `where` condition is `eq(user.id, userId)`, and
 * Drizzle serialises that as a query whose bound value sits in a `Param`
 * chunk — which is what `whereValue` extracts.
 */
function whereValue(condition: { queryChunks?: unknown[] }): string {
  const param = condition.queryChunks?.find(
    (c): c is { value: string } =>
      typeof c === "object" && c !== null && "value" in c && "encoder" in c,
  );
  if (!param) throw new Error("fake db: expected an eq condition with a bound string");
  return param.value;
}

function makeHandle(rows: Map<string, ImageRow>) {
  return {
    select() {
      return {
        from() {
          return {
            where(condition: { queryChunks?: unknown[] }) {
              return {
                for() {
                  return {
                    limit: () => {
                      const found = rows.get(whereValue(condition));
                      if (!found) return [];
                      // A copy, like the real driver returns: the row the
                      // swap reads must not alias the row the update mutates,
                      // or the "previous" pair would read as the new one.
                      return [{ ...found }];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Partial<ImageRow>) {
          return {
            where(condition: { queryChunks?: unknown[] }) {
              const target = rows.get(whereValue(condition));
              if (target) Object.assign(target, values);
            },
          };
        },
      };
    },
  };
}

/**
 * A `Database`-shaped handle: `transaction` runs the callback to completion
 * and returns its value — the same contract the real driver gives a caller —
 * unless a test replaces it to fail.
 */
function fakeDb(rows: Map<string, ImageRow>): Database {
  const handle = makeHandle(rows);
  return {
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
    // The rest of the surface is never touched by the lifecycle.
  } as unknown as Database;
}
function seedRow(
  rows: Map<string, ImageRow>,
  userId: string,
  values: Partial<ImageRow> = {},
): void {
  rows.set(userId, {
    image: null,
    bannerImage: null,
    imageOriginal: null,
    bannerImageOriginal: null,
    ...values,
  });
}

const row = (rows: Map<string, ImageRow>, userId: string) => rows.get(userId)!;

const USER = "user-1";

/** A stored pair whose keys match the shape `isSafeObjectKey` accepts. */
const OLD_DISPLAY = "/media/avatars/user-1/11111111-1111-4111-8111-111111111111.webp";
const OLD_ORIGINAL = "/media/avatars/user-1/11111111-1111-4111-8111-111111111111.orig.jpg";
const OLD_DISPLAY_KEY = OLD_DISPLAY.replace("/media/", "");
const OLD_ORIGINAL_KEY = OLD_ORIGINAL.replace("/media/", "");

function seedOldPair(rows: Map<string, ImageRow>, objects: Map<string, StoredImage>): void {
  seedRow(rows, USER, { image: OLD_DISPLAY, imageOriginal: OLD_ORIGINAL });
  objects.set(OLD_DISPLAY_KEY, { contentType: "image/webp", bytes: PNG_BYTES });
  objects.set(OLD_ORIGINAL_KEY, { contentType: "image/jpeg", bytes: PNG_BYTES });
}

describe("replaceProfileMedia", () => {
  it("stores both objects and points the slot's columns at them, then returns the pair", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER);

    const result = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    // The two objects share one uuid and differ only in the `.orig` infix —
    // the pairing the reaper relies on.
    expect(result.url).toMatch(/^\/media\/avatars\/user-1\/[a-f0-9-]{36}\.png$/);
    expect(result.originalUrl).toBe(result.url.replace(/\.png$/, ".orig.png"));

    const stored = row(rows, USER);
    expect(stored.image).toBe(result.url);
    expect(stored.imageOriginal).toBe(result.originalUrl);
    expect(stored.bannerImage).toBeNull();

    expect(objects.get(result.url.replace("/media/", ""))).toEqual({
      contentType: "image/png",
      bytes: PNG_BYTES,
    });
    expect(objects.get(result.originalUrl.replace("/media/", ""))).toEqual({
      contentType: "image/png",
      bytes: PNG_BYTES,
    });
  });

  it("writes to the banner slot and leaves the avatar alone", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER);

    const result = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "banner",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    expect(result.url).toMatch(/^\/media\/banners\//);
    expect(row(rows, USER).bannerImage).toBe(result.url);
    expect(row(rows, USER).image).toBeNull();
    expect([...objects.keys()].every((key) => key.startsWith("banners/"))).toBe(true);
  });

  it("deletes the superseded pair after the swap, and never the new one", async () => {
    const { objects, deletes, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedOldPair(rows, objects);

    const result = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    expect(deletes).toEqual([OLD_DISPLAY_KEY, OLD_ORIGINAL_KEY]);
    expect(objects.has(OLD_DISPLAY_KEY)).toBe(false);
    expect(objects.has(OLD_ORIGINAL_KEY)).toBe(false);
    expect(objects.has(result.url.replace("/media/", ""))).toBe(true);
    expect(objects.has(result.originalUrl.replace("/media/", ""))).toBe(true);
  });

  it("throws from the first failed write before touching the database", async () => {
    const { storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER);
    const original = storage.put.bind(storage);
    storage.put = (key, body, type) => {
      if (key.endsWith(".png")) return Promise.reject(new Error("bucket down"));
      return original(key, body, type);
    };
    const db = fakeDb(rows);
    const tx = vi.spyOn(db, "transaction");

    await expect(
      replaceProfileMedia(db, storage, USER, {
        kind: "avatar",
        displayBytes: PNG_BYTES,
        displayType: PNG_TYPE,
        originalBytes: PNG_BYTES,
        originalType: PNG_TYPE,
      }),
    ).rejects.toThrow("bucket down");

    // Nothing was written to the bucket and the row still points at nothing.
    expect(tx).not.toHaveBeenCalled();
    expect(row(rows, USER).image).toBeNull();
  });

  it("leaks only the first object when the second write fails — the row never moved", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER);
    const original = storage.put.bind(storage);
    storage.put = (key, body, type) => {
      if (key.includes(".orig.")) return Promise.reject(new Error("original write failed"));
      return original(key, body, type);
    };
    const db = fakeDb(rows);
    const tx = vi.spyOn(db, "transaction");

    await expect(
      replaceProfileMedia(db, storage, USER, {
        kind: "avatar",
        displayBytes: PNG_BYTES,
        displayType: PNG_TYPE,
        originalBytes: PNG_BYTES,
        originalType: PNG_TYPE,
      }),
    ).rejects.toThrow("original write failed");

    expect(tx).not.toHaveBeenCalled();
    expect(row(rows, USER).image).toBeNull();
    // The display object was written before the failure: an orphan for the
    // reconciliation module to reap, never a live column value.
    expect(objects.size).toBe(1);
    expect([...objects.keys()][0]).toMatch(/^avatars\/user-1\/[a-f0-9-]{36}\.png$/);
  });

  it("keeps the old pair live when the database transaction aborts", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedOldPair(rows, objects);
    const db = fakeDb(rows);
    db.transaction = () => {
      throw new Error("transaction aborted");
    };

    await expect(
      replaceProfileMedia(db, storage, USER, {
        kind: "avatar",
        displayBytes: PNG_BYTES,
        displayType: PNG_TYPE,
        originalBytes: PNG_BYTES,
        originalType: PNG_TYPE,
      }),
    ).rejects.toThrow("transaction aborted");

    // The row still points at the old pair and the old objects are still
    // there — the profile renders correctly. The new pair is orphaned for
    // reconciliation, exactly like a failed write.
    expect(row(rows, USER).image).toBe(OLD_DISPLAY);
    expect(row(rows, USER).imageOriginal).toBe(OLD_ORIGINAL);
    expect(objects.has(OLD_DISPLAY_KEY)).toBe(true);
    expect(objects.size).toBe(4);
  });

  it("leaves the row pointing at a nonexistent user untouched, and the objects for reconciliation", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();

    const result = await replaceProfileMedia(fakeDb(rows), storage, "no-such-user", {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    // Nothing could be swapped — the swap is a no-op on a missing row — so
    // the freshly stored objects are orphans for the reconciliation module.
    expect(result.url).toMatch(/^\/media\/avatars\/no-such-user\//);
    expect(objects.size).toBe(2);
  });

  it("does not delete a provider's absolute avatar URL — it is not ours", async () => {
    const { objects, deletes, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER, {
      image: "https://lh3.googleusercontent.com/a/abc",
      imageOriginal: null,
    });

    const result = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    expect(deletes).toEqual([]);
    expect(objects.has(result.url.replace("/media/", ""))).toBe(true);
  });
});

describe("removeProfileMedia", () => {
  it("clears the slot and deletes both objects behind it", async () => {
    const { objects, deletes, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedOldPair(rows, objects);

    const result = await removeProfileMedia(fakeDb(rows), storage, USER, "avatar");

    expect(result).toEqual({ kind: "avatar", url: null });
    expect(row(rows, USER).image).toBeNull();
    expect(row(rows, USER).imageOriginal).toBeNull();
    expect(deletes).toEqual([OLD_DISPLAY_KEY, OLD_ORIGINAL_KEY]);
    expect(objects.size).toBe(0);
  });

  it("is a no-op on a slot that was never set", async () => {
    const { objects, deletes, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER);

    const result = await removeProfileMedia(fakeDb(rows), storage, USER, "banner");

    expect(result).toEqual({ kind: "banner", url: null });
    expect(deletes).toEqual([]);
    expect(objects.size).toBe(0);
    expect(row(rows, USER).bannerImage).toBeNull();
  });

  it("clears a provider URL's columns but never tries to delete the remote object", async () => {
    const { objects, deletes, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER, {
      image: "https://lh3.googleusercontent.com/a/abc",
      imageOriginal: null,
    });

    await removeProfileMedia(fakeDb(rows), storage, USER, "avatar");

    expect(row(rows, USER).image).toBeNull();
    expect(deletes).toEqual([]);
    expect(objects.size).toBe(0);
  });
});

describe("cleanup failures and guarantees", () => {
  it("reports success when deleting the superseded pair fails — the profile is already correct", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedOldPair(rows, objects);
    const error = new Error("remove failed");
    const removeSpy = vi.spyOn(storage, "remove").mockRejectedValue(error);

    const result = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    // The replace still succeeds, the row is on the new pair, and the stale
    // objects remain for the reconciliation module to reap.
    expect(result.url).toMatch(/^\/media\/avatars\//);
    expect(row(rows, USER).image).toBe(result.url);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(objects.has(OLD_DISPLAY_KEY)).toBe(true);
    expect(objects.has(result.url.replace("/media/", ""))).toBe(true);
  });

  it("never deletes the newly committed pair, even when cleanup is retried by a second request", async () => {
    const { objects, storage } = fakeBucket();
    const rows = new Map<string, ImageRow>();
    seedRow(rows, USER);

    const first = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });
    const second = await replaceProfileMedia(fakeDb(rows), storage, USER, {
      kind: "avatar",
      displayBytes: PNG_BYTES,
      displayType: PNG_TYPE,
      originalBytes: PNG_BYTES,
      originalType: PNG_TYPE,
    });

    // The first request's pair was superseded and removed by the second; the
    // second request's pair is current and must not have been touched.
    expect(objects.has(first.url.replace("/media/", ""))).toBe(false);
    expect(objects.has(first.originalUrl.replace("/media/", ""))).toBe(false);
    expect(objects.has(second.url.replace("/media/", ""))).toBe(true);
    expect(objects.has(second.originalUrl.replace("/media/", ""))).toBe(true);
    expect(row(rows, USER).image).toBe(second.url);
    expect(row(rows, USER).imageOriginal).toBe(second.originalUrl);
  });
});

describe("requireStorage", () => {
  it("returns the storage when one is configured", () => {
    const { storage } = fakeBucket();
    expect(requireStorage({ storage })).toBe(storage);
  });

  it("reports NOT_IMPLEMENTED, not a 500, when no bucket is configured", () => {
    expect(() => requireStorage({ storage: null })).toThrow(/aren't configured/);
  });
});
