/** List all managed prefixes, then read every live/pending reference in one D1 snapshot. */
import type { ObjectStorageMaintenance } from "./object-storage.js";
import { objectKeyFromMediaPath } from "./image.js";
import { mediaVariantKeys } from "./constants.js";

export interface MediaReferenceRow {
  mediaPath: string | null;
}

export interface ReconcileMediaDeps {
  storage: Pick<ObjectStorageMaintenance, "listByPrefix" | "removeMany">;
  /** Must include pending uploads and published paths together, after all listings finish. */
  readReferences: () => Promise<MediaReferenceRow[]>;
}

export interface ReconcileMediaResult {
  rows: number;
  referenced: number;
  listed: number;
  deleted: number;
}

const PREFIXES = ["avatars/", "banners/", "posts/", "link-cards/", "games/"] as const;

export async function reconcileMedia({
  storage,
  readReferences,
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
  const rows = await readReferences();

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
    const key = objectKeyFromMediaPath(row.mediaPath);
    if (key) addReferenced(key);
  }

  console.log(`scanning ${rows.length} media references; ${referenced.size} referenced objects`);

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
