import { and, desc, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Database } from "@my-tuums/db";
import { video, videoSubmission } from "@my-tuums/db/schema";
import {
  cancelVideo,
  completeVideoUpload,
  createVideoUpload,
  registerVideoMultipart,
  submitVideo,
  VideoLifecycleError,
} from "./video-lifecycle.js";
import { VIDEO_PART_BYTES, type VideoPart, type VideoUploadStorage } from "./video-storage.js";

function expectedPartSize(total: number, number: number): number {
  return Math.min(VIDEO_PART_BYTES, total - (number - 1) * VIDEO_PART_BYTES);
}

function completeParts(parts: VideoPart[], byteSize: number): boolean {
  const count = Math.ceil(byteSize / VIDEO_PART_BYTES);
  return (
    parts.length === count &&
    parts.every(
      (part, index) =>
        part.number === index + 1 && part.byteSize === expectedPartSize(byteSize, part.number),
    )
  );
}

/** Owns the multipart protocol; procedures pass authenticated intent only. */
export function createVideoUploads(
  db: Database,
  storage: VideoUploadStorage,
  queue: Pick<PgBoss, "send">,
) {
  async function owned(id: string, authorId: string) {
    const [row] = await db
      .select()
      .from(video)
      .where(and(eq(video.id, id), eq(video.authorId, authorId)));
    if (!row) throw new VideoLifecycleError("not_found");
    if (row.state === "failed" || row.state === "cancelled" || row.state === "deleted")
      throw new VideoLifecycleError("unavailable");
    if (
      (row.state === "uploading" || row.state === "uploaded") &&
      row.expiresAt.getTime() <= Date.now()
    )
      throw new VideoLifecycleError("unavailable");
    return row;
  }
  return {
    async begin(authorId: string, byteSize: number) {
      const row = await createVideoUpload(db, authorId, byteSize);
      let multipartId: string | undefined;
      try {
        multipartId = await storage.startMultipart(row.sourceKey);
        if (!(await registerVideoMultipart(db, row.id, authorId, multipartId))) {
          await storage.abortMultipart(row.sourceKey, multipartId);
          throw new VideoLifecycleError("unavailable");
        }
      } catch (error) {
        await cancelVideo(db, row.id, authorId);
        throw error;
      }
      return { id: row.id, byteSize, partBytes: VIDEO_PART_BYTES, expiresAt: row.expiresAt };
    },
    async status(id: string, authorId: string) {
      const row = await owned(id, authorId);
      let completedParts: number[] = [];
      if (row.state === "uploading" && row.multipartId) {
        const size = await storage.sourceSize(row.sourceKey);
        if (size === row.byteSize) {
          completedParts = Array.from(
            { length: Math.ceil(row.byteSize / VIDEO_PART_BYTES) },
            (_, index) => index + 1,
          );
        } else if (size === null) {
          const parts = await storage.listParts(row.sourceKey, row.multipartId);
          completedParts = parts
            .filter((part) => part.byteSize === expectedPartSize(row.byteSize, part.number))
            .map((part) => part.number);
        } else throw new VideoLifecycleError("unavailable");
      }
      return {
        id,
        state: row.state,
        byteSize: row.byteSize,
        partBytes: VIDEO_PART_BYTES,
        completedParts,
        expiresAt: row.expiresAt,
        postId: row.postId,
      };
    },
    async part(id: string, authorId: string, number: number) {
      const row = await owned(id, authorId);
      if (row.state !== "uploading" || !row.multipartId) throw new VideoLifecycleError("not_ready");
      if (
        !Number.isInteger(number) ||
        number < 1 ||
        number > Math.ceil(row.byteSize / VIDEO_PART_BYTES)
      )
        throw new VideoLifecycleError("unavailable");
      return {
        url: await storage.signPart(
          row.sourceKey,
          row.multipartId,
          number,
          expectedPartSize(row.byteSize, number),
        ),
      };
    },
    async finish(id: string, authorId: string) {
      const row = await owned(id, authorId);
      if (row.state !== "uploading") return { id, state: row.state };
      if (!row.multipartId) throw new VideoLifecycleError("not_ready");
      let size = await storage.sourceSize(row.sourceKey);
      if (size === null) {
        const parts = await storage.listParts(row.sourceKey, row.multipartId);
        if (!completeParts(parts, row.byteSize)) throw new VideoLifecycleError("not_ready");
        try {
          await storage.completeMultipart(row.sourceKey, row.multipartId, parts);
        } catch (error) {
          // Completion may have committed before its response was lost, or
          // another completion request may have won. The object proves which.
          if ((await storage.sourceSize(row.sourceKey)) !== row.byteSize) throw error;
        }
        size = await storage.sourceSize(row.sourceKey);
      }
      if (size !== row.byteSize) {
        await cancelVideo(db, id, authorId);
        throw new VideoLifecycleError("unavailable");
      }
      if (!(await completeVideoUpload(db, id, authorId))) {
        const current = await owned(id, authorId);
        if (current.state === "uploading") throw new VideoLifecycleError("not_ready");
      }
      return { id, state: "uploaded" as const };
    },
    cancel(id: string, authorId: string) {
      return cancelVideo(db, id, authorId);
    },
    submit(args: Parameters<typeof submitVideo>[2]) {
      return submitVideo(db, queue, args);
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
