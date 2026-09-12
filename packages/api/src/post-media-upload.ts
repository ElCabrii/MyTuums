import { eq, lte, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { postAttachment, postMediaUpload } from "@my-tuums/db/schema";
import { mediaVariantKeys } from "./constants.js";
import type { Storage } from "./storage.js";

const UPLOAD_LIFETIME_MS = 30 * 60 * 1000;

/** Record every immutable key before the first storage write. */
export async function beginPostMediaUpload(db: Database, postId: string, keys: string[]) {
  await db.insert(postMediaUpload).values({
    postId,
    keys,
    expiresAt: new Date(Date.now() + UPLOAD_LIFETIME_MS),
  });
}

/**
 * One database snapshot covers both sides of publication. Reading attachments
 * and then intents separately could miss a publication between those reads.
 * Keep expired intents protected until cleanup has actually claimed them.
 */
export function readPostMediaReferences(db: Database): Promise<{ mediaPath: string }[]> {
  return db.all<{ mediaPath: string }>(sql`
    select ${postAttachment.mediaPath} as "mediaPath" from ${postAttachment}
    union all
    select '/media/' || upload_key.value as "mediaPath"
    from ${postMediaUpload}, json_each(${postMediaUpload.keys}) as upload_key
  `);
}

/**
 * A bounded recovery pass. Expiry prevents any subsequent publication, while
 * failed deletes retain the intent for retry. If a PUT finishes after cleanup,
 * inventory reconciliation still finds that unreferenced immutable key.
 */
export async function cleanupExpiredPostMediaUploads(
  db: Database,
  storage: Pick<Storage, "remove">,
) {
  const expired = await db
    .select()
    .from(postMediaUpload)
    .where(lte(postMediaUpload.expiresAt, sql`cast(unixepoch('subsec') * 1000 as integer)`))
    .orderBy(postMediaUpload.expiresAt, postMediaUpload.postId)
    .limit(50);
  for (const upload of expired) {
    for (const key of upload.keys) {
      for (const objectKey of [key, ...mediaVariantKeys(key)]) await storage.remove(objectKey);
    }
    await db.delete(postMediaUpload).where(eq(postMediaUpload.postId, upload.postId));
  }
  return expired.length;
}
