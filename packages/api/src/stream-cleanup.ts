import type { Database } from "@my-tuums/db";
import { video, videoCleanup, videoSubmission } from "@my-tuums/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { StreamService } from "./stream.js";

/** Expired unsubmitted uploads lose their capability and record cleanup atomically. */
export async function expireStreamUploads(db: Database): Promise<number> {
  const expired = await db
    .update(video)
    .set({ state: "cancelled", uploadUrl: null })
    .where(
      sql`${video.id} in (select id from video where stream_creator_id is not null
      and state in ('uploading', 'uploaded') and expires_at <= cast(unixepoch('subsec') * 1000 as integer)
      order by expires_at, id limit 50)`,
    )
    .returning({ id: video.id });
  return expired.length;
}

/**
 * Deletions are idempotent and scoped by the pre-recorded creator identity.
 * Keep an empty cleanup tombstone for 24 hours: a timed-out provider create can
 * become visible after its first recovery scan. No account/post FK owns this debt.
 */
export async function cleanStreamUploads(
  db: Database,
  stream: Pick<StreamService, "remove" | "findUploads">,
) {
  const due = await db
    .select()
    .from(videoCleanup)
    .where(
      and(
        sql`${videoCleanup.prefix} = 'stream-upload/' || ${videoCleanup.videoId}`,
        sql`${videoCleanup.nextAttemptAt} <= cast(unixepoch('subsec') * 1000 as integer)`,
      ),
    )
    .orderBy(videoCleanup.nextAttemptAt, videoCleanup.id)
    .limit(10);
  let cleaned = 0;
  let deferred = 0;
  for (const debt of due) {
    const unchanged = and(
      eq(videoCleanup.id, debt.id),
      debt.streamUid === null
        ? isNull(videoCleanup.streamUid)
        : eq(videoCleanup.streamUid, debt.streamUid),
    );
    try {
      if (debt.streamUid) await stream.remove(debt.videoId, debt.streamUid);
      const remaining = await stream.findUploads(debt.videoId);
      for (const uid of remaining) await stream.remove(debt.videoId, uid);
      if (!remaining.length && debt.createdAt.getTime() <= Date.now() - 86_400_000) {
        const [removed] = await db.batch([
          db.delete(videoCleanup).where(unchanged).returning({ id: videoCleanup.id }),
          db.delete(videoSubmission).where(sql`${videoSubmission.videoId} in (select id from video
            where id = ${debt.videoId} and (author_id is null or state in ('failed', 'cancelled', 'deleted')))`),
          db
            .delete(video)
            .where(
              and(
                eq(video.id, debt.videoId),
                sql`(${video.authorId} is null or ${inArray(video.state, ["failed", "cancelled", "deleted"])})`,
                sql`not exists (select 1 from video_cleanup where video_id = ${debt.videoId})`,
              ),
            ),
        ]);
        cleaned += removed.length;
      } else {
        await db
          .update(videoCleanup)
          .set({ nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer) + 3600000` })
          .where(unchanged);
      }
    } catch {
      deferred += 1;
      await db
        .update(videoCleanup)
        .set({
          attempts: sql`${videoCleanup.attempts} + 1`,
          nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer) + min(3600000, 30000 * (1 << min(${videoCleanup.attempts}, 7)))`,
        })
        .where(unchanged);
      console.error({ event: "stream_cleanup_deferred", videoId: debt.videoId });
    }
  }
  return { scanned: due.length, cleaned, deferred };
}
