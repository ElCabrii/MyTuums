import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db, closeDb } from "@my-tuums/db";
import { assertTestDatabase } from "@my-tuums/db/testing";
import {
  notification,
  post,
  postAttachment,
  user,
  video,
  videoCleanup,
  videoSubmission,
} from "@my-tuums/db/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { contextFor, createTestUser, seedPosts, truncateAll } from "./testing/harness.js";
import { createVideoQueue, configureVideoQueues, VIDEO_PROCESS_QUEUE } from "./video-queue.js";
import {
  cancelVideo,
  claimVideo,
  completeVideoUpload,
  confirmVideoSourceDeleted,
  createVideoUpload,
  failVideoWork,
  finishVideoEncoding,
  publishVideo,
  renewVideoLease,
  submitVideo,
  type VideoWork,
} from "./video-lifecycle.js";

const queue = createVideoQueue(db, false);
beforeAll(async () => {
  assertTestDatabase();
  await queue.start();
  await configureVideoQueues(queue);
});
beforeEach(async () => {
  await queue.deleteAllJobs();
  await truncateAll();
});
afterAll(async () => {
  await queue.deleteAllJobs();
  await queue.stop();
  await truncateAll();
  await closeDb();
});

async function submittedVideo(authorId: string, parentId: string | null = null) {
  const upload = await createVideoUpload(db, authorId, 1000);
  await completeVideoUpload(db, upload.id, authorId);
  const submission = await submitVideo(db, queue, {
    videoId: upload.id,
    authorId,
    content: "private pending text",
    parentId,
    quotedPostId: null,
    isPrivate: false,
    caption: "WEBVTT\n\n00:00.000 --> 00:01.000\nprivate caption",
    captionLanguage: "en",
  });
  return { upload, submission };
}

async function encodedVideo(work: VideoWork) {
  expect(
    await finishVideoEncoding(
      db,
      work,
      {
        width: 640,
        height: 360,
        duration: 6,
        frameRate: 30,
        renditions: [{ name: "360", width: 640, height: 360, frameRate: 30, bandwidth: 1_128_000 }],
      },
      [{ name: "master.m3u8", contentType: "application/vnd.apple.mpegurl", byteSize: 100 }],
    ),
  ).toBe(true);
}

