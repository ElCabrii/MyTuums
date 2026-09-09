import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lte, not, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Database } from "@my-tuums/db";
import {
  postAttachment,
  user,
  video,
  videoCleanup,
  videoSubmission,
  type VideoAsset,
  type VideoPlayback,
} from "@my-tuums/db/schema";
import { VIDEO_MAX_BYTES } from "./constants.js";
import { insertNotification } from "./notification-writer.js";
import { publishPost, resolvePostTarget } from "./post-publication.js";
import { effectivelyBanned } from "./visibility.js";
import { enqueueVideo, VIDEO_LEASE_SECONDS, VIDEO_MAX_ATTEMPTS } from "./video-queue.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type VideoRow = typeof video.$inferSelect;
type SubmissionRow = typeof videoSubmission.$inferSelect;
const pendingStates = ["queued", "processing", "ready"] as const;
export const VIDEO_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class VideoLifecycleError extends Error {
  constructor(readonly reason: "not_found" | "not_ready" | "unavailable") {
    super("The video is unavailable for this action.");
    this.name = "VideoLifecycleError";
  }
}

export function videoPrefix(videoId: string): string {
  return `videos/${videoId}/`;
}

export function videoAttemptPrefix(videoId: string, attemptId: string): string {
  return `${videoPrefix(videoId)}attempts/${attemptId}/`;
}

export async function createVideoUpload(db: Database, authorId: string, byteSize: number) {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0 || byteSize > VIDEO_MAX_BYTES) {
    throw new VideoLifecycleError("unavailable");
  }
  const id = randomUUID();
  const [created] = await db
    .insert(video)
    .values({
      id,
      authorId,
      byteSize,
      sourceKey: `${videoPrefix(id)}source`,
      expiresAt: new Date(Date.now() + VIDEO_UPLOAD_LIFETIME_MS),
    })
    .returning();
  if (!created) throw new Error("Video upload registration failed.");
  return created;
}

/** Record an upload capability only while its original owner still owns it. */
export async function registerVideoMultipart(
  db: Database,
  id: string,
  authorId: string,
  multipartId: string,
): Promise<boolean> {
  const updated = await db
    .update(video)
    .set({ multipartId })
    .where(
      and(
        eq(video.id, id),
        eq(video.authorId, authorId),
        eq(video.state, "uploading"),
        gt(video.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: video.id });
  return updated.length === 1;
}

export async function completeVideoUpload(
  db: Database,
  id: string,
  authorId: string,
): Promise<boolean> {
  const updated = await db
    .update(video)
    .set({ state: "uploaded", multipartId: null })
    .where(
      and(
        eq(video.id, id),
        eq(video.authorId, authorId),
        eq(video.state, "uploading"),
        gt(video.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: video.id });
  return updated.length === 1;
}

/** Explicit submit is the only operation that stores post text or queues work. */
export async function submitVideo(
  db: Database,
  queue: Pick<PgBoss, "send">,
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
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(video).where(eq(video.id, args.videoId)).for("update");
    if (!row || row.authorId !== args.authorId) throw new VideoLifecycleError("not_found");
    const [existing] = await tx
      .select({ id: videoSubmission.postId })
      .from(videoSubmission)
      .where(eq(videoSubmission.videoId, row.id));
    if (existing) return { id: existing.id, videoId: row.id, status: "pending" as const };
    if (row.state === "published" && row.postId)
      return { id: row.postId, videoId: row.id, status: "published" as const };
    if (row.state !== "uploaded" || row.expiresAt.getTime() <= Date.now())
      throw new VideoLifecycleError("not_ready");
    const [submission] = await tx
      .insert(videoSubmission)
      .values(args)
      .returning({ id: videoSubmission.postId });
    if (!submission) throw new Error("Video submission did not return its row.");
    await tx
      .update(video)
      .set({ state: "queued", expiresAt: new Date(Date.now() + VIDEO_UPLOAD_LIFETIME_MS) })
      .where(eq(video.id, row.id));
    await enqueueVideo(queue, tx, row.id);
    return { id: submission.id, videoId: row.id, status: "pending" as const };
  });
}

async function oweCleanup(
  tx: Transaction,
  row: VideoRow,
  prefix = videoPrefix(row.id),
): Promise<void> {
  await tx
    .insert(videoCleanup)
    .values({
      videoId: row.id,
      prefix,
      sourceKey: prefix === videoPrefix(row.id) ? row.sourceKey : null,
      multipartId: prefix === videoPrefix(row.id) ? row.multipartId : null,
    })
    .onConflictDoNothing({ target: videoCleanup.prefix });
}

