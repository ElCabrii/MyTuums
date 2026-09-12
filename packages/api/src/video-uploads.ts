import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { video, videoCleanup, videoSubmission } from "@my-tuums/db/schema";
import { submitVideo, VideoLifecycleError } from "./video-lifecycle.js";
import type { JobDispatcher } from "./jobs.js";
import type { StreamService } from "./stream.js";
import { VIDEO_MAX_BYTES } from "./constants.js";

/** Native Stream uploads; post text is stored only by explicit submission. */
export function createVideoUploads(db: Database, stream: StreamService, jobs: JobDispatcher) {
  async function owned(id: string, authorId: string) {
    const [row] = await db
      .select()
      .from(video)
      .where(and(eq(video.id, id), eq(video.authorId, authorId)));
    if (!row) throw new VideoLifecycleError("not_found");
    if (!row.streamCreatorId || ["failed", "cancelled", "deleted"].includes(row.state))
      throw new VideoLifecycleError("unavailable");
    if (["uploading", "uploaded"].includes(row.state) && row.expiresAt.getTime() <= Date.now())
      throw new VideoLifecycleError("unavailable");
    return row;
  }

  async function cancel(id: string, authorId: string): Promise<void> {
    const [before] = await db.batch([
      db
        .select({ state: video.state })
        .from(video)
        .where(and(eq(video.id, id), eq(video.authorId, authorId))),
      db
        .update(video)
        .set({
          state: "cancelled",
          uploadUrl: null,
          playback: null,
        })
        .where(
          and(
            eq(video.id, id),
            eq(video.authorId, authorId),
            notInArray(video.state, ["published", "failed", "cancelled", "deleted"]),
          ),
        ),
      db.delete(videoSubmission).where(sql`${videoSubmission.videoId} in (select id from video
        where id = ${id} and author_id = ${authorId} and state = 'cancelled')`),
    ]);
    if (!before[0]) throw new VideoLifecycleError("not_found");
    if (before[0].state === "published") throw new VideoLifecycleError("unavailable");
  }

  return {
    async begin(authorId: string, byteSize: number) {
      if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > VIDEO_MAX_BYTES)
        throw new VideoLifecycleError("unavailable");
      const id = crypto.randomUUID();
      const [row] = await db
        .insert(video)
        .values({
          id,
          authorId,
          byteSize,
          streamCreatorId: stream.creatorId(id),
          expiresAt: sql`cast(unixepoch('subsec') * 1000 as integer) + 86400000`,
        })
        .returning();
      if (!row) throw new VideoLifecycleError("unavailable");
      try {
        const capability = await stream.createUpload(id, byteSize, row.expiresAt);
        const registered = await db
          .update(video)
          .set({ streamUid: capability.uid, uploadUrl: capability.uploadUrl })
          .where(
            and(
              eq(video.id, id),
              eq(video.authorId, authorId),
              eq(video.state, "uploading"),
              sql`${video.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
            ),
          )
          .returning({ id: video.id });
        if (!registered.length) {
          // Account deletion/cleanup can win while Stream is creating the resource.
          await db
            .insert(videoCleanup)
            .values({ videoId: id, prefix: `stream-upload/${id}`, streamUid: capability.uid })
            .onConflictDoUpdate({
              target: videoCleanup.prefix,
              set: {
                streamUid: capability.uid,
                nextAttemptAt: sql`cast(unixepoch('subsec') * 1000 as integer)`,
              },
            });
          throw new VideoLifecycleError("unavailable");
        }
        return { id, byteSize, expiresAt: row.expiresAt };
      } catch (error) {
        // Even an unknown provider UID is recoverable through the pre-recorded creator ID.
        await cancel(id, authorId).catch(() => {
          console.error({ event: "video_cancel_deferred", videoId: id });
        });
        throw error;
      }
    },
    async status(id: string, authorId: string) {
      const row = await owned(id, authorId);
      return {
        id,
        state: row.state,
        byteSize: row.byteSize,
        expiresAt: row.expiresAt,
        postId: row.postId,
        uploadUrl: row.state === "uploading" ? row.uploadUrl : null,
      };
    },
    async finish(id: string, authorId: string) {
      const row = await owned(id, authorId);
      if (row.state !== "uploading") return { id, state: row.state };
      if (!row.streamUid) throw new VideoLifecycleError("not_ready");
      const status = await stream.status(id, row.streamUid);
      if (!status || status.failed) {
        await cancel(id, authorId);
        throw new VideoLifecycleError("unavailable");
      }
      if (!status.uploaded) throw new VideoLifecycleError("not_ready");
      await db
        .update(video)
        .set({ state: "uploaded", uploadUrl: null })
        .where(
          and(
            eq(video.id, id),
            eq(video.authorId, authorId),
            eq(video.state, "uploading"),
            sql`${video.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
          ),
        );
      const current = await owned(id, authorId);
      if (current.state === "uploading") throw new VideoLifecycleError("not_ready");
      return { id, state: current.state };
    },
    cancel,
    submit(args: Parameters<typeof submitVideo>[2]) {
      return submitVideo(db, jobs, args);
    },
    pending(authorId: string) {
      return db
        .select({
          id: videoSubmission.postId,
          videoId: video.id,
          content: videoSubmission.content,
          parentId: videoSubmission.parentId,
          quotedPostId: videoSubmission.quotedPostId,
          isPrivate: videoSubmission.isPrivate,
          createdAt: videoSubmission.createdAt,
        })
        .from(videoSubmission)
        .innerJoin(video, eq(video.id, videoSubmission.videoId))
        .where(eq(videoSubmission.authorId, authorId))
        .orderBy(desc(videoSubmission.createdAt));
    },
  };
}
export type VideoUploads = ReturnType<typeof createVideoUploads>;
