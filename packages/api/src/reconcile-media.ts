/**
 * The reconcile-media core: list the media bucket, read the `user` rows,
 * delete the objects no row references.
 *
 * Lives in `src/` rather than inside `scripts/reconcile-media.mjs` so the
 * ordering below is unit-tested (`src/reconcile-media.test.ts`) — the script
 * is the thin guarded wrapper that arms this against the bucket named on the
 * command line.
 *
 * LIST BEFORE READING THE ROWS, and delete only after both snapshots exist —
 * the order is load-bearing (issue #52). The delete set is `listed \
 * referenced`, so a concurrent upload survives exactly when the listing ran
 * first:
 *
 * - listed first: an object uploaded after the listing is not in `keys`, so
 *   it cannot be a deletion candidate; one uploaded before the listing but
 *   after the row read IS in `keys` AND in `referenced` (the row read sees
 *   the committed row), so it is kept either way.
 * - rows first: an object uploaded between the row read and the listing is
 *   in `keys`, missing from `referenced` — a perfect orphan — and is deleted
 *   while the row that points at it is live. Broken avatar, no error
 *   anywhere.
 *
 * The window is not theoretical: `listByPrefix` pages at 1000 keys with a
 * round trip per page, and the row scan is a full table read. The listing
 * must also cover every prefix BEFORE the read: a per-prefix list-then-delete
 * loop with one upfront read still leaves the window open for every prefix
 * after the first.
 */
import type { DestructiveStorage } from "./storage.js";
import { objectKeyFromMediaPath } from "./image.js";

/** The four image slots the reconcile script scans. */
export interface MediaImageRow {
  image: string | null;
  bannerImage: string | null;
  imageOriginal: string | null;
  bannerImageOriginal: string | null;
}

export interface ReconcileMediaDeps {
  storage: Pick<DestructiveStorage, "listByPrefix" | "removeMany">;
  readUserRows: () => Promise<MediaImageRow[]>;
}

export interface ReconcileMediaResult {
  rows: number;
  referenced: number;
  listed: number;
  deleted: number;
}

const PREFIXES = ["avatars/", "banners/"] as const;

export async function reconcileMedia({
  storage,
  readUserRows,
}: ReconcileMediaDeps): Promise<ReconcileMediaResult> {
  // Step 1: every object currently in the bucket. Anything not listed here
  // is not a deletion candidate, no matter what the rows say a moment later.
  const listedByPrefix = new Map<string, string[]>();
  let listed = 0;
  for (const prefix of PREFIXES) {
    const keys = await storage.listByPrefix(prefix);
    listedByPrefix.set(prefix, keys);
    listed += keys.length;
  }

  // Step 2: the rows. Read after the listing so the snapshot postdates it:
  // an upload that lands between the two steps is in `referenced` and kept
  // (see the header comment — this order is what issue #52 was about).
  const rows = await readUserRows();

  const referenced = new Set<string>();
  for (const row of rows) {
    for (const value of [row.image, row.bannerImage, row.imageOriginal, row.bannerImageOriginal]) {
      const key = objectKeyFromMediaPath(value);
      if (key) referenced.add(key);
    }
  }

  console.log(`scanning ${rows.length} user rows; ${referenced.size} referenced objects`);

  // Step 3: delete `listed \ referenced`.
  let deleted = 0;
  for (const prefix of PREFIXES) {
    const keys = listedByPrefix.get(prefix)!;
    const orphans = keys.filter((key) => !referenced.has(key));
    if (orphans.length > 0) {
      deleted += await storage.removeMany(orphans);
      console.log(`${prefix}: deleted ${orphans.length} of ${keys.length} objects`);
    } else if (keys.length > 0) {
      console.log(`${prefix}: all ${keys.length} objects referenced, nothing to do`);
    }
  }

  return { rows: rows.length, referenced: referenced.size, listed, deleted };
}