/** Erase failed text/captions and mint its sole notification in one commit. */
async function terminateVideo(
  tx: Transaction,
  row: VideoRow,
  state: "failed" | "cancelled" | "deleted",
): Promise<void> {
  const removed = await tx
    .delete(videoSubmission)
    .where(eq(videoSubmission.videoId, row.id))
    .returning({ authorId: videoSubmission.authorId });
  if (state === "failed" && removed[0])
    await insertNotification(tx, {
      recipientId: removed[0].authorId,
      actorId: null,
      type: "video_failed",
      videoId: row.id,
    });
  await tx
    .update(video)
    .set({ state, playback: null, assets: [], leaseExpiresAt: null })
    .where(eq(video.id, row.id));
  await oweCleanup(tx, row);
}

export async function cancelVideo(db: Database, id: string, authorId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(video).where(eq(video.id, id)).for("update");
    if (!row || row.authorId !== authorId) throw new VideoLifecycleError("not_found");
    if (row.state === "published") throw new VideoLifecycleError("unavailable");
    if (row.state === "failed" || row.state === "cancelled" || row.state === "deleted") return;
    await terminateVideo(tx, row, "cancelled");
  });
}

export interface VideoWork {
  videoId: string;
  attemptId: string;
  sourceKey: string;
  byteSize: number;
  prefix: string;
  caption: string | null;
  captionLanguage: string | null;
  ready: boolean;
}

/** Row locking fences duplicate deliveries and workers whose lease expired. */
export async function claimVideo(db: Database, id: string): Promise<VideoWork | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(video).where(eq(video.id, id)).for("update");
    if (!row || !pendingStates.some((state) => state === row.state)) return null;
    if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()) return null;
    const [submission] = await tx
      .select()
      .from(videoSubmission)
      .where(eq(videoSubmission.videoId, row.id));
    if (!row.authorId || !submission) {
      await terminateVideo(tx, row, "deleted");
      return null;
    }
    if (
      row.expiresAt.getTime() <= Date.now() ||
      (row.state !== "ready" && row.attempts >= VIDEO_MAX_ATTEMPTS)
    ) {
      await terminateVideo(tx, row, "failed");
      return null;
    }
    const ready = row.state === "ready";
    const attemptId = ready && row.attemptId ? row.attemptId : randomUUID();
    if (!ready && row.attemptId)
      await oweCleanup(tx, row, videoAttemptPrefix(row.id, row.attemptId));
    await tx
      .update(video)
      .set({
        state: ready ? "ready" : "processing",
        attemptId,
        attempts: ready ? row.attempts : row.attempts + 1,
        leaseExpiresAt: new Date(Date.now() + VIDEO_LEASE_SECONDS * 1000),
      })
      .where(eq(video.id, row.id));
    return {
      videoId: row.id,
      attemptId,
      sourceKey: row.sourceKey,
      byteSize: row.byteSize,
      prefix: videoAttemptPrefix(row.id, attemptId),
      caption: submission.caption,
      captionLanguage: submission.captionLanguage,
      ready,
    };
  });
}

function liveAttempt(work: Pick<VideoWork, "videoId" | "attemptId">) {
  return and(
    eq(video.id, work.videoId),
    eq(video.attemptId, work.attemptId),
    inArray(video.state, ["processing", "ready"]),
    isNotNull(video.authorId),
    gt(video.leaseExpiresAt, sql`now()`),
  );
}

export async function renewVideoLease(db: Database, work: VideoWork): Promise<boolean> {
  const updated = await db
    .update(video)
    .set({ leaseExpiresAt: new Date(Date.now() + VIDEO_LEASE_SECONDS * 1000) })
    .where(liveAttempt(work))
    .returning({ id: video.id });
  return updated.length === 1;
}

export async function finishVideoEncoding(
  db: Database,
  work: VideoWork,
  playback: VideoPlayback,
  assets: VideoAsset[],
): Promise<boolean> {
  const updated = await db
    .update(video)
    .set({ state: "ready", playback, assets })
    .where(and(liveAttempt(work), eq(video.state, "processing")))
    .returning({ id: video.id });
  return updated.length === 1;
}

/** Call only after storage confirms the original is gone. */
export async function confirmVideoSourceDeleted(db: Database, work: VideoWork): Promise<boolean> {
  const updated = await db
    .update(video)
    .set({ sourceDeletedAt: new Date() })
    .where(and(liveAttempt(work), eq(video.state, "ready")))
    .returning({ id: video.id });
  return updated.length === 1;
}

async function publicationTargets(tx: Transaction, submission: SubmissionRow) {
  // A key-share lock would allow a concurrent ban UPDATE. Share keeps the
  // eligibility check stable until publication commits, including deletion.
  const [author] = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, submission.authorId), not(effectivelyBanned)))
    .for("share");
  if (!author) return null;
  const parent = submission.parentId
    ? await resolvePostTarget(tx, author.id, submission.parentId)
    : undefined;
  const quoted = submission.quotedPostId
    ? await resolvePostTarget(tx, author.id, submission.quotedPostId)
    : undefined;
  if ((submission.parentId && !parent) || (submission.quotedPostId && !quoted)) return null;
  return { parentAuthorId: parent?.authorId, quotedAuthorId: quoted?.authorId };
}

