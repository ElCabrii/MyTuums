import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { mediaIntent } from "@my-tuums/db/schema";
import { mediaVariantKeys } from "./constants.js";
import { objectKeyFromMediaPath } from "./image.js";
import type { ObjectStorage } from "./object-storage.js";

/** Register immutable paths before any PUT, including writes that might fail ambiguously. */
export async function beginMediaUpload(db: Database, scope: string, paths: string[]) {
  const id = crypto.randomUUID();
  await db.insert(mediaIntent).values({
    id,
    scope,
    kind: "upload",
    paths,
    readyAt: sql`cast(unixepoch('subsec') * 1000 as integer) + ${30 * 60 * 1000}`,
  });
  return id;
}

/** Evaluated in the publication batch, so expiry and cleanup cannot race publication. */
export function mediaUploadIsLive(id: string) {
  return sql`exists (select 1 from media_intent where id = ${id} and kind = 'upload'
    and ready_at > cast(unixepoch('subsec') * 1000 as integer))`;
}

/** One snapshot covers every pending-to-live handoff after the bucket listing. */
export function readMediaReferences(db: Database) {
  // Nest the single-path tables to stay within D1's compound-SELECT term limit.
  return db.all<{ mediaPath: string | null }>(sql`
    select profile.value as mediaPath from user,
      json_each(json_array(image, image_original, banner_image, banner_image_original)) as profile
    union all select media_path from (
      select media_path from post_attachment
      union all select image_media_path from link_card
      union all select cover_media_path from game
    )
    union all select '/media/' || pending.value
      from post_media_upload, json_each(post_media_upload.keys) as pending
    union all select pending.value
      from media_intent, json_each(media_intent.paths) as pending
      where media_intent.kind = 'upload'
  `);
}

/**
 * Bounded recovery, including failed uploads and account-deletion debt. Paths
 * are never reused by a later upload. A failed removal keeps the whole intent
 * for retry; late PUTs after expiry are covered by inventory reconciliation.
 */
export async function cleanupMediaIntents(
  db: Database,
  storage: Pick<ObjectStorage, "remove">,
  scope?: string,
) {
  const ready = await db
    .select()
    .from(mediaIntent)
    .where(
      and(
        sql`${mediaIntent.readyAt} <= cast(unixepoch('subsec') * 1000 as integer)`,
        scope === undefined ? undefined : eq(mediaIntent.scope, scope),
      ),
    )
    .orderBy(mediaIntent.readyAt, mediaIntent.id)
    .limit(50);
  let completed = 0;
  let failed = 0;
  for (const intent of ready) {
    const keys = new Set<string>();
    for (const path of intent.paths) {
      const key = objectKeyFromMediaPath(path);
      if (key) for (const objectKey of [key, ...mediaVariantKeys(key)]) keys.add(objectKey);
    }
    try {
      for (const key of keys) await storage.remove(key);
      await db.delete(mediaIntent).where(eq(mediaIntent.id, intent.id));
      completed += 1;
    } catch {
      failed += 1;
      console.error({ event: "media_cleanup_failed", intentId: intent.id });
    }
  }
  return { completed, failed };
}
