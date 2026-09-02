import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { closeDb } from "@my-tuums/db";
import { post, postAttachment, postEdit, user } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  POST_MAX_LENGTH,
  POST_PAGE_SIZE,
  POST_PAGE_SIZE_MAX,
  THREAD_ANCESTOR_MAX,
  THREAD_REPLY_BRANCH_INITIAL_SIZE,
  THREAD_REPLY_BRANCH_CHILD_FANOUT,
} from "./constants.js";
import type { Context } from "./context.js";
import { withPostMediaLifecycleLock } from "./post-media-lock.js";
import { appRouter } from "./router.js";
import { runSql } from "./sql.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  seedPosts,
  setUserRole,
  testStorage,
  testStorageObjects,
  truncateAll,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

// No per-test rate-limit reset needed here — testing/harness.ts registers
// its own beforeEach that gives every test in this file a fresh, isolated
// RateLimiter automatically (see the comment on `currentTestRateLimiter`).

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** A genuine 2x2 PNG; post uploads validate the complete container. */
const POST_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function postImage(name: string): File {
  return new File([POST_PNG], name, { type: "image/png" });
}

/**
 * A user promoted to moderator through the row, re-fetched so the session
 * carries the role — the same helper moderation.int.test.ts uses, local to
 * this file because `moderation.case` is read exactly once below.
 */
async function moderatorUser() {
  const user = await createTestUser();
  await setUserRole(user.id, "moderator");
  return freshSessionFor(user);
}

/** Little-endian byte pair for a 16-bit value, the way GIF stores widths/heights/delays. */
function le16(value: number): [number, number] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

/**
 * Builds a minimal well-formed GIF: a 13-byte header (no Global Color Table),
 * then for each frame an optional Graphic Control Extension (its delay), an
 * Image Descriptor, and an empty image-data sub-block sequence, then the 0x3B
 * trailer. The server walks block structure only, so the image-data sub-blocks
 * carry no real compressed pixels.
 */
function buildGif(
  logicalScreen: { width: number; height: number },
  frames: ReadonlyArray<{ width: number; height: number; delayCs?: number }>,
): Uint8Array {
  const bytes: number[] = [
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    ...le16(logicalScreen.width),
    ...le16(logicalScreen.height),
    0x00,
    0x00,
    0x00,
  ];
  for (const frame of frames) {
    if (frame.delayCs !== undefined) {
      bytes.push(0x21, 0xf9, 0x04, 0x00, ...le16(frame.delayCs), 0x00, 0x00);
    }
    bytes.push(0x2c, ...le16(0), ...le16(0), ...le16(frame.width), ...le16(frame.height), 0x00);
    bytes.push(0x02, 0x00);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

/** A file whose bytes really are a GIF, which is what the server sniffs for. */
function postGif(
  name: string,
  logicalScreen: { width: number; height: number },
  frames: ReadonlyArray<{ width: number; height: number; delayCs?: number }>,
): File {
  return new File([buildGif(logicalScreen, frames)], name, { type: "image/gif" });
}

interface ListArgs {
  authorId?: string;
  parentId?: string;
  includeReplies?: boolean;
  kind?: "posts" | "replies" | "all";
  feed?: "global" | "following";
  limit?: number;
}

/** Walks `post.list` to exhaustion via `nextCursor`, collecting every id it returns. */
async function walkAllPostPages(args: ListArgs, context: Context): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await call(appRouter.post.list, { ...args, cursor }, { context });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) {
      throw new Error("walkAllPostPages: exceeded 500 pages — pagination looks like it's looping.");
    }
  } while (cursor);

  return ids;
}

/** Builds a linear reply chain of `depth` replies on top of a fresh root post. Returns ids root-first. */
async function buildChain(authorId: string, depth: number): Promise<string[]> {
  const ids: string[] = [];
  let parentId: string | undefined;

  for (let i = 0; i <= depth; i++) {
    const [row] = await seedPosts(authorId, 1, parentId ? { parentId } : {});
    ids.push(row.id);
    parentId = row.id;
  }

  return ids;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    resolve: () => {
      if (!resolve) throw new Error("Deferred promise was not initialized");
      resolve();
    },
  };
}

/** Waits until another connection is blocked on this test's post-row lock. */
async function waitForPostLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await runSql<{ blocked: boolean }>(
      anonContext.db,
      sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE 'update "post" set%'
      ) AS blocked
    `,
    );
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Author deletion never reached the held post-row lock");
}

/** Waits until a post attachment writer is blocked by the shared media lock. */
async function waitForPostMediaLifecycleLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await runSql<{ blocked: boolean }>(
      anonContext.db,
      sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%pg_advisory_xact_lock%'
      ) AS blocked
    `,
    );
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Post attachment creation never reached the held media lifecycle lock");
}