export async function publishVideo(db: Database, work: VideoWork): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ authorId: video.authorId })
      .from(video)
      .where(eq(video.id, work.videoId));
    // Account deletion locks user before its cascading video update. Take the
    // same order so a concurrent publication cannot deadlock that deletion.
    if (owner?.authorId)
      await tx.select({ id: user.id }).from(user).where(eq(user.id, owner.authorId)).for("share");
    const [row] = await tx.select().from(video).where(liveAttempt(work)).for("update");
    if (!row || row.state !== "ready" || !row.sourceDeletedAt || !row.playback) return false;
    const [submission] = await tx
      .select()
      .from(videoSubmission)
      .where(eq(videoSubmission.videoId, row.id));
    if (!submission || !row.authorId) {
      await terminateVideo(tx, row, "deleted");
      return false;
    }
    const targets = await publicationTargets(tx, submission);
    if (!targets) {
      await terminateVideo(tx, row, "failed");
      return false;
    }
    await publishPost(tx, {
      postId: submission.postId,
      authorId: submission.authorId,
      content: submission.content,
      parentId: submission.parentId,
      quotedPostId: submission.quotedPostId,
      isPrivate: submission.isPrivate,
      ...targets,
      attachments: [
        {
          postId: submission.postId,
          position: 0,
          videoId: row.id,
          mediaPath: `/media/${work.prefix}master.m3u8`,
          contentType: "application/vnd.apple.mpegurl",
          byteSize: row.assets.reduce((sum, asset) => sum + asset.byteSize, 0),
          width: row.playback.width,
          height: row.playback.height,
        },
      ],
    });
    await tx
      .update(video)
      .set({ state: "published", postId: submission.postId, leaseExpiresAt: null })
      .where(eq(video.id, row.id));
    await tx.delete(videoSubmission).where(eq(videoSubmission.videoId, row.id));
    return true;
  });
}

/** Returns whether the failure was terminal; retryable failures keep the text. */
export async function failVideoWork(
  db: Database,
  work: VideoWork,
  retryable: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(video)
      .where(and(eq(video.id, work.videoId), eq(video.attemptId, work.attemptId)))
      .for("update");
    if (!row || !pendingStates.some((state) => state === row.state)) return true;
    if (
      !retryable ||
      row.expiresAt.getTime() <= Date.now() ||
      (row.state !== "ready" && row.attempts >= VIDEO_MAX_ATTEMPTS)
    ) {
      await terminateVideo(tx, row, "failed");
      return true;
    }
    if (row.state === "ready") {
      await tx.update(video).set({ leaseExpiresAt: null }).where(eq(video.id, row.id));
    } else {
      await oweCleanup(tx, row, work.prefix);
      await tx
        .update(video)
        .set({ state: "queued", attemptId: null, leaseExpiresAt: null })
        .where(eq(video.id, row.id));
    }
    return false;
  });
}

/** Post deletion records storage debt in the caller's tombstone transaction. */
export async function deletePostVideo(tx: Transaction, postId: string): Promise<void> {
  const rows = await tx.select().from(video).where(eq(video.postId, postId)).for("update");
  for (const row of rows) {
    await tx.delete(postAttachment).where(eq(postAttachment.videoId, row.id));
    await terminateVideo(tx, row, "deleted");
  }
}

/** Recover missing jobs and account/post cascades without requiring a request. */
export async function reconcileVideoRecords(
  db: Database,
  queue: Pick<PgBoss, "send">,
): Promise<void> {
  const candidates = await db
    .select({ id: video.id })
    .from(video)
    .where(
      and(
        not(inArray(video.state, ["failed", "cancelled", "deleted"])),
        or(
          isNull(video.authorId),
          and(eq(video.state, "published"), isNull(video.postId)),
          and(inArray(video.state, ["uploading", "uploaded"]), lte(video.expiresAt, sql`now()`)),
          and(
            inArray(video.state, [...pendingStates]),
            or(isNull(video.leaseExpiresAt), lte(video.leaseExpiresAt, sql`now()`)),
          ),
        ),
      ),
    )
    .orderBy(video.expiresAt, video.id)
    .limit(100);
  for (const candidate of candidates)
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(video)
        .where(eq(video.id, candidate.id))
        .for("update", { skipLocked: true });
      if (!row || row.state === "failed" || row.state === "cancelled" || row.state === "deleted")
        return;
      if (!row.authorId || (row.state === "published" && !row.postId)) {
        await terminateVideo(tx, row, "deleted");
        return;
      }
      if (row.state === "published") return;
      if (row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()) return;
      if (row.expiresAt.getTime() <= Date.now()) {
        await terminateVideo(
          tx,
          row,
          pendingStates.some((state) => state === row.state) ? "failed" : "cancelled",
        );
        return;
      }
      if (pendingStates.some((state) => state === row.state)) await enqueueVideo(queue, tx, row.id);
    });
}