describe("video lifecycle (issue #368)", () => {
  it("persists the recurring cleanup schedule through the application database adapter", async () => {
    await queue.schedule("video-maintenance", "* * * * *");
    expect(await queue.getSchedules("video-maintenance")).toMatchObject([
      { name: "video-maintenance", cron: "* * * * *" },
    ]);
    await queue.unschedule("video-maintenance");
  });
  it("stores nothing publicly until upload, explicit submission, encoding and source deletion complete", async () => {
    const author = await createTestUser();
    const target = await createTestUser();
    const [parent] = await seedPosts(target.id, 1);
    const { upload, submission } = await submittedVideo(author.id, parent.id);
    expect(await db.select().from(post).where(eq(post.authorId, author.id))).toEqual([]);
    expect(await db.select().from(notification)).toEqual([]);
    const [job] = await queue.fetch<{ videoId: string }>(VIDEO_PROCESS_QUEUE);
    expect(job?.data).toEqual({ videoId: upload.id });
    const work = await claimVideo(db, upload.id);
    expect(work).not.toBeNull();
    if (!work) throw new Error("Expected processing work.");
    await encodedVideo(work);
    expect(await publishVideo(db, work)).toBe(false);
    if (job) await queue.complete(VIDEO_PROCESS_QUEUE, [job.id]);
    await confirmVideoSourceDeleted(db, work);
    expect(await publishVideo(db, work)).toBe(true);
    expect(await publishVideo(db, work)).toBe(false);
    const [published] = await db.select().from(post).where(eq(post.id, submission.id));
    expect(published).toMatchObject({ content: "private pending text", parentId: parent.id });
    expect(published?.createdAt.getTime()).toBeGreaterThanOrEqual(upload.createdAt.getTime());
    expect(await db.select().from(videoSubmission)).toEqual([]);
    expect(await db.select().from(notification)).toMatchObject([
      { type: "reply", recipientId: target.id, postId: submission.id },
    ]);
    expect(await db.select().from(postAttachment)).toMatchObject([
      { postId: submission.id, videoId: upload.id },
    ]);
  });

  it("rolls back pending text when queue scheduling fails", async () => {
    const author = await createTestUser();
    const upload = await createVideoUpload(db, author.id, 1000);
    await completeVideoUpload(db, upload.id, author.id);
    await expect(
      submitVideo(
        db,
        {
          send: () => Promise.reject(new Error("queue unavailable")),
        },
        {
          videoId: upload.id,
          authorId: author.id,
          content: "must roll back",
          parentId: null,
          quotedPostId: null,
          isPrivate: false,
          caption: null,
          captionLanguage: null,
        },
      ),
    ).rejects.toThrow("queue unavailable");
    expect(await db.select().from(videoSubmission)).toEqual([]);
    expect(await db.select().from(video)).toMatchObject([{ state: "uploaded" }]);
  });

  it("fences duplicate deliveries and an expired worker after another worker takes over", async () => {
    const author = await createTestUser();
    const { upload } = await submittedVideo(author.id);
    const first = await claimVideo(db, upload.id);
    if (!first) throw new Error("Expected first work.");
    expect(await claimVideo(db, upload.id)).toBeNull();
    await db
      .update(video)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(video.id, upload.id));
    const second = await claimVideo(db, upload.id);
    if (!second) throw new Error("Expected replacement work.");
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(await renewVideoLease(db, first)).toBe(false);
    expect(await failVideoWork(db, first, false)).toBe(true);
    expect(await db.select().from(video)).toMatchObject([
      { state: "processing", attemptId: second.attemptId },
    ]);
    expect(await db.select().from(videoCleanup)).toMatchObject([{ prefix: first.prefix }]);
  });

  it("erases failed text and captions and leaves exactly one durable, link-free notification", async () => {
    const author = await createTestUser();
    const { upload } = await submittedVideo(author.id);
    const work = await claimVideo(db, upload.id);
    if (!work) throw new Error("Expected work.");
    await Promise.all([failVideoWork(db, work, false), failVideoWork(db, work, false)]);
    expect(await db.select().from(videoSubmission)).toEqual([]);
    expect(await db.select().from(post)).toEqual([]);
    expect(await db.select().from(videoCleanup)).toMatchObject([
      { videoId: upload.id, sourceKey: upload.sourceKey },
    ]);
    const page = await call(appRouter.notification.list, {}, { context: contextFor(author) });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ type: "video_failed", actor: null, postId: null });
    expect(await db.select({ actionId: notification.actionId }).from(notification)).toEqual([
      { actionId: null },
    ]);
    await db.delete(video).where(eq(video.id, upload.id));
    expect(await db.select().from(notification)).toHaveLength(1);
    expect(await db.select().from(videoCleanup)).toHaveLength(1);
  });

  it("cancellation prevents in-flight publication and sends no failure notification", async () => {
    const author = await createTestUser();
    const { upload } = await submittedVideo(author.id);
    const work = await claimVideo(db, upload.id);
    if (!work) throw new Error("Expected work.");
    await encodedVideo(work);
    await confirmVideoSourceDeleted(db, work);
    await cancelVideo(db, upload.id, author.id);
    expect(await publishVideo(db, work)).toBe(false);
    expect(await db.select().from(post)).toEqual([]);
    expect(await db.select().from(videoSubmission)).toEqual([]);
    expect(await db.select().from(notification)).toEqual([]);
  });

  it("an account cascade removes pending content while retaining the keys needed for cleanup", async () => {
    const author = await createTestUser();
    const { upload } = await submittedVideo(author.id);
    const work = await claimVideo(db, upload.id);
    if (!work) throw new Error("Expected work.");
    await db.delete(user).where(eq(user.id, author.id));
    expect(await renewVideoLease(db, work)).toBe(false);
    expect(await publishVideo(db, work)).toBe(false);
    expect(await db.select().from(videoSubmission)).toEqual([]);
    expect(await db.select().from(video)).toMatchObject([
      { authorId: null, sourceKey: upload.sourceKey },
    ]);
  });

  it("retries transient processing failures, then fails after the bounded attempt budget", async () => {
    const author = await createTestUser();
    const { upload } = await submittedVideo(author.id);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const work = await claimVideo(db, upload.id);
      if (!work) throw new Error("Expected retry work.");
      expect(await failVideoWork(db, work, true)).toBe(attempt === 3);
    }
    expect(await claimVideo(db, upload.id)).toBeNull();
    expect(await db.select().from(videoSubmission)).toEqual([]);
    expect(await db.select().from(notification)).toHaveLength(1);
  });

  it("rechecks account eligibility at publication and keeps ordinary deletion atomic with cleanup debt", async () => {
    const author = await createTestUser();
    const first = await submittedVideo(author.id);
    const work = await claimVideo(db, first.upload.id);
    if (!work) throw new Error("Expected work.");
    await encodedVideo(work);
    await confirmVideoSourceDeleted(db, work);
    await db.update(user).set({ banned: true }).where(eq(user.id, author.id));
    expect(await publishVideo(db, work)).toBe(false);
    expect(await db.select().from(post)).toEqual([]);
    await db.update(user).set({ banned: false }).where(eq(user.id, author.id));
    const second = await submittedVideo(author.id);
    const next = await claimVideo(db, second.upload.id);
    if (!next) throw new Error("Expected second work.");
    await encodedVideo(next);
    await confirmVideoSourceDeleted(db, next);
    await publishVideo(db, next);
    await call(
      appRouter.post.delete,
      { postId: second.submission.id },
      { context: contextFor(author) },
    );
    expect(await db.select().from(postAttachment)).toEqual([]);
    expect(
      await db.select().from(videoCleanup).where(eq(videoCleanup.videoId, second.upload.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(post)
        .where(and(eq(post.id, second.submission.id), sql`${post.deletedAt} is not null`)),
    ).toHaveLength(1);
  });
});
