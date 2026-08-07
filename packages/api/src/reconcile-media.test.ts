import { describe, expect, it } from "vitest";
import { reconcileMedia, type MediaImageRow } from "./reconcile-media.js";

/** A realistic key: `isSafeObjectKey` requires the slug and grouped-uuid shape. */
const LIVE_KEY = "avatars/alicemedia/11111111-1111-4111-8111-111111111111.webp";
const ORPHAN_KEY = "avatars/bobmedia/22222222-2222-4222-8222-222222222222.webp";
const FRESH_KEY = "avatars/carolmedia/33333333-3333-4333-8333-333333333333.webp";

/**
 * A bucket that exists only in memory, plus the destructive-storage surface
 * the reconcile script uses, with every deletion recorded.
 */
function fakeBucket(initial: string[]) {
  const bucket = new Set(initial);
  const deleted: string[] = [];
  return {
    bucket,
    deleted,
    storage: {
      listByPrefix: (prefix: string) =>
        Promise.resolve([...bucket].filter((key) => key.startsWith(prefix))),
      removeMany: (keys: string[]) => {
        deleted.push(...keys);
        for (const key of keys) bucket.delete(key);
        return Promise.resolve(keys.length);
      },
    },
  };
}

const liveRow: MediaImageRow = {
  image: `/media/${LIVE_KEY}`,
  bannerImage: null,
  imageOriginal: null,
  bannerImageOriginal: null,
};

describe("reconcileMedia", () => {
  it("deletes only the keys no user row references", async () => {
    const { bucket, deleted, storage } = fakeBucket([LIVE_KEY, ORPHAN_KEY]);

    const result = await reconcileMedia({
      storage,
      readUserRows: () => Promise.resolve([liveRow]),
    });

    expect(deleted).toEqual([ORPHAN_KEY]);
    expect(bucket.has(LIVE_KEY)).toBe(true);
    expect(bucket.has(ORPHAN_KEY)).toBe(false);
    expect(result).toEqual({ rows: 1, referenced: 1, listed: 2, deleted: 1 });
  });

  it("keeps an object uploaded between the listing and the row read (issue #52)", async () => {
    const { bucket, deleted, storage } = fakeBucket([LIVE_KEY, ORPHAN_KEY]);

    // The concurrent upload commits exactly when the script lists the
    // bucket: the fresh avatar lands in the bucket AND the row that points
    // at it lands in the user table. With the fixed order (list, then read)
    // the row read sees the committed row, so the fresh object is
    // referenced and survives. With the buggy order (read, then list) the
    // read's snapshot predates the upload, so the fresh object is in the
    // listing, missing from `referenced` — a perfect orphan, deleted while
    // the row still points at it.
    const rows = [liveRow];
    const freshRow: MediaImageRow = { ...liveRow, image: `/media/${FRESH_KEY}` };
    let uploaded = false;
    const storageWithConcurrentUpload = {
      ...storage,
      listByPrefix: (prefix: string) => {
        if (!uploaded) {
          uploaded = true;
          bucket.add(FRESH_KEY);
          rows.push(freshRow);
        }
        return Promise.resolve([...bucket].filter((key) => key.startsWith(prefix)));
      },
    };

    await reconcileMedia({
      storage: storageWithConcurrentUpload,
      readUserRows: () => Promise.resolve([...rows]),
    });

    expect(deleted).toEqual([ORPHAN_KEY]);
    expect(bucket.has(FRESH_KEY)).toBe(true);
    expect(bucket.has(LIVE_KEY)).toBe(true);
  });
});
