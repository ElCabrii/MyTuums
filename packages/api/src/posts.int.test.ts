import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { eq, sql } from "drizzle-orm";
import { closeDb } from "@my-tuums/db";
import { post, postAttachment } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  POST_MAX_LENGTH,
  POST_PAGE_SIZE,
  POST_PAGE_SIZE_MAX,
  THREAD_ANCESTOR_MAX,
} from "./constants.js";
import type { Context } from "./context.js";
import { withPostMediaLifecycleLock } from "./post-media-lock.js";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  seedPosts,
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
    const rows = await anonContext.db.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE 'update "post" set%'
      ) AS blocked
    `);
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Author deletion never reached the held post-row lock");
}

/** Waits until a post attachment writer is blocked by the shared media lock. */
async function waitForPostMediaLifecycleLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await anonContext.db.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%pg_advisory_xact_lock%'
      ) AS blocked
    `);
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Post attachment creation never reached the held media lifecycle lock");
}

describe("post.create", () => {
  it("rejects an anonymous caller", async () => {
    await expect(
      call(appRouter.post.create, { content: "hello" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

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

  it("trims surrounding whitespace and attaches the author", async () => {
    const author = await createTestUser();
    const created = await call(
      appRouter.post.create,
      { content: "  hello world  " },
      { context: contextFor(author) },
    );

    expect(created.content).toBe("hello world");
    expect(created.author.id).toBe(author.id);
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
  it("rejects an anonymous caller", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await expect(
      call(appRouter.post.delete, { postId: target.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

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
      deleted: false,
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

  it("rejects an anonymous caller — every mode of list requires a session now, not just 'following' (issue #36)", async () => {
    await expect(call(appRouter.post.list, {}, { context: anonContext })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
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
  it("rejects an anonymous caller", async () => {
    await expect(
      call(appRouter.post.thread, { postId: randomUUID() }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

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
