import type { Database } from "@my-tuums/db";
import { messageAttachment, video, videoSubmission } from "@my-tuums/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { VIDEO_MAX_DURATION_SECONDS } from "./constants.js";
import { failStreamVideo } from "./stream-processing.js";
import {
  publishMessageVideo,
  publishStreamVideo,
  recordStreamReady,
} from "./stream-publication.js";
import { StreamError, type StreamService } from "./stream.js";

/** The runtime supplies its native stream conversion at the caption boundary. */
export interface StreamProcessor {
  status: StreamService["status"];
  uploadCaptions(id: string, uid: string, language: string, text: string): Promise<void>;
}

/**
 * One restartable poll. Call inside a Workflow step: private database values
 * never leave this function, and its only persisted result is a control flag.
 * Every retry reloads current state; provider success is never publication consent.
 */
export async function advanceStreamVideo(
  db: Database,
  stream: StreamProcessor,
  id: string,
): Promise<"waiting" | "done"> {
  await failStreamVideo(db, id, true);
  const [work] = await db
    .select({
      state: video.state,
      uid: video.streamUid,
      submission: videoSubmission,
      messageAttachmentId: sql<string | null>`(
        select ${messageAttachment.id} from ${messageAttachment}
        where ${messageAttachment.videoId} = ${video.id} limit 1)`,
    })
    .from(video)
    .leftJoin(
      videoSubmission,
      and(eq(videoSubmission.videoId, video.id), eq(video.authorId, videoSubmission.authorId)),
    )
    .where(and(eq(video.id, id), sql`${video.state} in ('queued', 'processing', 'ready')`));
  if (!work) return "done";
  if (work.state === "ready") {
    // The destination decides the publication shape: a post submission
    // publishes the post; a message attachment only retires the video's own
    // processing state (the message row has existed since its send).
    if (work.submission) await publishStreamVideo(db, id);
    else await publishMessageVideo(db, id);
    return "done";
  }
  if (!work.uid) {
    await failStreamVideo(db, id);
    return "done";
  }
  try {
    const status = await stream.status(id, work.uid);
    if (!status || status.failed) {
      await failStreamVideo(db, id);
      return "done";
    }
    if (!status.ready) return "waiting";
    if (
      !status.uploaded ||
      !Number.isInteger(status.width) ||
      status.width <= 0 ||
      !Number.isInteger(status.height) ||
      status.height <= 0 ||
      !Number.isFinite(status.duration) ||
      status.duration <= 0 ||
      status.duration > VIDEO_MAX_DURATION_SECONDS
    ) {
      await failStreamVideo(db, id);
      return "done";
    }

    // A message video carries no captions: validate, mark ready, publish —
    // the message row has existed since its send, so there is nothing else
    // to do but retire the processing state.
    if (!work.submission) {
      await recordStreamReady(db, id, work.uid, {
        width: status.width,
        height: status.height,
        duration: status.duration,
        captionLanguage: null,
      });
      await publishMessageVideo(db, id);
      return "done";
    }

    // Recheck after provider I/O before sending private captions. A deletion
    // racing the upload is still covered by the durable Stream cleanup record.
    const [current] = await db
      .select({ caption: videoSubmission.caption, language: videoSubmission.captionLanguage })
      .from(videoSubmission)
      .innerJoin(video, eq(video.id, videoSubmission.videoId))
      .where(
        and(
          eq(video.id, id),
          eq(video.streamUid, work.uid),
          eq(video.authorId, videoSubmission.authorId),
          sql`${video.state} in ('queued', 'processing')`,
          sql`${video.expiresAt} > cast(unixepoch('subsec') * 1000 as integer)`,
        ),
      );
    if (!current) {
      await failStreamVideo(db, id, true);
      await publishStreamVideo(db, id);
      return "done";
    }
    if (current.caption !== null) {
      if (
        !current.language ||
        !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(current.language) ||
        !current.caption.startsWith("WEBVTT") ||
        new TextEncoder().encode(current.caption).length > 1024 * 1024
      ) {
        await failStreamVideo(db, id);
        return "done";
      }
      // Upload replaces the same language track, so a lost acknowledgement is
      // safe to retry. The text is read inside the step, never in its payload.
      await stream.uploadCaptions(id, work.uid, current.language, current.caption);
    }
    await recordStreamReady(db, id, work.uid, {
      width: status.width,
      height: status.height,
      duration: status.duration,
      captionLanguage: current.caption === null ? null : current.language,
    });
    await publishStreamVideo(db, id);
    return "done";
  } catch (error) {
    if (error instanceof StreamError && error.reason !== "unavailable") {
      await failStreamVideo(db, id);
      return "done";
    }
    // Preserve internal diagnostics for the caller. The Worker catches this
    // inside step.do and replaces it before Workflow history can persist it.
    throw error;
  }
}
