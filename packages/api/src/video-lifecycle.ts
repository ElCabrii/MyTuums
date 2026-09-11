import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { video, videoSubmission } from "@my-tuums/db/schema";
import { jobIntentInsert, type JobDispatcher } from "./jobs.js";

export class VideoLifecycleError extends Error {
  constructor(readonly reason: "not_found" | "not_ready" | "unavailable") {
    super("The video is unavailable for this action.");
    this.name = "VideoLifecycleError";
  }
}

/** Explicit submit is the only operation that stores post text or queues work. */
export async function submitVideo(
  db: Database,
  jobs: JobDispatcher,
  args: {
    videoId: string;
    authorId: string;
    content: string;
    parentId: string | null;
    quotedPostId: string | null;
    isPrivate: boolean;
    caption: string | null;
    captionLanguage: string | null;
  },
) {
  const postId = crypto.randomUUID();
  const jobId = `video-${args.videoId}`;
  const ownsSubmission = sql`exists (select 1 from video_submission where video_id = ${args.videoId} and post_id = ${postId})`;
  const results = await db.batch([
    db
      .insert(videoSubmission)
      .select(
        sql`select ${args.videoId}, ${args.authorId}, ${postId}, ${args.content},
      ${args.parentId}, ${args.quotedPostId}, ${args.isPrivate ? 1 : 0}, ${args.caption}, ${args.captionLanguage},
      cast(unixepoch('subsec') * 1000 as integer) from video
      where id = ${args.videoId} and author_id = ${args.authorId} and state = 'uploaded'
      and expires_at > cast(unixepoch('subsec') * 1000 as integer)`,
      )
      .onConflictDoNothing({ target: videoSubmission.videoId }),
    db
      .update(video)
      .set({
        state: "queued",
        expiresAt: sql`cast(unixepoch('subsec') * 1000 as integer) + 1800000`,
      })
      .where(and(eq(video.id, args.videoId), ownsSubmission)),
    jobIntentInsert(db, { id: jobId, kind: "video", entityId: args.videoId }, ownsSubmission),
    db
      .select({
        state: video.state,
        postId: video.postId,
        pendingId: sql<string | null>`${videoSubmission.postId}`.as("pending_id"),
      })
      .from(video)
      .leftJoin(videoSubmission, eq(videoSubmission.videoId, video.id))
      .where(and(eq(video.id, args.videoId), eq(video.authorId, args.authorId))),
  ]);
  const current = results[3][0];
  if (!current) throw new VideoLifecycleError("not_found");
  if (current.state === "published" && current.postId)
    return { id: current.postId, videoId: args.videoId, status: "published" as const };
  if (!current.pendingId) throw new VideoLifecycleError("not_ready");
  // Commit first. Recovery owns a missing/ambiguous Workflow creation acknowledgement.
  await jobs.dispatch(jobId).catch(() => {
    console.error({ event: "video_dispatch_deferred", videoId: args.videoId });
  });
  return { id: current.pendingId, videoId: args.videoId, status: "pending" as const };
}
