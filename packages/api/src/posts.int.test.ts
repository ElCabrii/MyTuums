import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { post } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  POST_MAX_LENGTH,
  POST_PAGE_SIZE,
  POST_PAGE_SIZE_MAX,
  THREAD_ANCESTOR_MAX,
} from "./constants.js";
import type { Context } from "./context.js";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  seedPosts,
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

interface ListArgs {
  authorId?: string;
  parentId?: string;
  includeReplies?: boolean;
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

describe("post.create", () => {
  it("rejects an anonymous caller", async () => {
    await expect(
      call(appRouter.post.create, { content: "hello" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects whitespace-only content — trimming first is what makes min(1) catch this instead of storing an empty-looking post", async () => {
    const author = await createTestUser();
    await expect(
      call(appRouter.post.create, { content: "   \n\t  " }, { context: contextFor(author) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

describe("post content length — the post_content_length CHECK constraint", () => {
  it("the DB bound is the more permissive gate: char_length counts code points, while zod's max counts UTF-16 code units", async () => {
    const author = await createTestUser();
    const astral = "😀".repeat(200);
    const created = await call(
      appRouter.post.create,
      { content: astral },
      { context: contextFor(author) },
    );
    expect(created.content).toBe(astral);
  });

  it("the CHECK constraint rejects a row over the bound even when the zod gate is bypassed entirely", async () => {
    const author = await createTestUser();
    await expect(
      author.context.db.insert(post).values({ authorId: author.id, content: "a".repeat(501) }),
    ).rejects.toThrow();
  });

  it("the constraint accepts exactly the length POST_MAX_LENGTH does — the hardcoded 500 in the schema stays in step", async () => {
    const author = await createTestUser();
    const [created] = await author.context.db
      .insert(post)
      .values({ authorId: author.id, content: "a".repeat(POST_MAX_LENGTH) })
      .returning({ id: post.id });
    expect(created).toBeDefined();
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

  it("rows sharing a millisecond are still traversed exactly once — the precision: 3 silent-skip bug CLAUDE.md describes", async () => {
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
