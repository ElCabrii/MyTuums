import type { Database } from "@my-tuums/db";
import { post, user, video, videoSubmission, type StreamPlayback } from "@my-tuums/db/schema";
import { and, eq, isNotNull, isNull, not, sql } from "drizzle-orm";
import { z } from "zod";
import { VIDEO_MAX_DURATION_SECONDS } from "./constants.js";
import { postPublicationStatements, postTargetSelection } from "./post-publication.js";
import { failStreamVideo } from "./stream-processing.js";
import { effectivelyBanned } from "./visibility.js";

const playbackSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().positive().max(VIDEO_MAX_DURATION_SECONDS),
  captionLanguage: z.string().min(1).nullable(),
});

/** Only authenticated, ready Stream metadata enters this boundary. */
export async function recordStreamReady(
  db: Database,
  id: string,
  uid: string,
  playback: StreamPlayback,
) {
  const verified = playbackSchema.parse(playback);
  const changed = await db
    .update(video)
    .set({ state: "ready", playback: verified })
    .where(
      and(
        eq(video.id, id),
        eq(video.streamUid, uid),
        isNotNull(video.authorId),
        sql`${video.state} in ('queued', 'processing')`,
        sql`${video.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
        sql`exists (select 1 from ${videoSubmission} where ${videoSubmission.videoId} = ${id})`,
      ),
    )
    .returning({ id: video.id });
  return changed.length === 1;
}

/**
 * Author eligibility, target visibility and the deadline are decided inside
 * the same batch as ordinary post effects. The first update latches eligibility;
 * postId stays NULL only inside this transaction, until its post is inserted.
 * No worker can observe or act on that intermediate state. Duplicate delivery
 * sees the committed postId and cannot mint a second post or notification.
 */
export async function publishStreamVideo(db: Database, id: string) {
  const [pending] = await db
    .select({
      submission: videoSubmission,
      playback: video.playback,
      uid: video.streamUid,
      byteSize: video.byteSize,
    })
    .from(videoSubmission)
    .innerJoin(video, eq(video.id, videoSubmission.videoId))
    .where(and(eq(video.id, id), eq(video.state, "ready")));
  if (!pending?.playback || !pending.uid) return false;
  const draft = pending.submission;
  const eligible = and(
    eq(video.id, id),
    eq(video.state, "ready"),
    eq(video.authorId, draft.authorId),
    eq(video.streamUid, pending.uid),
    isNull(video.postId),
    sql`${video.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
    sql`exists (select 1 from ${user} where ${user.id} = ${draft.authorId} and ${not(effectivelyBanned)})`,
    sql`exists (select 1 from ${videoSubmission} where ${videoSubmission.videoId} = ${id}
      and ${videoSubmission.postId} = ${draft.postId})`,
    draft.parentId
      ? sql`exists (${postTargetSelection(db, draft.authorId, draft.parentId).getSQL()})`
      : undefined,
    draft.quotedPostId
      ? sql`exists (${postTargetSelection(db, draft.authorId, draft.quotedPostId).getSQL()})`
      : undefined,
  );
  const publishing = sql`exists (select 1 from ${video} where ${video.id} = ${id}
    and ${video.state} = 'published' and ${video.postId} is null and ${video.authorId} = ${draft.authorId}
    and exists (select 1 from ${videoSubmission} where ${videoSubmission.videoId} = ${id}
      and ${videoSubmission.postId} = ${draft.postId}))`;
  const recipient = (target: string) =>
    sql<string>`(select ${post.authorId} from ${post} where ${post.id} = ${target})`;
  const statements = postPublicationStatements(
    db,
    {
      postId: draft.postId,
      authorId: draft.authorId,
      content: draft.content,
      parentId: draft.parentId,
      quotedPostId: draft.quotedPostId,
      isPrivate: draft.isPrivate,
      parentAuthorId: draft.parentId ? recipient(draft.parentId) : undefined,
      quotedAuthorId: draft.quotedPostId ? recipient(draft.quotedPostId) : undefined,
      attachments: [
        {
          postId: draft.postId,
          position: 0,
          videoId: id,
          mediaPath: `/media/videos/${id}/master.m3u8`,
          contentType: "application/vnd.apple.mpegurl",
          // This is the accepted upload size; Stream does not expose a derivative inventory.
          byteSize: pending.byteSize,
          width: pending.playback.width,
          height: pending.playback.height,
        },
      ],
    },
    publishing,
  );
  const [changed] = await db.batch([
    db
      .update(video)
      .set({ state: "published", uploadUrl: null })
      .where(eligible)
      .returning({ id: video.id }),
    statements.insertPost,
    ...statements.effects,
    db
      .update(video)
      .set({ postId: draft.postId })
      .where(and(eq(video.id, id), publishing)),
    db
      .delete(videoSubmission)
      .where(
        and(
          eq(videoSubmission.videoId, id),
          sql`exists (select 1 from ${video} where ${video.id} = ${id} and ${video.postId} = ${draft.postId})`,
        ),
      ),
  ]);
  if (!changed.length) await failStreamVideo(db, id);
  return changed.length === 1;
}