describe("post.create", () => {
  it("rejects a submission carrying neither text nor attachments — trimming first is what keeps whitespace from persisting as fake content", async () => {
    const author = await createTestUser();
    await expect(
      call(appRouter.post.create, { content: "   \n\t  " }, { context: contextFor(author) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts an image-only post: blank text plus a valid attachment stores content as ''", async () => {
    const author = await createTestUser();
    const created = await call(
      appRouter.post.create,
      { content: "   \n\t ", attachments: [postImage("solo.png")] },
      { context: contextFor(author) },
    );

    // Whitespace is not persisted as fake content — the column reads "".
    expect(created.content).toBe("");
    expect(created.attachments).toHaveLength(1);

    const listed = await call(appRouter.post.list, {}, { context: contextFor(author) });
    const row = listed.items.find((item) => item.id === created.id);
    expect(row?.content).toBe("");
    expect(row?.attachments).toHaveLength(1);
  });

  it("accepts an animated GIF attachment and stores it under the gif extension", async () => {
    // The post_attachment content_type check constraint was extended to allow
    // 'image/gif' (issue #201); this is the one test that exercises the DB
    // constraint, since the profile path writes to a free-text column.
    const author = await createTestUser();
    const created = await call(
      appRouter.post.create,
      {
        content: "",
        attachments: [
          postGif("solo.gif", { width: 256, height: 128 }, [
            { width: 256, height: 128, delayCs: 20 },
          ]),
        ],
      },
      { context: contextFor(author) },
    );

    expect(created.attachments).toHaveLength(1);
    const [attachment] = created.attachments;
    expect(attachment.contentType).toBe("image/gif");
    expect(attachment.url).toMatch(/\.gif$/);
    expect(attachment.width).toBe(256);
    expect(attachment.height).toBe(128);
    expect(testStorageObjects.get(attachment.url.replace("/media/", ""))?.contentType).toBe(
      "image/gif",
    );
  });

  it("accepts an image-only reply and lists it under its parent and the author's replies", async () => {
    const author = await createTestUser();
    const parent = await call(
      appRouter.post.create,
      { content: "parent" },
      { context: contextFor(author) },
    );
    const reply = await call(
      appRouter.post.create,
      { content: "", parentId: parent.id, attachments: [postImage("reply.png")] },
      { context: contextFor(author) },
    );

    expect(reply.content).toBe("");

    const directReplies = await call(
      appRouter.post.list,
      { parentId: parent.id },
      { context: contextFor(author) },
    );
    expect(directReplies.items.map((item) => item.id)).toEqual([reply.id]);

    const activity = await call(
      appRouter.post.list,
      { authorId: author.id, kind: "replies" },
      { context: contextFor(author) },
    );
    expect(activity.items.find((item) => item.id === reply.id)?.attachments).toHaveLength(1);
  });

  it("rejects content one character over POST_MAX_LENGTH", async () => {
    const author = await createTestUser();
    await expect(
      call(
        appRouter.post.create,
        { content: "a".repeat(POST_MAX_LENGTH + 1) },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("accepts content exactly at POST_MAX_LENGTH", async () => {
    const author = await createTestUser();
    const content = "a".repeat(POST_MAX_LENGTH);
    const created = await call(appRouter.post.create, { content }, { context: contextFor(author) });
    expect(created.content).toHaveLength(POST_MAX_LENGTH);
  });

  it("reports likeCount: 0, replyCount: 0, viewerHasLiked: false on a brand-new post", async () => {
    const author = await createTestUser();
    const created = await call(
      appRouter.post.create,
      { content: "fresh" },
      { context: contextFor(author) },
    );

    expect(created.likeCount).toBe(0);
    expect(created.replyCount).toBe(0);
    expect(created.viewerHasLiked).toBe(false);
  });

  it("stores ordered post and reply attachments and returns the authoritative projection", async () => {
    const author = await createTestUser();
    const parent = await call(
      appRouter.post.create,
      { content: "with images", attachments: [postImage("first.png"), postImage("second.png")] },
      { context: contextFor(author) },
    );
    const reply = await call(
      appRouter.post.create,
      { content: "reply image", parentId: parent.id, attachments: [postImage("reply.png")] },
      { context: contextFor(author) },
    );

    expect(parent.attachments).toHaveLength(2);
    expect(parent.attachments.map((attachment) => attachment.position)).toEqual([0, 1]);
    expect(parent.attachments.every((attachment) => attachment.width === 2)).toBe(true);
    expect(reply.attachments).toHaveLength(1);

    const rows = await anonContext.db
      .select({ postId: postAttachment.postId, position: postAttachment.position })
      .from(postAttachment)
      .where(eq(postAttachment.postId, parent.id));
    expect(rows.map((row) => row.position).sort()).toEqual([0, 1]);
    expect(
      [...testStorageObjects.keys()].filter((key) =>
        key.startsWith(`posts/${author.id}/${parent.id}/`),
      ),
    ).toHaveLength(2);

    const listed = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(author) },
    );
    expect(listed.items.find((item) => item.id === parent.id)?.attachments).toEqual(
      parent.attachments,
    );
  });

  it("rejects a file whose declared type disagrees with its bytes before writing storage", async () => {
    const author = await createTestUser();
    const mislabeled = new File([POST_PNG], "not-jpeg.jpg", { type: "image/jpeg" });

    await expect(
      call(
        appRouter.post.create,
        { content: "bad image", attachments: [mislabeled] },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(testStorageObjects.size).toBe(0);
  });

  it("cleans objects when storage fails after a PUT has committed", async () => {
    const author = await createTestUser();
    const failingStorage = {
      ...testStorage,
      put: async (key: string, bytes: Uint8Array, contentType: string) => {
        await testStorage.put(key, bytes, contentType);
        throw new Error("storage acknowledgement lost");
      },
    };

    await expect(
      call(
        appRouter.post.create,
        { content: "storage failure", attachments: [postImage("failed.png")] },
        { context: contextFor(author, author.context.rateLimiter, failingStorage) },
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(testStorageObjects.size).toBe(0);
  });

  it("holds the media lifecycle lock through upload and attachment-row commit", async () => {
    const author = await createTestUser();
    const holderReady = deferred();
    const releaseHolder = deferred();
    const holder = withPostMediaLifecycleLock(anonContext.db, async () => {
      holderReady.resolve();
      await releaseHolder.promise;
    });

    await holderReady.promise;
    const creation = call(
      appRouter.post.create,
      { content: "serialized image", attachments: [postImage("serialized.png")] },
      { context: contextFor(author) },
    );

    try {
      await waitForPostMediaLifecycleLockWait();
      // The writer has not reached storage.put while the reconciler-equivalent
      // lock holder is active. Once released, upload and row commit happen in
      // the same transaction that acquired the lock.
      expect(testStorageObjects.size).toBe(0);
    } finally {
      releaseHolder.resolve();
    }

    await holder;
    const created = await creation;
    expect(created.attachments).toHaveLength(1);
    expect(testStorageObjects.size).toBe(1);
  });

  it("replying to a parentId that doesn't exist is NOT_FOUND", async () => {
    const author = await createTestUser();
    await expect(
      call(
        appRouter.post.create,
        { content: "orphan reply", parentId: randomUUID() },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("post.delete", () => {
  it("is NOT_FOUND for a post that doesn't exist", async () => {
    const author = await createTestUser();

    await expect(
      call(appRouter.post.delete, { postId: randomUUID() }, { context: contextFor(author) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses someone else's post and leaves it readable — ownership is server-enforced", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await expect(
      call(appRouter.post.delete, { postId: target.id }, { context: contextFor(stranger) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const thread = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(stranger) },
    );
    expect(thread.post.deleted).toBe(false);
    expect(thread.post.content).not.toBeNull();
  });

  it("tombstones the author's own post: the row stays, the content nulls for everyone", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    const attachmentPath = `/media/posts/${author.id}/${target.id}/${randomUUID()}.png`;
    await anonContext.db.insert(postAttachment).values({
      postId: target.id,
      position: 0,
      mediaPath: attachmentPath,
      contentType: "image/png",
      byteSize: POST_PNG.byteLength,
      width: 2,
      height: 2,
    });
    await testStorage.put(attachmentPath.replace("/media/", ""), POST_PNG, "image/png");

    const result = await call(
      appRouter.post.delete,
      { postId: target.id },
      { context: contextFor(author) },
    );
    expect(result.postId).toBe(target.id);
    expect(result.deletedAt).toBeInstanceOf(Date);

    // Still a row — a hard delete would cascade the reply subtree away.
    const [row] = await anonContext.db
      .select({ content: post.content, deletedAt: post.deletedAt })
      .from(post)
      .where(eq(post.id, target.id));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.content).not.toBeNull();

    // Fresh feeds no longer include the tombstone, regardless of viewer.
    for (const context of [contextFor(author), contextFor(viewer)]) {
      const feed = await call(appRouter.post.list, { feed: "global" }, { context });
      expect(feed.items.some((item) => item.id === target.id)).toBe(false);
    }

    await call(appRouter.user.follow, { userId: author.id }, { context: contextFor(viewer) });
    const following = await call(
      appRouter.post.list,
      { feed: "following" },
      { context: contextFor(viewer) },
    );
    expect(following.items.some((item) => item.id === target.id)).toBe(false);

    const deletedAttachments = await anonContext.db
      .select({ mediaPath: postAttachment.mediaPath })
      .from(postAttachment)
      .where(eq(postAttachment.postId, target.id));
    expect(deletedAttachments).toEqual([]);
    expect(testStorageObjects.has(attachmentPath.replace("/media/", ""))).toBe(false);

    const thread = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(viewer) },
    );
    expect(thread.post.deleted).toBe(true);
    expect(thread.post.content).toBeNull();
  });

  it("keeps the conversation: replies survive with their content and stay listed under the deleted parent", async () => {
    const author = await createTestUser();
    const replier = await createTestUser();
    const [parent] = await seedPosts(author.id, 1);
    const replies = await seedPosts(replier.id, 2, { parentId: parent.id });

    await call(appRouter.post.delete, { postId: parent.id }, { context: contextFor(author) });

    const listed = await call(
      appRouter.post.list,
      { parentId: parent.id },
      { context: contextFor(replier) },
    );
    expect(listed.items.map((item) => item.id).sort()).toEqual(replies.map((r) => r.id).sort());
    for (const item of listed.items) {
      expect(item.deleted).toBe(false);
      expect(item.content).not.toBeNull();
    }

    // The deleted parent is still the reply's ancestor, so the thread above a
    // reply reads as a conversation with a stub in it, not a broken chain.
    const thread = await call(
      appRouter.post.thread,
      { postId: replies[0].id },
      { context: contextFor(replier) },
    );
    expect(thread.ancestors.map((a) => a.id)).toEqual([parent.id]);
    expect(thread.ancestors[0]?.deleted).toBe(true);
  });

  it("excludes author-deleted replies from replyCount but still counts moderator-removed ones", async () => {
    const author = await createTestUser();
    const replier = await createTestUser();
    const [parent] = await seedPosts(author.id, 1);
    const replies = await seedPosts(replier.id, 3, { parentId: parent.id });

    const countFor = async () =>
      call(appRouter.post.thread, { postId: parent.id }, { context: contextFor(author) }).then(
        (r) => r.post.replyCount,
      );

    // Baseline: every reply is live, so the count matches the reply feed.
    expect(await countFor()).toBe(3);

    // An author-deleted reply drops out of both the feed and the count.
    await call(appRouter.post.delete, { postId: replies[0].id }, { context: contextFor(replier) });

    const afterDelete = await call(
      appRouter.post.list,
      { parentId: parent.id },
      { context: contextFor(author) },
    );
    expect(afterDelete.items.map((item) => item.id).sort()).toEqual(
      [replies[1].id, replies[2].id].sort(),
    );
    expect(await countFor()).toBe(2);

    // A moderator-removed reply stays in the feed as a tombstone card and is
    // still counted — removal is not invisibility.
    await anonContext.db
      .update(post)
      .set({ removedAt: new Date(), removedReason: "policy" })
      .where(eq(post.id, replies[1].id));

    const afterRemove = await call(
      appRouter.post.list,
      { parentId: parent.id },
      { context: contextFor(author) },
    );
    expect(afterRemove.items.map((item) => item.id).sort()).toEqual(
      [replies[1].id, replies[2].id].sort(),
    );
    expect(afterRemove.items.find((item) => item.id === replies[1].id)?.removed).toBe(true);
    expect(await countFor()).toBe(2);
  });

  it("hides the post from its author's profile while preserving its likes and other posts", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target, survivor] = await seedPosts(author.id, 2);
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });

    await call(appRouter.post.delete, { postId: target.id }, { context: contextFor(author) });

    const feed = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(liker) },
    );
    expect(feed.items.some((item) => item.id === target.id)).toBe(false);

    const survivorItem = feed.items.find((p) => p.id === survivor.id);
    expect(survivorItem?.deleted).toBe(false);
    expect(survivorItem?.content).not.toBeNull();

    const thread = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(liker) },
    );
    expect(thread.post.likeCount).toBe(1);
    expect(thread.post.viewerHasLiked).toBe(true);
  });

  it("deleting one author's post leaves another author's alone", async () => {
    const author = await createTestUser();
    const other = await createTestUser();
    const [mine] = await seedPosts(author.id, 1);
    const [theirs] = await seedPosts(other.id, 1);

    await call(appRouter.post.delete, { postId: mine.id }, { context: contextFor(author) });

    const thread = await call(
      appRouter.post.thread,
      { postId: theirs.id },
      { context: contextFor(author) },
    );
    expect(thread.post.deleted).toBe(false);
    expect(thread.post.content).not.toBeNull();
  });

  it("is idempotent: a repeat keeps the original tombstone rather than restamping it", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const first = await call(
      appRouter.post.delete,
      { postId: target.id },
      { context: contextFor(author) },
    );
    const second = await call(
      appRouter.post.delete,
      { postId: target.id },
      { context: contextFor(author) },
    );

    expect(second.deletedAt.getTime()).toBe(first.deletedAt.getTime());
  });

  it("refuses a post a moderator already removed, so the author keeps the reason and the appeal link", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    // The removal state is what the guard reads; how it got there belongs to
    // moderation.int.test.ts, so this stamps it directly.
    await anonContext.db
      .update(post)
      .set({ removedAt: new Date(), removedReason: "spam" })
      .where(eq(post.id, target.id));

    await expect(
      call(appRouter.post.delete, { postId: target.id }, { context: contextFor(author) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const feed = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(author) },
    );
    const item = feed.items.find((p) => p.id === target.id);
    expect(item?.removed).toBe(true);
    expect(item?.deleted).toBe(false);
    expect(item?.removedReason).toBe("spam");
  });

  it("refuses when moderator removal commits after the guard read but before the tombstone update", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    const holderReady = deferred();
    const releaseHolder = deferred();
    const holder = anonContext.db.transaction(async (tx) => {
      await tx
        .update(post)
        .set({ removedAt: new Date(), removedReason: "spam" })
        .where(eq(post.id, target.id));
      holderReady.resolve();
      await releaseHolder.promise;
    });

    await holderReady.promise;
    const deletion = call(
      appRouter.post.delete,
      { postId: target.id },
      {
        context: contextFor(author),
      },
    );

    try {
      await waitForPostLockWait();
    } finally {
      releaseHolder.resolve();
    }
    await holder;

    await expect(deletion).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This post was removed by a moderator and can no longer be deleted.",
    });

    const [row] = await anonContext.db
      .select({ removedAt: post.removedAt, deletedAt: post.deletedAt })
      .from(post)
      .where(eq(post.id, target.id));
    expect(row?.removedAt).not.toBeNull();
    expect(row?.deletedAt).toBeNull();
  });

  it("returns the winning tombstone when another author deletion commits after the guard read", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    const winningDeletedAt = new Date("2026-08-22T12:00:00.000Z");
    const holderReady = deferred();
    const releaseHolder = deferred();
    const holder = anonContext.db.transaction(async (tx) => {
      await tx.update(post).set({ deletedAt: winningDeletedAt }).where(eq(post.id, target.id));
      holderReady.resolve();
      await releaseHolder.promise;
    });

    await holderReady.promise;
    const deletion = call(
      appRouter.post.delete,
      { postId: target.id },
      {
        context: contextFor(author),
      },
    );

    try {
      await waitForPostLockWait();
    } finally {
      releaseHolder.resolve();
    }
    await holder;

    await expect(deletion).resolves.toEqual({
      postId: target.id,
      deletedAt: winningDeletedAt,
    });
  });
});

describe("post.edit", () => {
  it("is NOT_FOUND for a post that doesn't exist", async () => {
    const author = await createTestUser();

    await expect(
      call(
        appRouter.post.edit,
        { postId: randomUUID(), content: "nothing" },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses someone else's post and leaves its content alone — ownership is server-enforced", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await expect(
      call(
        appRouter.post.edit,
        { postId: target.id, content: "hijacked" },
        { context: contextFor(stranger) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const thread = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(stranger) },
    );
    expect(thread.post.content).not.toBe("hijacked");
    expect(thread.post.editedAt).toBeNull();
  });

  it("edits the author's own post: the marker rides every projection, and createdAt — so feed order — does not move", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const base = Date.now();
    const seeded = await seedPosts(author.id, 2, { createdAt: (i) => new Date(base + i * 1000) });
    const [older] = seeded;

    const before = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(viewer) },
    );
    expect(before.items.find((p) => p.id === older.id)?.editedAt).toBeNull();

    const result = await call(
      appRouter.post.edit,
      { postId: older.id, content: "edited text zebra" },
      { context: contextFor(author) },
    );
    expect(result.postId).toBe(older.id);
    expect(result.content).toBe("edited text zebra");
    expect(result.editedAt).toBeInstanceOf(Date);

    const after = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(viewer) },
    );
    const edited = after.items.find((p) => p.id === older.id);
    expect(edited?.content).toBe("edited text zebra");
    expect(edited?.editedAt).toBeInstanceOf(Date);
    // The edit bumps nothing: the older post stays behind the newer one, at
    // its original creation instant.
    expect(after.items.map((p) => p.id)).toEqual(before.items.map((p) => p.id));
    expect(edited?.createdAt.getTime()).toBe(older.createdAt.getTime());

    // Search matches the raw `content` column, so the edited text is what it
    // finds; the thread carries the same row.
    const search = await call(
      appRouter.search.posts,
      { q: "zebra" },
      { context: contextFor(viewer) },
    );
    expect(search.items.some((p) => p.id === older.id)).toBe(true);
    const thread = await call(
      appRouter.post.thread,
      { postId: older.id },
      { context: contextFor(viewer) },
    );
    expect(thread.post.content).toBe("edited text zebra");
    expect(thread.post.editedAt).toBeInstanceOf(Date);
  });

  it("edits a reply like a top-level post", async () => {
    const author = await createTestUser();
    const [root] = await seedPosts(author.id, 1);
    const [reply] = await seedPosts(author.id, 1, { parentId: root.id });

    await call(
      appRouter.post.edit,
      { postId: reply.id, content: "edited reply" },
      { context: contextFor(author) },
    );

    const listed = await call(
      appRouter.post.list,
      { parentId: root.id },
      { context: contextFor(author) },
    );
    expect(listed.items.find((p) => p.id === reply.id)?.content).toBe("edited reply");
  });

  it("is idempotent: re-sending the same content keeps the original editedAt", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const first = await call(
      appRouter.post.edit,
      { postId: target.id, content: "same words" },
      { context: contextFor(author) },
    );
    const second = await call(
      appRouter.post.edit,
      { postId: target.id, content: "same words" },
      { context: contextFor(author) },
    );
    expect(second.editedAt?.getTime()).toBe(first.editedAt?.getTime());

    // The trim is part of the shared input, so whitespace-only differences
    // are the same edit too.
    const third = await call(
      appRouter.post.edit,
      { postId: target.id, content: "  same words  " },
      { context: contextFor(author) },
    );
    expect(third.editedAt?.getTime()).toBe(first.editedAt?.getTime());
  });

  it("refuses a post a moderator already removed — the appeal story cannot mutate under the appeal", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    // The removal state is what the guard reads; how it got there belongs to
    // moderation.int.test.ts, so this stamps it directly.
    await anonContext.db
      .update(post)
      .set({ removedAt: new Date(), removedReason: "spam" })
      .where(eq(post.id, target.id));

    await expect(
      call(
        appRouter.post.edit,
        { postId: target.id, content: "rewritten" },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This post was removed by a moderator and can no longer be edited.",
    });

    // `moderation.appealPreview` reads this row's content back to the author;
    // the refusal above is what keeps that quote from being rewritable.
    const [row] = await anonContext.db
      .select({ content: post.content })
      .from(post)
      .where(eq(post.id, target.id));
    expect(row?.content).not.toBe("rewritten");
  });

  it("refuses an author-deleted post", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    await anonContext.db.update(post).set({ deletedAt: new Date() }).where(eq(post.id, target.id));

    await expect(
      call(
        appRouter.post.edit,
        { postId: target.id, content: "edited" },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This post was deleted and can no longer be edited.",
    });
  });

  it("stays editable while the post is under moderation review — the superseded text becomes history the case view shows", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const moderator = await moderatorUser();
    const [target] = await seedPosts(author.id, 1);

    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: target.id, reason: "spam" },
      { context: contextFor(reporter) },
    );

    // An open report no longer freezes the text (the pinned choice this test
    // guards): the history is what protects the evidence, not the refusal.
    const edited = await call(
      appRouter.post.edit,
      { postId: target.id, content: "edited during review" },
      { context: contextFor(author) },
    );
    expect(edited.content).toBe("edited during review");

    // The moderator judging the case sees both the rewritten text and every
    // version it replaced. The evidence is doubled: the report row carries a
    // snapshot of the exact wording it was raised against, and the history
    // keeps every version — neither can be rewritten away by the author.
    const detail = await call(
      appRouter.moderation.case,
      { targetType: "post", targetId: target.id },
      { context: contextFor(moderator) },
    );
    if (detail.target.kind !== "post") throw new Error("expected a post target");
    expect(detail.target.content).toBe("edited during review");
    expect(detail.target.editedAt?.getTime()).toBe(edited.editedAt?.getTime());
    expect(detail.target.editHistory).toHaveLength(1);
    expect(detail.target.editHistory[0]?.content).toContain("seed post 0");
    // The history row is stamped with the same instant as the marker: the
    // newest version's replacement time and `editedAt` are one edit.
    expect(detail.target.editHistory[0]?.createdAt.getTime()).toBe(edited.editedAt?.getTime());
    // The report's snapshot is the seed wording — what the reporter saw, not
    // what the author rewrote it to — and the untruncated flag is honest.
    expect(detail.reports).toHaveLength(1);
    expect(detail.reports[0]?.snapshotContent).toContain("seed post 0");
    expect(detail.target.editHistoryTruncated).toBe(false);

    // A repeat report refreshes the snapshot alongside the case's clock
    // (moderation.report's upsert): the reporter is re-reporting what they now
    // see, so the moderators judge the current wording while the history keeps
    // the one it replaced.
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: target.id, reason: "spam" },
      { context: contextFor(reporter) },
    );
    const refreshed = await call(
      appRouter.moderation.case,
      { targetType: "post", targetId: target.id },
      { context: contextFor(moderator) },
    );
    expect(refreshed.reports).toHaveLength(1);
    expect(refreshed.reports[0]?.snapshotContent).toContain("edited during review");
  });

  it("cannot lose a version to concurrent edits: the row lock serializes the history", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    // Two overlapping edits from the same author (two tabs, a double-fire).
    // Both guard reads may see the seed text before either commits; without
    // serialization the loser would record the seed text twice and the
    // winner's wording would survive nowhere — invisible to the moderator
    // judging the case. `post.edit` opens its transaction by locking the
    // row, so each edit records what it *actually* superseded.
    await Promise.all(
      ["first writer", "second writer"].map((content) =>
        call(appRouter.post.edit, { postId: target.id, content }, { context: contextFor(author) }),
      ),
    );

    const [row] = await anonContext.db
      .select({ content: post.content })
      .from(post)
      .where(eq(post.id, target.id));
    const history = await anonContext.db
      .select({ content: postEdit.content })
      .from(postEdit)
      .where(eq(postEdit.postId, target.id));

    // Whichever edit committed last stands in `content`; the other is a
    // history row. Every version ever published is accounted for exactly
    // once — the seed once, each edit once.
    const allVersions = [row?.content, ...history.map((h) => h.content)];
    expect(new Set(allVersions)).toEqual(
      new Set(["first writer", "second writer", expect.stringContaining("seed post 0")]),
    );
    expect(allVersions).toHaveLength(3);
  });

  it("records one history row per edit — and none for an idempotent retry", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(
      appRouter.post.edit,
      { postId: target.id, content: "v1" },
      { context: contextFor(author) },
    );
    // Content-equal retry: a no-op that must not grow the history.
    await call(
      appRouter.post.edit,
      { postId: target.id, content: "v1" },
      { context: contextFor(author) },
    );
    await call(
      appRouter.post.edit,
      { postId: target.id, content: "v2" },
      { context: contextFor(author) },
    );

    const history = await anonContext.db
      .select({ content: postEdit.content })
      .from(postEdit)
      .where(eq(postEdit.postId, target.id))
      .orderBy(desc(postEdit.createdAt));
    // Newest first: the text edit two replaced, then the seeded original.
    expect(history[0]?.content).toBe("v1");
    expect(history[1]?.content).toContain("seed post 0");
    expect(history).toHaveLength(2);
  });

  it("applies create's text-or-images rule against the row's existing attachments", async () => {
    const author = await createTestUser();
    const [textOnly] = await seedPosts(author.id, 1);

    await expect(
      call(
        appRouter.post.edit,
        { postId: textOnly.id, content: "" },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Post cannot be empty." });

    // A post that already carries images keeps the image-only shape create
    // allows: clearing its text is a legal edit, not an empty post.
    const [withImages] = await seedPosts(author.id, 1);
    await anonContext.db.insert(postAttachment).values({
      postId: withImages.id,
      position: 0,
      mediaPath: `/media/posts/${author.id}/${withImages.id}/${randomUUID()}.png`,
      contentType: "image/png",
      byteSize: POST_PNG.byteLength,
      width: 2,
      height: 2,
    });

    const emptied = await call(
      appRouter.post.edit,
      { postId: withImages.id, content: "" },
      { context: contextFor(author) },
    );
    expect(emptied.content).toBe("");
    expect(emptied.editedAt).toBeInstanceOf(Date);
  });
});

