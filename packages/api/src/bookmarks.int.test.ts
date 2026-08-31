import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { postBookmark, userBlock } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import {
  contextFor,
  createTestUser,
  freshSessionFor,
  seedPosts,
  setUserRole,
  truncateAll,
  type TestUser,
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

/** A user promoted to moderator through the row, re-fetched so the session carries the role (no cookieCache). */
async function moderatorUser() {
  const user = await createTestUser();
  await setUserRole(user.id, "moderator");
  return freshSessionFor(user);
}

/**
 * Seeds the saver's bookmark rows directly, with explicit distinct
 * millisecond timestamps — the deterministic equivalent of what
 * `search.int.test.ts` does for posts. The walk tests below are about the
 * list query's keyset, and hand-set timestamps are what make "bookmark order"
 * provable independent of how long the surrounding inserts happen to take.
 */
async function seedBookmarks(
  db: TestUser["context"]["db"],
  saverId: string,
  rows: { postId: string; savedAt: Date }[],
) {
  if (rows.length === 0) return;
  await db
    .insert(postBookmark)
    .values(rows.map((row) => ({ postId: row.postId, userId: saverId, createdAt: row.savedAt })));
}

/** Walks the caller's bookmarks feed at the given limit, starting at `cursor` if given. */
async function walkAllBookmarks(viewer: TestUser, limit: number, cursor?: string) {
  const items: Awaited<ReturnType<typeof callList>>["items"] = [];
  for (;;) {
    const page = await callList(viewer, limit, cursor);
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
}

/** The input shape of every bookmarks-page call in this file. */
interface BookmarksListInput {
  feed: "bookmarks";
  limit: number;
  cursor?: string;
}

function callList(viewer: TestUser, limit: number, cursor?: string) {
  const input: BookmarksListInput = { feed: "bookmarks", limit };
  if (cursor) input.cursor = cursor;
  return call(appRouter.post.list, input, { context: contextFor(viewer) });
}

describe("post.bookmark / post.unbookmark", () => {
  it("bookmarking an unknown post is NOT_FOUND, while unbookmarking one is a no-op — the row being removed is the caller's own", async () => {
    const saver = await createTestUser();
    const unknownId = randomUUID();
    await expect(
      call(appRouter.post.bookmark, { postId: unknownId }, { context: contextFor(saver) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      call(appRouter.post.unbookmark, { postId: unknownId }, { context: contextFor(saver) }),
    ).resolves.toEqual({ postId: unknownId, viewerHasBookmarked: false });
  });

  it("bookmarking twice is idempotent — the (post_id, user_id) primary key IS the rule; onConflictDoNothing is just the mechanism that avoids erroring on the duplicate", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const first = await call(
      appRouter.post.bookmark,
      { postId: target.id },
      { context: contextFor(saver) },
    );
    const second = await call(
      appRouter.post.bookmark,
      { postId: target.id },
      { context: contextFor(saver) },
    );

    expect(first).toEqual({ postId: target.id, viewerHasBookmarked: true });
    expect(second).toEqual(first);

    const page = await callList(saver, 10);
    expect(page.items.map((item) => item.id)).toEqual([target.id]);
  });

  it("unbookmarking a post the viewer never bookmarked is a no-op, not an error", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const result = await call(
      appRouter.post.unbookmark,
      { postId: target.id },
      { context: contextFor(viewer) },
    );

    expect(result).toEqual({ postId: target.id, viewerHasBookmarked: false });
  });

  it("unbookmarking a post the author has since deleted does not error — the tombstone row survives, so the saved row must stay removable", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.bookmark, { postId: target.id }, { context: contextFor(saver) });
    await call(appRouter.post.delete, { postId: target.id }, { context: contextFor(author) });

    const result = await call(
      appRouter.post.unbookmark,
      { postId: target.id },
      { context: contextFor(saver) },
    );
    expect(result).toEqual({ postId: target.id, viewerHasBookmarked: false });

    const [remaining] = await saver.context.db
      .select({ postId: postBookmark.postId })
      .from(postBookmark)
      .where(eq(postBookmark.userId, saver.id));
    expect(remaining).toBeUndefined();
  });

  it("bookmarking your own post is allowed", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const result = await call(
      appRouter.post.bookmark,
      { postId: target.id },
      { context: contextFor(author) },
    );

    expect(result.viewerHasBookmarked).toBe(true);
    const page = await callList(author, 10);
    expect(page.items.map((item) => item.id)).toEqual([target.id]);
  });

  it("a blocked author's post is NOT_FOUND to bookmark, but unbookmark keeps working — a saved row must never become unremovable", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const [target, other] = await seedPosts(author.id, 2);

    await call(appRouter.post.bookmark, { postId: target.id }, { context: contextFor(saver) });
    await call(appRouter.post.bookmark, { postId: other.id }, { context: contextFor(saver) });

    // The block lands between the save and the read — the page must apply the
    // visibility filter like every other feed, not trust the saved rows.
    await saver.context.db.insert(userBlock).values({ blockerId: author.id, blockedId: saver.id });

    await expect(
      call(appRouter.post.bookmark, { postId: target.id }, { context: contextFor(saver) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const page = await callList(saver, 10);
    expect(page.items).toEqual([]);

    // `unbookmark` carries no target check on purpose: the row is the saver's
    // own, the block has filtered the post off the page, and with a check
    // here the row could never be cleaned up at all.
    const result = await call(
      appRouter.post.unbookmark,
      { postId: target.id },
      { context: contextFor(saver) },
    );
    expect(result).toEqual({ postId: target.id, viewerHasBookmarked: false });

    const [remaining] = await saver.context.db
      .select({ postId: postBookmark.postId })
      .from(postBookmark)
      .where(eq(postBookmark.userId, saver.id));
    expect(remaining?.postId).toBe(other.id);
  });

  it("bookmarks are private: viewerHasBookmarked answers for the caller alone, and one caller's page never lists another's saves", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const stranger = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.bookmark, { postId: target.id }, { context: contextFor(saver) });

    const [fromSaver, fromAuthor, fromStranger] = await Promise.all([
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(saver) }),
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(author) }),
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(stranger) }),
    ]);
    expect(fromSaver.post.viewerHasBookmarked).toBe(true);
    expect(fromAuthor.post.viewerHasBookmarked).toBe(false);
    expect(fromStranger.post.viewerHasBookmarked).toBe(false);

    // The page is built from the caller's own rows: a stranger's first page
    // is theirs, not the saver's.
    const strangerPage = await callList(stranger, 10);
    expect(strangerPage.items).toEqual([]);
  });

  it("a re-bookmark returns the post to the top — a fresh save is a fresh position, not a remembered rank", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const [first, second] = await seedPosts(author.id, 2);

    await call(appRouter.post.bookmark, { postId: first.id }, { context: contextFor(saver) });
    await call(appRouter.post.bookmark, { postId: second.id }, { context: contextFor(saver) });
    await call(appRouter.post.unbookmark, { postId: first.id }, { context: contextFor(saver) });
    await call(appRouter.post.bookmark, { postId: first.id }, { context: contextFor(saver) });

    const page = await callList(saver, 10);
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("the bookmarks page omits an author-deleted post and keeps a moderator-removed one as its stub — no errors either way", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const mod = await moderatorUser();
    const [deleted, removed, kept] = await seedPosts(author.id, 3);

    for (const postId of [deleted.id, removed.id, kept.id]) {
      await call(appRouter.post.bookmark, { postId }, { context: contextFor(saver) });
    }
    await call(appRouter.post.delete, { postId: deleted.id }, { context: contextFor(author) });
    await call(
      appRouter.moderation.removePost,
      { postId: removed.id, reason: "classified content" },
      { context: contextFor(mod) },
    );

    const page = await callList(saver, 10);
    // Saved in order deleted -> removed -> kept, so the newest save leads:
    // kept first, removed second, deleted gone entirely.
    expect(page.items.map((item) => item.id)).toEqual([kept.id, removed.id]);
    expect(page.items[1]).toMatchObject({ removed: true, content: null, deleted: false });
  });

  it("feed: 'bookmarks' cannot be combined with the scoping filters", async () => {
    const saver = await createTestUser();
    const author = await createTestUser();

    await expect(
      call(
        appRouter.post.list,
        { feed: "bookmarks", authorId: author.id },
        { context: contextFor(saver) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      call(
        appRouter.post.list,
        { feed: "bookmarks", kind: "posts" },
        { context: contextFor(saver) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("post.list feed: 'bookmarks' pagination", () => {
  it("keyset pagination never repeats or skips a row across every page, in bookmark order — not post creation order", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const posts = await seedPosts(author.id, 7);

    // Saved in an order deliberately unlike the posts' creation order: the
    // page must follow when each post was *saved*, which is the one thing
    // that distinguishes this feed from every other mode of post.list.
    const saveOrder = [posts[6], posts[2], posts[0], posts[5], posts[1], posts[4], posts[3]];
    const base = Date.now();
    await seedBookmarks(
      saver.context.db,
      saver.id,
      saveOrder.map((post, index) => ({ postId: post.id, savedAt: new Date(base + index * 17) })),
    );

    const items = await walkAllBookmarks(saver, 2);

    const expected = [...saveOrder].reverse().map((post) => post.id);
    expect(items.map((item) => item.id)).toEqual(expected);
  });

  it("a bookmark saved mid-walk, inside the not-yet-visited range, is picked up without disturbing the walk", async () => {
    const author = await createTestUser();
    const saver = await createTestUser();
    const posts = await seedPosts(author.id, 6);
    const base = Date.now();

    // Five saved rows; the sixth post is saved only after the walk started.
    await seedBookmarks(
      saver.context.db,
      saver.id,
      posts
        .slice(0, 5)
        .map((post, index) => ({ postId: post.id, savedAt: new Date(base + index * 23) })),
    );

    const firstPage = await callList(saver, 2);
    // Its save lands between the walked cursor and the rows not yet visited.
    await seedBookmarks(saver.context.db, saver.id, [
      { postId: posts[5].id, savedAt: new Date(base + 2 * 23 + 8) },
    ]);

    const rest = await walkAllBookmarks(saver, 2, firstPage.nextCursor ?? undefined);
    const ids = [...firstPage.items, ...rest].map((item) => item.id);

    // Six bookmarks, each exactly once, newest first. The mid-walk save
    // appears at its position in save order — not twice, not never.
    const expected = [posts[4].id, posts[3].id, posts[5].id, posts[2].id, posts[1].id, posts[0].id];
    expect(ids).toEqual(expected);
  });
});
