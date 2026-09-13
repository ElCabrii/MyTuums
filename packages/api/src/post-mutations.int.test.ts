import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { post, postAttachment, postEdit, user, video, videoCleanup } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, seedPosts, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("atomic D1 post mutations", () => {
  it("rolls back a failed history write, then records identical concurrent retries once", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    const [original] = await db
      .select({ content: post.content })
      .from(post)
      .where(eq(post.id, target.id));
    const edit = () =>
      call(
        appRouter.post.edit,
        { postId: target.id, content: "Replacement" },
        { context: contextFor(author) },
      );
    await db.run(sql`create trigger reject_edit_test before insert on post_edit
      begin select raise(abort, 'injected edit history failure'); end`);
    try {
      await expect(edit()).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_edit_test`);
    }
    const [unchanged] = await db.select().from(post).where(eq(post.id, target.id));
    expect(unchanged.content).toBe(original.content);
    expect(unchanged.editedAt).toBeNull();
    expect(await db.select().from(postEdit)).toHaveLength(0);
    const results = await Promise.all(Array.from({ length: 6 }, edit));
    const history = await db.select().from(postEdit);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe(original.content);
    expect(
      results.every(
        (result) =>
          result.content === "Replacement" &&
          result.editedAt?.getTime() === history[0].createdAt.getTime(),
      ),
    ).toBe(true);
  });

  it("rolls back a tombstone when video cleanup cannot be recorded, and preserves cleanup after owner deletion", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    const videoId = crypto.randomUUID();
    const streamUid = videoId.replaceAll("-", "");
    await db.insert(video).values({
      id: videoId,
      authorId: author.id,
      postId: target.id,
      byteSize: 100,
      state: "published",
      streamCreatorId: `mytuums-test:${videoId}`,
      streamUid,
      playback: { width: 640, height: 480, duration: 4, captionLanguage: null },
      expiresAt: new Date(Date.now() + 3600000),
    });
    await db.insert(postAttachment).values({
      postId: target.id,
      position: 0,
      videoId,
      mediaPath: `/media/videos/${videoId}/master.m3u8`,
      contentType: "application/vnd.apple.mpegurl",
      byteSize: 100,
      width: 640,
      height: 480,
    });
    const remove = () =>
      call(appRouter.post.delete, { postId: target.id }, { context: contextFor(author) });
    await expect(
      call(appRouter.post.delete, { postId: target.id }, { context: contextFor(stranger) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(videoCleanup)).toHaveLength(0);

    await db.run(sql`create trigger reject_cleanup_test before insert on video_cleanup
      begin select raise(abort, 'injected video cleanup failure'); end`);
    try {
      await expect(remove()).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_cleanup_test`);
    }
    expect((await db.select().from(post).where(eq(post.id, target.id)))[0].deletedAt).toBeNull();
    expect((await db.select().from(video).where(eq(video.id, videoId)))[0].state).toBe("published");
    expect(await db.select().from(postAttachment)).toHaveLength(1);
    expect(await db.select().from(videoCleanup)).toHaveLength(0);
    const first = await remove();
    expect(await remove()).toEqual(first);
    expect(await db.select().from(postAttachment)).toHaveLength(0);
    expect((await db.select().from(video).where(eq(video.id, videoId)))[0]).toMatchObject({
      state: "deleted",
      playback: null,
    });
    await db.delete(user).where(eq(user.id, author.id));
    const debts = await db.select().from(videoCleanup);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ videoId, prefix: `stream-upload/${videoId}`, streamUid });
  });
});
