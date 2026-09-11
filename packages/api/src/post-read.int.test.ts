import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { follow, post, postAttachment, video } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";
import { postAttachmentsSelection } from "./post-media.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("D1 post read contracts", () => {
  it("decodes nested previews and preserves private-parent and private-quote gates", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const rootId = crypto.randomUUID();
    const replyId = crypto.randomUUID();
    const quoteId = crypto.randomUUID();
    await db.insert(post).values({ id: rootId, authorId: author.id, content: "🌍".repeat(141) });
    await db.insert(post).values([
      { id: replyId, authorId: viewer.id, parentId: rootId, content: "Reply" },
      { id: quoteId, authorId: viewer.id, quotedPostId: rootId, content: "Quote" },
    ]);
    const attachmentIds = [crypto.randomUUID(), crypto.randomUUID()];
    await db.insert(postAttachment).values(
      [1, 0].map((position) => ({
        id: attachmentIds[position],
        postId: rootId,
        position,
        mediaPath: `/media/posts/${author.id}/${rootId}/${attachmentIds[position]}.png`,
        contentType: "image/png",
        byteSize: 1,
        width: 1,
        height: 1,
      })),
    );
    const read = () =>
      call(
        appRouter.post.list,
        {
          authorId: viewer.id,
          includeReplies: true,
        },
        { context: contextFor(viewer) },
      );
    const publicRead = await read();
    expect(publicRead.items.find((row) => row.id === replyId)).toMatchObject({
      removed: false,
      deleted: false,
      unavailable: false,
      private: false,
      viewerHasLiked: false,
      viewerHasReposted: false,
      viewerHasBookmarked: false,
      parentPrivate: false,
      parent: { excerpt: "🌍".repeat(140), truncated: true, removed: false },
    });
    const quoted = publicRead.items.find((row) => row.id === quoteId);
    expect(quoted?.createdAt).toBeInstanceOf(Date);
    expect(quoted?.quoted).toMatchObject({
      removed: false,
      deleted: false,
      removedReason: null,
      attachments: attachmentIds.map((id, position) => ({ id, position })),
    });

    await db.update(post).set({ isPrivate: true }).where(eq(post.id, rootId));
    const privateRead = await read();
    expect(privateRead.items.find((row) => row.id === replyId)).toMatchObject({
      parent: null,
      parentPrivate: true,
    });
    expect(privateRead.items.find((row) => row.id === quoteId)).toMatchObject({
      quoted: null,
      quotedPrivate: true,
    });
    await db.insert(follow).values({ followerId: viewer.id, followingId: author.id });
    const followerRead = await read();
    expect(followerRead.items.find((row) => row.id === replyId)?.parent?.excerpt).toBe(
      "🌍".repeat(140),
    );
    expect(followerRead.items.find((row) => row.id === quoteId)?.quoted?.attachments).toHaveLength(
      2,
    );
  });

  it("preserves nullable playback fields and JSON arrays in the attachment projection", async () => {
    const author = await createTestUser();
    const [published] = await db
      .insert(post)
      .values({ authorId: author.id, content: "Video" })
      .returning();
    const videoId = crypto.randomUUID();
    const playback = {
      width: 640,
      height: 360,
      duration: 4,
      captionLanguage: null,
    };
    await db.insert(video).values({
      id: videoId,
      authorId: author.id,
      postId: published.id,
      state: "published",
      byteSize: 100,
      streamCreatorId: `mytuums-poc:${videoId}`,
      streamUid: videoId.replaceAll("-", ""),
      expiresAt: new Date(),
      playback,
    });
    await db.insert(postAttachment).values({
      postId: published.id,
      videoId,
      position: 0,
      mediaPath: `/media/videos/${videoId}/master.m3u8`,
      contentType: "application/vnd.apple.mpegurl",
      byteSize: 100,
      width: 640,
      height: 360,
    });
    const [projection] = await db
      .select({ attachments: postAttachmentsSelection() })
      .from(post)
      .where(eq(post.id, published.id));
    expect(projection.attachments[0].video).toEqual({
      duration: 4,
      posterUrl: `/media/videos/${videoId}/cover.jpg`,
      previewUrl: `/media/videos/${videoId}/previews.vtt`,
      captionUrl: null,
      captionLanguage: null,
    });
  });
});
