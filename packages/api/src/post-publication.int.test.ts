import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notification, post, postAttachment, postMediaUpload, user } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { createTestUser, testStorage, testStorageObjects, truncateAll } from "./testing/harness.js";
import { publishPost } from "./post-publication.js";
import {
  beginPostMediaUpload,
  cleanupExpiredPostMediaUploads,
  readPostMediaReferences,
} from "./post-media-upload.js";
import { postAttachmentRows, preparePostAttachments, writePostAttachments } from "./post-media.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("D1 post publication", () => {
  it("commits a reply and its notice together and suppresses self-notices", async () => {
    const author = await createTestUser();
    const recipient = await createTestUser();
    const [parent] = await db
      .insert(post)
      .values({ authorId: recipient.id, content: "Parent" })
      .returning();
    const postId = crypto.randomUUID();
    await publishPost(db, {
      postId,
      authorId: author.id,
      content: "Reply",
      parentId: parent.id,
      parentAuthorId: recipient.id,
      quotedPostId: null,
      isPrivate: false,
      attachments: [],
    });
    expect(
      await db.select().from(notification).where(eq(notification.postId, postId)),
    ).toMatchObject([{ recipientId: recipient.id, actorId: author.id, type: "reply" }]);
    const selfReplyId = crypto.randomUUID();
    await publishPost(db, {
      postId: selfReplyId,
      authorId: recipient.id,
      content: "Self reply",
      parentId: parent.id,
      parentAuthorId: recipient.id,
      quotedPostId: null,
      isPrivate: false,
      attachments: [],
    });
    expect(
      await db.select().from(notification).where(eq(notification.postId, selfReplyId)),
    ).toEqual([]);
  });

  it("rolls back attachments and the post when a later notice cannot commit", async () => {
    const author = await createTestUser();
    const postId = crypto.randomUUID();
    const prepared = preparePostAttachments(author.id, postId, [
      { bytes: new Uint8Array([1]), type: "image/png", width: 1, height: 1 },
    ]);
    await beginPostMediaUpload(
      db,
      postId,
      prepared.map(({ key }) => key),
    );
    await expect(
      publishPost(db, {
        postId,
        authorId: author.id,
        content: "Atomic failure",
        parentId: null,
        quotedPostId: null,
        quotedAuthorId: "deleted-recipient",
        isPrivate: false,
        attachments: postAttachmentRows(prepared),
        imageUpload: true,
      }),
    ).rejects.toThrow();
    expect(await db.select().from(post).where(eq(post.id, postId))).toEqual([]);
    expect(await db.select().from(postAttachment).where(eq(postAttachment.postId, postId))).toEqual(
      [],
    );
    expect(
      await db.select().from(postMediaUpload).where(eq(postMediaUpload.postId, postId)),
    ).toHaveLength(1);
  });

  it("consumes an upload only when publication succeeds, and rejects expired publication", async () => {
    const author = await createTestUser();
    const postId = crypto.randomUUID();
    const prepared = preparePostAttachments(author.id, postId, [
      { bytes: new Uint8Array([1]), type: "image/png", width: 1, height: 1 },
    ]);
    await beginPostMediaUpload(
      db,
      postId,
      prepared.map(({ key }) => key),
    );
    const args = {
      postId,
      authorId: author.id,
      content: "Image",
      parentId: null,
      quotedPostId: null,
      isPrivate: false,
      attachments: postAttachmentRows(prepared),
      imageUpload: true,
    };
    await db
      .update(postMediaUpload)
      .set({ expiresAt: new Date(0) })
      .where(eq(postMediaUpload.postId, postId));
    await expect(publishPost(db, args)).rejects.toThrow();
    expect(await db.select().from(post).where(eq(post.id, postId))).toEqual([]);
    await db
      .update(postMediaUpload)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(postMediaUpload.postId, postId));
    await publishPost(db, args);
    expect(
      await db.select().from(postMediaUpload).where(eq(postMediaUpload.postId, postId)),
    ).toEqual([]);
    expect(await readPostMediaReferences(db)).toEqual([{ mediaPath: prepared[0].mediaPath }]);
  });

  it("retains cleanup across account deletion and retries a storage failure", async () => {
    const author = await createTestUser();
    const postId = crypto.randomUUID();
    const prepared = preparePostAttachments(author.id, postId, [
      { bytes: new Uint8Array([1]), type: "image/png", width: 1, height: 1 },
    ]);
    await beginPostMediaUpload(
      db,
      postId,
      prepared.map(({ key }) => key),
    );
    await writePostAttachments(testStorage, prepared);
    await db.delete(user).where(eq(user.id, author.id));
    await db
      .update(postMediaUpload)
      .set({ expiresAt: new Date(0) })
      .where(eq(postMediaUpload.postId, postId));
    await expect(
      cleanupExpiredPostMediaUploads(db, {
        ...testStorage,
        remove: () => Promise.reject(new Error("storage unavailable")),
      }),
    ).rejects.toThrow("storage unavailable");
    expect(await db.select().from(postMediaUpload)).toHaveLength(1);
    expect(await cleanupExpiredPostMediaUploads(db, testStorage)).toBe(1);
    expect(testStorageObjects.has(prepared[0].key)).toBe(false);
    expect(await db.select().from(postMediaUpload)).toEqual([]);
  });
});
