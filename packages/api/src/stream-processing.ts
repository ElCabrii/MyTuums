import type { Database } from "@my-tuums/db";
import { video, videoSubmission } from "@my-tuums/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { notificationInsert } from "./notification-writer.js";

const processingStates = ["queued", "processing", "ready"] as const;
const expired = sql`${video.expiresAt} <= cast(unixepoch('subsec') * 1000 as integer)`;

/**
 * Provider failures and the processing deadline use the same terminal commit.
 * The transition's trigger records Stream cleanup; the notification and erasure
 * of private text/captions roll back with it. A cancelled or published video
 * cannot be failed by a late provider response or duplicate Workflow.
 */
export async function failStreamVideo(db: Database, id: string, onlyExpired = false) {
  const failed = and(eq(video.id, id), eq(video.state, "failed"), isNotNull(video.streamCreatorId));
  const recipient = sql<string>`(select ${videoSubmission.authorId} from ${videoSubmission}
    where ${videoSubmission.videoId} = ${id})`;
  const notice = notificationInsert(
    db,
    { recipientId: recipient, actorId: null, type: "video_failed", videoId: id },
    sql`exists (select 1 from ${video} where ${failed})
    and ${recipient} is not null`,
  );
  const [changed] = await db.batch([
    db
      .update(video)
      .set({ state: "failed", uploadUrl: null, playback: null })
      .where(
        and(
          eq(video.id, id),
          isNotNull(video.streamCreatorId),
          inArray(video.state, [...processingStates]),
          onlyExpired ? expired : undefined,
        ),
      )
      .returning({ id: video.id }),
    ...(notice ? [notice] : []),
    db
      .delete(videoSubmission)
      .where(sql`${videoSubmission.videoId} in (select ${video.id} from ${video} where ${failed})`),
  ]);
  return changed.length === 1;
}

/** The database clock enforces the deadline even when no Workflow is running. */
export async function expireStreamProcessing(db: Database) {
  const due = await db
    .select({ id: video.id })
    .from(video)
    .where(
      and(isNotNull(video.streamCreatorId), inArray(video.state, [...processingStates]), expired),
    )
    .orderBy(video.expiresAt, video.id)
    .limit(50);
  let failed = 0;
  for (const candidate of due) if (await failStreamVideo(db, candidate.id, true)) failed += 1;
  return { scanned: due.length, failed };
}