describe("post.list", () => {
  it("keyset pagination never repeats or skips a row across every page — the single most important test in this file", async () => {
    const author = await createTestUser();
    const count = POST_PAGE_SIZE * 2 + 7; // guarantees at least 3 pages at the default page size
    const base = Date.now();
    const seeded = await seedPosts(author.id, count, {
      createdAt: (i) => new Date(base + i * 17),
    });

    const ids = await walkAllPostPages({ authorId: author.id }, contextFor(author));

    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count); // no duplicates
    expect(new Set(ids)).toEqual(new Set(seeded.map((p) => p.id))); // exactly the seeded set
  }, 20_000);

  it("rows sharing a millisecond are still traversed exactly once — the precision: 3 silent-skip bug packages/db/CONTEXT.md describes", async () => {
    const author = await createTestUser();
    const tiedAt = new Date("2025-06-01T12:00:00.000Z");
    const tieCount = POST_PAGE_SIZE + 5; // more than a small page, all sharing one createdAt
    const seeded = await seedPosts(author.id, tieCount, { createdAt: tiedAt });

    // A small explicit limit forces the walk to cross the tied-timestamp
    // boundary several times, which is where a lost fractional-millisecond
    // cursor would silently drop every row in the current window.
    const ids = await walkAllPostPages({ authorId: author.id, limit: 10 }, contextFor(author));

    expect(ids).toHaveLength(tieCount);
    expect(new Set(ids).size).toBe(tieCount);
    expect(new Set(ids)).toEqual(new Set(seeded.map((p) => p.id)));
  }, 20_000);

  it("nextCursor is null on the last page", async () => {
    const author = await createTestUser();
    await seedPosts(author.id, 3);

    const page = await call(
      appRouter.post.list,
      { authorId: author.id, limit: 10 },
      { context: contextFor(author) },
    );

    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a malformed cursor with BAD_REQUEST", async () => {
    const viewer = await createTestUser();
    await expect(
      call(appRouter.post.list, { cursor: "not-a-real-cursor" }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("excludes replies by default, includes them with includeReplies, and parentId returns only that post's direct replies", async () => {
    const author = await createTestUser();
    const [root] = await seedPosts(author.id, 1);
    const [reply] = await seedPosts(author.id, 1, { parentId: root.id });
    // A grandchild reply — parentId scoping on `root` must not leak this.
    await seedPosts(author.id, 1, { parentId: reply.id });

    const defaultPage = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(author) },
    );
    expect(defaultPage.items.map((i) => i.id)).toEqual([root.id]);

    const withReplies = await call(
      appRouter.post.list,
      { authorId: author.id, includeReplies: true },
      { context: contextFor(author) },
    );
    expect(withReplies.items).toHaveLength(3);

    const directReplies = await call(
      appRouter.post.list,
      { parentId: root.id },
      { context: contextFor(author) },
    );
    expect(directReplies.items.map((i) => i.id)).toEqual([reply.id]);
  });

  it("groups the focused author's reply branch beneath each direct reply", async () => {
    const focusedAuthor = await createTestUser();
    const participant = await createTestUser();
    const [focused] = await seedPosts(focusedAuthor.id, 1);
    const [directReply] = await seedPosts(participant.id, 1, { parentId: focused.id });
    const [authorReply] = await seedPosts(focusedAuthor.id, 1, { parentId: directReply.id });
    const [continuation] = await seedPosts(participant.id, 1, { parentId: authorReply.id });

    const page = await call(
      appRouter.post.list,
      { parentId: focused.id },
      { context: contextFor(participant) },
    );

    expect(page).toMatchObject({
      items: [{ id: directReply.id }],
      continuations: [
        {
          rootPostId: directReply.id,
          items: [{ id: authorReply.id }, { id: continuation.id }],
          nextCursor: null,
        },
      ],
    });
  });

  it("does not project a descendant branch the focused author never joins", async () => {
    const focusedAuthor = await createTestUser();
    const participant = await createTestUser();
    const [focused] = await seedPosts(focusedAuthor.id, 1);
    const [directReply] = await seedPosts(participant.id, 1, { parentId: focused.id });
    const [participantReply] = await seedPosts(participant.id, 1, {
      parentId: directReply.id,
    });
    await seedPosts(participant.id, 1, { parentId: participantReply.id });

    const page = await call(
      appRouter.post.list,
      { parentId: focused.id },
      { context: contextFor(participant) },
    );

    expect(page.items.map((item) => item.id)).toEqual([directReply.id]);
    if (!("continuations" in page)) throw new Error("Direct reply page omitted continuations");
    expect(page.continuations).toEqual([]);
  });

  it("caps an embedded branch and paginates the continuation without duplicating direct replies", async () => {
    const focusedAuthor = await createTestUser();
    const participant = await createTestUser();
    const [focused] = await seedPosts(focusedAuthor.id, 1);
    const [directReply] = await seedPosts(participant.id, 1, { parentId: focused.id });
    const branchIds: string[] = [];
    let parentId = directReply.id;

    for (let index = 0; index < THREAD_REPLY_BRANCH_INITIAL_SIZE + 5; index += 1) {
      const authorId = index === 0 ? focusedAuthor.id : participant.id;
      const [branchPost] = await seedPosts(authorId, 1, { parentId });
      branchIds.push(branchPost.id);
      parentId = branchPost.id;
    }

    const directPage = await call(
      appRouter.post.list,
      { parentId: focused.id },
      { context: contextFor(participant) },
    );
    if (!("continuations" in directPage)) {
      throw new Error("Direct reply page omitted continuations");
    }
    const embedded = directPage.continuations[0];

    expect(directPage.items.map((item) => item.id)).toEqual([directReply.id]);
    expect(embedded?.items.map((item) => item.id)).toEqual(
      branchIds.slice(0, THREAD_REPLY_BRANCH_INITIAL_SIZE),
    );
    expect(embedded?.nextCursor).toEqual(expect.any(String));

    const loadedIds: string[] = [];
    let cursor = embedded?.nextCursor ?? undefined;
    while (cursor) {
      const page = await call(
        appRouter.post.list,
        { continuationRootId: directReply.id, cursor, limit: 2 },
        { context: contextFor(participant) },
      );
      loadedIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    }

    expect([...embedded.items.map((item) => item.id), ...loadedIds]).toEqual(branchIds);
    expect(new Set(loadedIds)).not.toContain(directReply.id);
  });

  it("keeps tombstones and skips blocked or banned authors without breaking the selected branch", async () => {
    const focusedAuthor = await createTestUser();
    const viewer = await createTestUser();
    const blockedAuthor = await createTestUser();
    const bannedAuthor = await createTestUser();
    const [focused] = await seedPosts(focusedAuthor.id, 1);
    const [directReply] = await seedPosts(viewer.id, 1, { parentId: focused.id });
    const [removedAuthorReply] = await seedPosts(focusedAuthor.id, 1, {
      parentId: directReply.id,
    });
    const [blockedReply] = await seedPosts(blockedAuthor.id, 1, {
      parentId: removedAuthorReply.id,
    });
    const [bannedReply] = await seedPosts(bannedAuthor.id, 1, { parentId: blockedReply.id });
    const [deletedContinuation] = await seedPosts(viewer.id, 1, { parentId: bannedReply.id });

    await call(
      appRouter.post.like,
      { postId: removedAuthorReply.id },
      { context: contextFor(viewer) },
    );
    await anonContext.db
      .update(post)
      .set({ removedAt: new Date(), removedReason: "policy" })
      .where(eq(post.id, removedAuthorReply.id));
    await anonContext.db
      .update(post)
      .set({ deletedAt: new Date() })
      .where(eq(post.id, deletedContinuation.id));
    await call(
      appRouter.moderation.block,
      { userId: blockedAuthor.id },
      { context: contextFor(viewer) },
    );
    await anonContext.db.update(user).set({ banned: true }).where(eq(user.id, bannedAuthor.id));

    const page = await call(
      appRouter.post.list,
      { parentId: focused.id },
      { context: contextFor(viewer) },
    );
    if (!("continuations" in page)) throw new Error("Direct reply page omitted continuations");
    const items = page.continuations[0]?.items ?? [];

    expect(items.map((item) => item.id)).toEqual([removedAuthorReply.id, deletedContinuation.id]);
    expect(items[0]).toMatchObject({
      content: null,
      removed: true,
      viewerHasLiked: true,
    });
    expect(items[1]).toMatchObject({ content: null, deleted: true });
    expect(items.map((item) => item.author.id)).not.toContain(blockedAuthor.id);
    expect(items.map((item) => item.author.id)).not.toContain(bannedAuthor.id);
  });

  it("still selects the branch when the author's reply is the oldest child of a wide fork", async () => {
    const focusedAuthor = await createTestUser();
    const participant = await createTestUser();
    const [focused] = await seedPosts(focusedAuthor.id, 1);
    const [directReply] = await seedPosts(participant.id, 1, { parentId: focused.id });

    // The author's reply is the oldest child, so it stays inside the fanout
    // cap even when far more sibling replies exist beneath the same fork.
    const [authorReply] = await seedPosts(focusedAuthor.id, 1, {
      parentId: directReply.id,
      createdAt: new Date(2024, 0, 1, 0, 0, 0),
    });
    await seedPosts(participant.id, THREAD_REPLY_BRANCH_CHILD_FANOUT + 10, {
      parentId: directReply.id,
      createdAt: (i) => new Date(2024, 0, 1, 0, 0, i + 1),
    });

    const page = await call(
      appRouter.post.list,
      { parentId: focused.id },
      { context: contextFor(participant) },
    );
    if (!("continuations" in page)) throw new Error("Direct reply page omitted continuations");

    expect(page.continuations[0]?.items.map((item) => item.id)).toEqual([authorReply.id]);
  });

  it("leaves a branch collapsed when the author's reply falls outside the fanout budget", async () => {
    const focusedAuthor = await createTestUser();
    const participant = await createTestUser();
    const [focused] = await seedPosts(focusedAuthor.id, 1);
    const [directReply] = await seedPosts(participant.id, 1, { parentId: focused.id });

    // The first fork is filled with non-author replies older than the author's,
    // so the author's reply is the (FANOUT + 1)th child and never enters the
    // bounded scan. The branch stays gracefully collapsed instead of pulling
    // every sibling into memory.
    await seedPosts(participant.id, THREAD_REPLY_BRANCH_CHILD_FANOUT, {
      parentId: directReply.id,
      createdAt: (i) => new Date(2024, 0, 1, 0, 0, i),
    });
    await seedPosts(focusedAuthor.id, 1, {
      parentId: directReply.id,
      createdAt: new Date(2024, 0, 1, 0, 0, THREAD_REPLY_BRANCH_CHILD_FANOUT),
    });

    const page = await call(
      appRouter.post.list,
      { parentId: focused.id },
      { context: contextFor(participant) },
    );
    if (!("continuations" in page)) throw new Error("Direct reply page omitted continuations");

    expect(page.continuations).toEqual([]);
  });

  it("supports the explicit posts/replies/all activity modes", async () => {
    const author = await createTestUser();
    const [root] = await seedPosts(author.id, 1);
    const [reply] = await seedPosts(author.id, 1, { parentId: root.id });

    const posts = await call(
      appRouter.post.list,
      { authorId: author.id, kind: "posts" },
      { context: contextFor(author) },
    );
    const replies = await call(
      appRouter.post.list,
      { authorId: author.id, kind: "replies" },
      { context: contextFor(author) },
    );
    const all = await call(
      appRouter.post.list,
      { authorId: author.id, kind: "all" },
      { context: contextFor(author) },
    );

    expect(posts.items.map((item) => item.id)).toEqual([root.id]);
    expect(replies.items.map((item) => item.id)).toEqual([reply.id]);
    expect(new Set(all.items.map((item) => item.id))).toEqual(new Set([root.id, reply.id]));
  });

  it("includes an immediate parent preview, keeps removed parents as stubs, and hides deleted or blocked parents", async () => {
    const parentAuthor = await createTestUser({ name: "Parent Author" });
    const replyAuthor = await createTestUser({ name: "Reply Author" });
    const viewer = await createTestUser();
    const [parent] = await seedPosts(parentAuthor.id, 1);
    const [reply] = await seedPosts(replyAuthor.id, 1, { parentId: parent.id });

    const visible = await call(
      appRouter.post.list,
      { authorId: replyAuthor.id, kind: "replies" },
      { context: contextFor(viewer) },
    );
    const visibleReply = visible.items.find((item) => item.id === reply.id);
    expect(visibleReply?.parent).toMatchObject({
      id: parent.id,
      truncated: false,
      removed: false,
      author: { id: parentAuthor.id, name: "Parent Author" },
    });
    expect(visibleReply?.parent?.excerpt).toMatch(/^seed post 0 /);

    await anonContext.db
      .update(post)
      .set({ removedAt: new Date(), removedReason: "policy" })
      .where(eq(post.id, parent.id));

    const removed = await call(
      appRouter.post.list,
      { authorId: replyAuthor.id, kind: "replies" },
      { context: contextFor(viewer) },
    );
    expect(removed.items.find((item) => item.id === reply.id)?.parent).toMatchObject({
      id: parent.id,
      excerpt: null,
      truncated: false,
      removed: true,
      author: { id: parentAuthor.id },
    });

    await anonContext.db
      .update(post)
      .set({ removedAt: null, removedReason: null, deletedAt: new Date() })
      .where(eq(post.id, parent.id));

    const deleted = await call(
      appRouter.post.list,
      { authorId: replyAuthor.id, kind: "replies" },
      { context: contextFor(viewer) },
    );
    expect(deleted.items.find((item) => item.id === reply.id)?.parent).toBeNull();

    await anonContext.db.update(post).set({ deletedAt: null }).where(eq(post.id, parent.id));

    await call(
      appRouter.moderation.block,
      { userId: parentAuthor.id },
      { context: contextFor(viewer) },
    );
    const hidden = await call(
      appRouter.post.list,
      { authorId: replyAuthor.id, kind: "replies" },
      { context: contextFor(viewer) },
    );
    expect(hidden.items.find((item) => item.id === reply.id)?.parent).toBeNull();
  });

  it("authorId scopes the feed to one author and composes as AND with the other filters", async () => {
    const authorA = await createTestUser();
    const authorB = await createTestUser();
    const postsA = await seedPosts(authorA.id, 3);
    await seedPosts(authorB.id, 3);

    const page = await call(
      appRouter.post.list,
      { authorId: authorA.id, limit: POST_PAGE_SIZE_MAX },
      { context: contextFor(authorA) },
    );

    expect(new Set(page.items.map((i) => i.id))).toEqual(new Set(postsA.map((p) => p.id)));
  });

  it("rejects an anonymous caller on the feed modes — 'global' as much as 'following' (issue #36, kept 0.4.0)", async () => {
    // The public surface is the post PERMALINK: only the reply modes
    // (`parentId`/`continuationRootId`) admit an anonymous reader below.
    // Every feed, profile, search and bookmarks mode still demands a session.
    await expect(call(appRouter.post.list, {}, { context: anonContext })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      call(appRouter.post.list, { feed: "bookmarks" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.post.list, { feed: "following" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("serves an anonymous caller the direct replies of a public post — viewer state all false", async () => {
    const author = await createTestUser();
    const replier = await createTestUser();
    const [root] = await seedPosts(author.id, 1);
    await call(
      appRouter.post.create,
      { content: "public reply", parentId: root.id },
      { context: contextFor(replier) },
    );
    await call(appRouter.post.like, { postId: root.id }, { context: contextFor(replier) });

    const page = await call(appRouter.post.list, { parentId: root.id }, { context: anonContext });

    expect(page.items.map((item) => item.content)).toContain("public reply");
    // A null viewer has liked, reposted and bookmarked nothing.
    for (const item of page.items) {
      expect(item.viewerHasLiked).toBe(false);
      expect(item.viewerHasReposted).toBe(false);
      expect(item.viewerHasBookmarked).toBe(false);
    }
  });

  it("serves an anonymous caller a public thread, tombstone and all — the signed-in stub treatment", async () => {
    const author = await createTestUser();
    const [post] = await seedPosts(author.id, 1);

    const thread = await call(appRouter.post.thread, { postId: post.id }, { context: anonContext });
    expect(thread.post.id).toBe(post.id);
    expect(thread.post.viewerHasLiked).toBe(false);

    // A removed post keeps its stub for every reader — an anonymous one sees
    // exactly what a signed-in non-author sees: the flags, never the content
    // or the reason.
    await call(
      appRouter.moderation.removePost,
      { postId: post.id, reason: "spam" },
      { context: contextFor(await moderatorUser()) },
    );
    const stub = await call(appRouter.post.thread, { postId: post.id }, { context: anonContext });
    expect(stub.post.removed).toBe(true);
    expect(stub.post.content).toBeNull();
    expect(stub.post.removedReason).toBeNull();
  });

  it("hides a thread from an anonymous caller when the author is banned — the same visibility as a signed-in reader", async () => {
    const author = await createTestUser();
    const [post] = await seedPosts(author.id, 1);
    await anonContext.db.update(user).set({ banned: true }).where(eq(user.id, author.id));

    await expect(
      call(appRouter.post.thread, { postId: post.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("feed: 'following' returns posts from people you follow, plus your own unconditionally, excluding a stranger's", async () => {
    const viewer = await createTestUser();
    const followed = await createTestUser();
    const stranger = await createTestUser();

    await call(appRouter.user.follow, { userId: followed.id }, { context: contextFor(viewer) });

    const [ownPost] = await seedPosts(viewer.id, 1);
    const [followedPost] = await seedPosts(followed.id, 1);
    const [strangerPost] = await seedPosts(stranger.id, 1);

    const page = await call(
      appRouter.post.list,
      { feed: "following", limit: POST_PAGE_SIZE_MAX },
      { context: contextFor(viewer) },
    );
    const ids = page.items.map((i) => i.id);

    expect(ids).toContain(ownPost.id);
    expect(ids).toContain(followedPost.id);
    expect(ids).not.toContain(strangerPost.id);
  });

  it("rejects limit 0 and anything above POST_PAGE_SIZE_MAX, and accepts exactly POST_PAGE_SIZE_MAX", async () => {
    const viewer = await createTestUser();

    await expect(
      call(appRouter.post.list, { limit: 0 }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      call(appRouter.post.list, { limit: POST_PAGE_SIZE_MAX + 1 }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const page = await call(
      appRouter.post.list,
      { limit: POST_PAGE_SIZE_MAX },
      { context: contextFor(viewer) },
    );
    expect(page.items.length).toBeLessThanOrEqual(POST_PAGE_SIZE_MAX);
  });
});

describe("post.thread", () => {
  it("an unknown id is NOT_FOUND", async () => {
    const viewer = await createTestUser();
    await expect(
      call(appRouter.post.thread, { postId: randomUUID() }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a root post short-circuits to { ancestors: [], truncated: false }", async () => {
    const author = await createTestUser();
    const [root] = await seedPosts(author.id, 1);

    const result = await call(
      appRouter.post.thread,
      { postId: root.id },
      { context: contextFor(author) },
    );

    expect(result.post.id).toBe(root.id);
    expect(result.ancestors).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("returns ancestors root-first, and never a page of the focused post's own replies", async () => {
    const author = await createTestUser();
    const [grandparent] = await seedPosts(author.id, 1);
    const [parent] = await seedPosts(author.id, 1, { parentId: grandparent.id });
    const [focused] = await seedPosts(author.id, 1, { parentId: parent.id });
    const [childReply] = await seedPosts(author.id, 1, { parentId: focused.id });

    const result = await call(
      appRouter.post.thread,
      { postId: focused.id },
      { context: contextFor(author) },
    );

    expect(result.ancestors.map((a) => a.id)).toEqual([grandparent.id, parent.id]);
    expect(result.post.id).toBe(focused.id);
    expect(result).not.toHaveProperty("replies");

    const idsInPayload = [result.post.id, ...result.ancestors.map((a) => a.id)];
    expect(idsInPayload).not.toContain(childReply.id);
  });

  it("caps a chain longer than THREAD_ANCESTOR_MAX and marks it truncated", async () => {
    const author = await createTestUser();
    const depth = THREAD_ANCESTOR_MAX + 5;
    const chain = await buildChain(author.id, depth);
    const focusedId = chain.at(-1)!;

    const result = await call(
      appRouter.post.thread,
      { postId: focusedId },
      { context: contextFor(author) },
    );

    expect(result.ancestors).toHaveLength(THREAD_ANCESTOR_MAX);
    expect(result.truncated).toBe(true);
    // Root-first order: the THREAD_ANCESTOR_MAX ancestors nearest the focused post.
    const expectedIds = chain.slice(chain.length - 1 - THREAD_ANCESTOR_MAX, chain.length - 1);
    expect(result.ancestors.map((a) => a.id)).toEqual(expectedIds);
  }, 20_000);

  it("a chain exactly at THREAD_ANCESTOR_MAX is not truncated", async () => {
    const author = await createTestUser();
    const chain = await buildChain(author.id, THREAD_ANCESTOR_MAX);
    const focusedId = chain.at(-1)!;

    const result = await call(
      appRouter.post.thread,
      { postId: focusedId },
      { context: contextFor(author) },
    );

    expect(result.ancestors).toHaveLength(THREAD_ANCESTOR_MAX);
    expect(result.truncated).toBe(false);
    expect(result.ancestors.map((a) => a.id)).toEqual(chain.slice(0, -1));
  }, 20_000);

  it("reports the same likeCount/replyCount/viewerHasLiked as post.list for the same post — proof both share postSelection", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    await seedPosts(author.id, 2, { parentId: target.id });
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });

    const viewerCtx = contextFor(liker);
    const threadResult = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: viewerCtx },
    );
    const listResult = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: viewerCtx },
    );
    const listRow = listResult.items.find((i) => i.id === target.id);

    expect(listRow).toBeDefined();
    expect(threadResult.post.likeCount).toBe(listRow!.likeCount);
    expect(threadResult.post.replyCount).toBe(listRow!.replyCount);
    expect(threadResult.post.viewerHasLiked).toBe(listRow!.viewerHasLiked);
    expect(threadResult.post.likeCount).toBe(1);
    expect(threadResult.post.replyCount).toBe(2);
    expect(threadResult.post.viewerHasLiked).toBe(true);
  });
});
