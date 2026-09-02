/**
 * The reconcile-media core: list the media bucket, read the profile and post
 * media rows, delete the objects no row references.
 *
 * Lives in `src/` rather than inside `scripts/reconcile-media.ts` so the
 * ordering below is unit-tested (`src/reconcile-media.test.ts`) — the script
 * is the thin guarded wrapper that arms this against the bucket named on the
 * command line.
 *
 * The maintenance command holds the shared post-media advisory transaction
 * lock while this pass runs, so attachment and link-card writes cannot land
 * between the object listing and the row reads. LIST BEFORE READING THE ROWS,
 * and delete only after both snapshots exist — the order remains load-bearing
 * for the existing profile-media lifecycle (issue #52). The delete set is
 * `listed \
 * referenced`, so a concurrent upload survives exactly when the listing ran
 * first:
 *
 * - listed first: an object uploaded after the listing is not in `keys`, so
 *   it cannot be a deletion candidate; one uploaded before the listing but
 *   after the row read IS in `keys` AND in `referenced` (the row read sees
 *   the committed row), so it is kept either way. Post attachment writers
 *   cannot occupy that window because the command and writer share the
 *   advisory lock.
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
import { mediaVariantKeys } from "./constants.js";

/** The four profile image slots the reconcile script scans. */
export interface MediaImageRow {
  image: string | null;
  bannerImage: string | null;
  imageOriginal: string | null;
  bannerImageOriginal: string | null;
}

/** One authoritative post attachment path. */
export interface MediaAttachmentRow {
  mediaPath: string | null;
}

/** One authoritative link preview row. A negative entry's path is null. */
export interface MediaLinkCardRow {
  imageMediaPath: string | null;
}

export interface ReconcileMediaDeps {
  storage: Pick<DestructiveStorage, "listByPrefix" | "removeMany">;
  readUserRows: () => Promise<MediaImageRow[]>;
  readPostAttachmentRows?: () => Promise<MediaAttachmentRow[]>;
  readLinkCardRows?: () => Promise<MediaLinkCardRow[]>;
}

export interface ReconcileMediaResult {
  rows: number;
  referenced: number;
  listed: number;
  deleted: number;
}

const PREFIXES = ["avatars/", "banners/", "posts/", "link-cards/"] as const;

export async function reconcileMedia({
  storage,
  readUserRows,
  readPostAttachmentRows = () => Promise.resolve([]),
  readLinkCardRows = () => Promise.resolve([]),
}: ReconcileMediaDeps): Promise<ReconcileMediaResult> {
  // Order matters: list the bucket BEFORE reading the rows. Anything not
  // listed here is not a deletion candidate, no matter what the rows say a
  // moment later.
  const listedByPrefix = new Map<string, string[]>();
  let listed = 0;
  for (const prefix of PREFIXES) {
    const keys = await storage.listByPrefix(prefix);
    listedByPrefix.set(prefix, keys);
    listed += keys.length;
  }

  // Read after the listing so the snapshot postdates it: an upload that
  // lands between the two steps is in `referenced` and kept. Reversing the
  // two deletes an object whose row points at it (issue #52).
  const rows = await readUserRows();
  const attachmentRows = await readPostAttachmentRows();
  const linkCardRows = await readLinkCardRows();

  const referenced = new Set<string>();
  const addReferenced = (key: string) => {
    referenced.add(key);
    // A derived variant (`…/uuid.png.w640.webp`, media-variants.ts) is referenced
    // exactly when its base is: it is unreachable the moment the base goes,
    // so it is reaped with it rather than orphaned by the row shape (only
    // the base path is stored anywhere). The immediate cleanup paths delete
    // variants alongside their base directly; this pairing rule is the
    // eventual-consistency half for everything that slips past them.
    for (const variantKey of mediaVariantKeys(key)) referenced.add(variantKey);
  };
  for (const row of rows) {
    for (const value of [row.image, row.bannerImage, row.imageOriginal, row.bannerImageOriginal]) {
      const key = objectKeyFromMediaPath(value);
      if (key) addReferenced(key);
    }
  }
  for (const row of attachmentRows) {
    const key = objectKeyFromMediaPath(row.mediaPath);
    if (key) addReferenced(key);
  }
  for (const row of linkCardRows) {
    const key = objectKeyFromMediaPath(row.imageMediaPath);
    if (key) addReferenced(key);
  }

  console.log(
    `scanning ${rows.length} user rows, ${attachmentRows.length} post attachments and ${linkCardRows.length} link cards; ${referenced.size} referenced objects`,
  );

  let deleted = 0;
  for (const prefix of PREFIXES) {
    const keys = listedByPrefix.get(prefix)!;
    const orphans = keys.filter((key) => !referenced.has(key));
    if (orphans.length > 0) {
      const removed = await storage.removeMany(orphans);
      deleted += removed;
      console.log(`${prefix}: deleted ${removed} of ${keys.length} objects`);
    } else if (keys.length > 0) {
      console.log(`${prefix}: all ${keys.length} objects referenced, nothing to do`);
    }
  }

  return { rows: rows.length, referenced: referenced.size, listed, deleted };
}
