import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@my-tuums/db";
import { post, postRepost } from "@my-tuums/db/schema";
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

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** A moderator fixture with the role already visible on a fresh session. */
async function createModerator(): Promise<TestUser> {
  const moderator = await createTestUser();
  await setUserRole(moderator.id, "moderator");
  return freshSessionFor(moderator);
}

/**
 * A repost at a chosen instant — the same timestamp control `seedPosts` gives
 * posts, because the feed assertions need a repost's event to sit at a known
 * position relative to authored posts. Procedure-level behaviour (idempotency,
 * counts) always goes through `post.repost`/`post.unrepost` like production.
 */
async function seedRepost(postId: string, userId: string, createdAt: Date): Promise<void> {
  await db.insert(postRepost).values({ postId, userId, createdAt });
}

describe("post.repost / post.unrepost", () => {
  it("reposting an unknown post is NOT_FOUND", async () => {
    const reposter = await createTestUser();
    await expect(
      call(appRouter.post.repost, { postId: randomUUID() }, { context: contextFor(reposter) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reposting twice is idempotent — the (post_id, user_id) primary key IS the rule; onConflictDoNothing is just the mechanism", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const first = await call(
      appRouter.post.repost,
      { postId: target.id },
      { context: contextFor(reposter) },
    );
    const second = await call(
      appRouter.post.repost,
      { postId: target.id },
      { context: contextFor(reposter) },
    );

    expect(first.repostCount).toBe(1);
    expect(second.repostCount).toBe(1);
    expect(second.viewerHasReposted).toBe(true);
  });

  it("reposting your own post is allowed — amplifying it to your followers is the point", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const result = await call(
      appRouter.post.repost,
      { postId: target.id },
      { context: contextFor(author) },
    );

    expect(result.repostCount).toBe(1);
    expect(result.viewerHasReposted).toBe(true);
  });

  it("unreposting a post the viewer never reposted is a no-op, not an error", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const result = await call(
      appRouter.post.unrepost,
      { postId: target.id },
      { context: contextFor(viewer) },
    );

    expect(result.repostCount).toBe(0);
    expect(result.viewerHasReposted).toBe(false);
  });

  it("the count returned by repost/unrepost matches what post.list and post.thread subsequently report — the count is derived on read, never denormalised", async () => {
    const author = await createTestUser();
    const alice = await createTestUser();
    const bob = await createTestUser();
    const stranger = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(alice) });
    const bobResult = await call(
      appRouter.post.repost,
      { postId: target.id },
      { context: contextFor(bob) },
    );
    expect(bobResult.repostCount).toBe(2);

    const [thread, feed, fromStranger] = await Promise.all([
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(alice) }),
      call(appRouter.post.list, { authorId: author.id }, { context: contextFor(alice) }),
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(stranger) }),
    ]);
    expect(thread.post.repostCount).toBe(2);
    expect(feed.items.find((i) => i.id === target.id)!.repostCount).toBe(2);
    expect(thread.post.viewerHasReposted).toBe(true);
    expect(fromStranger.post.viewerHasReposted).toBe(false);

    const unrepost = await call(
      appRouter.post.unrepost,
      { postId: target.id },
      { context: contextFor(alice) },
    );
    expect(unrepost.repostCount).toBe(1);
    expect(unrepost.viewerHasReposted).toBe(false);
  });

  it("reposting a post whose author blocked the viewer reads as NOT_FOUND — existence is not leaked", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.moderation.block, { userId: viewer.id }, { context: contextFor(author) });

    await expect(
      call(appRouter.post.repost, { postId: target.id }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("reposts in feeds", () => {
  it("a repost places the original at the repost's timestamp in the global feed, attributed to the reposter and showing the original author", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const viewer = await createTestUser();
    // Explicit instants: the ordering property under test needs the original
    // OLDER than the newer post, and `defaultNow()` gives both the same
    // millisecond, leaving only the random uuid tie-breaker.
    const base = Date.UTC(2026, 0, 2, 9, 0, 0);
    const [original, newer] = await seedPosts(author.id, 2, {
      createdAt: (i) => new Date(base + i * 10_000),
    });

    // The repost happens after both posts were authored: the event must sit
    // ABOVE the newer post even though the original is the OLDEST row.
    // (The global feed carries other tests' posts too — assert on the
    // subsequence this test owns, which keeps its order.)
    const repostedAt = new Date(base + 20_000);
    await seedRepost(original.id, reposter.id, repostedAt);

    const feed = await call(appRouter.post.list, {}, { context: contextFor(viewer) });
    const mine = feed.items.filter((i) => i.id === original.id || i.id === newer.id);

    expect(mine).toHaveLength(3);
    expect(mine[0].id).toBe(original.id);
    expect(mine[0].repostedBy).toMatchObject({ id: reposter.id });
    expect(mine[0].repostedBy?.repostedAt.getTime()).toBe(repostedAt.getTime());
    // The embedded post is the ORIGINAL — its own author, not the reposter.
    expect(mine[0].author.id).toBe(author.id);
    expect(mine[1].id).toBe(newer.id);
    expect(mine[1].repostedBy).toBeNull();
    expect(mine[2].id).toBe(original.id);
    expect(mine[2].repostedBy).toBeNull();
  });

  it("the following feed carries a followed user's repost; a stranger's repost stays out of it, and the viewer's own repost is included", async () => {
    const author = await createTestUser();
    const followed = await createTestUser();
    const stranger = await createTestUser();
    const viewer = await createTestUser();
    const [a, b, c] = await seedPosts(author.id, 3);

    await call(appRouter.user.follow, { userId: followed.id }, { context: contextFor(viewer) });
    const at = new Date(Date.now() + 60_000);
    await seedRepost(a.id, followed.id, at);
    await seedRepost(b.id, stranger.id, at);
    await seedRepost(c.id, viewer.id, at);

    const feed = await call(
      appRouter.post.list,
      { feed: "following" },
      { context: contextFor(viewer) },
    );
    const mine = feed.items.filter((i) => [a.id, b.id, c.id].includes(i.id));

    const repostedIds = mine.filter((i) => i.repostedBy).map((i) => i.id);
    expect(repostedIds).toContain(a.id);
    expect(repostedIds).toContain(c.id);
    // The stranger's repost never enters the following feed: neither their
    // authored post nor their amplification is the viewer's to see here.
    expect(mine.filter((i) => i.id === b.id)).toHaveLength(0);
  });

  it("a repost event carries the ORIGINAL's post id, so reposting a repost is unexpressable — the UI can only amplify the original", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);
    await seedRepost(original.id, reposter.id, new Date());

    const feed = await call(appRouter.post.list, {}, { context: contextFor(reposter) });
    const event = feed.items.find((i) => i.repostedBy && i.id === original.id);

    expect(event).toBeDefined();
    expect(event!.id).toBe(original.id);
    expect(event!.author.id).toBe(author.id);
    expect(event!.repostedBy!.id).toBe(reposter.id);
  });

  it("keyset pagination across interleaved posts and reposts never repeats or skips an event", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const viewer = await createTestUser();
    // 6 authored posts + 3 reposts of every other one = 9 events.
    const seeded = await seedPosts(author.id, 6, {
      createdAt: (i) => new Date(Date.UTC(2026, 0, 1, 12, 0, i)),
    });
    for (const target of [0, 2, 4]) {
      await seedRepost(
        seeded[target].id,
        reposter.id,
        new Date(Date.UTC(2026, 0, 1, 12, 0, 6 + target)),
      );
    }

    const seen: string[] = [];
    const nextPage = (viewer: TestUser, cursor: string | undefined) =>
      call(appRouter.post.list, { limit: 2, cursor }, { context: contextFor(viewer) });
    let cursor: string | undefined = undefined;
    for (;;) {
      const page = await nextPage(viewer, cursor);
      // The feed is global and other tests' posts ride along; only THIS
      // test's events are counted, and page boundaries prove the walk by
      // landing between them.
      seen.push(
        ...page.items
          .filter((i) => seeded.some((s) => s.id === i.id))
          .map((i) => `${i.repostedBy ? "r:" : "p:"}${i.id}`),
      );
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Every authored post appears exactly once as a post event, and each
    // reposted one exactly once more as a repost event — the no-dedup rule.
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    expect(seen.filter((k) => k.startsWith("r:"))).toHaveLength(3);
  });

  it("a repost whose original was author-deleted STAYS in the feed and renders the deletion stub in place of the embedded post", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const viewer = await createTestUser();
    const [original] = await seedPosts(author.id, 1);
    await seedRepost(original.id, reposter.id, new Date());

    await call(appRouter.post.delete, { postId: original.id }, { context: contextFor(author) });

    const feed = await call(appRouter.post.list, {}, { context: contextFor(viewer) });
    const event = feed.items.find((i) => i.id === original.id && i.repostedBy);

    expect(event).toBeDefined();
    expect(event!.deleted).toBe(true);
    expect(event!.content).toBeNull();
    expect(event!.repostedBy!.id).toBe(reposter.id);
  });

  it("a repost whose original was removed by moderation STAYS in the feed and renders the removal stub", async () => {
    const moderator = await createModerator();
    const author = await createTestUser();
    const reposter = await createTestUser();
    const viewer = await createTestUser();
    const [original] = await seedPosts(author.id, 1);
    await seedRepost(original.id, reposter.id, new Date());

    await call(
      appRouter.moderation.removePost,
      { postId: original.id, reason: "spam" },
      { context: contextFor(moderator) },
    );

    const feed = await call(appRouter.post.list, {}, { context: contextFor(viewer) });
    const event = feed.items.find((i) => i.id === original.id && i.repostedBy);

    expect(event).toBeDefined();
    expect(event!.removed).toBe(true);
    expect(event!.content).toBeNull();
    // The reposter keeps their attribution; the stub is the original's.
    expect(event!.repostedBy!.id).toBe(reposter.id);
  });

  it("a repost whose original author is hidden by a block keeps the reposter's event and redacts the embedded original to unavailable", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const viewer = await createTestUser();
    const [original] = await seedPosts(author.id, 1);
    await seedRepost(original.id, reposter.id, new Date());

    await call(appRouter.moderation.block, { userId: viewer.id }, { context: contextFor(author) });

    const feed = await call(appRouter.post.list, {}, { context: contextFor(viewer) });
    const event = feed.items.find((i) => i.id === original.id && i.repostedBy);
    expect(event).toBeDefined();
    expect(event).toMatchObject({
      unavailable: true,
      content: null,
      attachments: [],
      author: { id: "", name: "", username: null, displayUsername: null, image: null },
      repostedBy: { id: reposter.id },
    });
    expect(event?.likeCount).toBe(0);
    expect(event?.replyCount).toBe(0);
    expect(event?.repostCount).toBe(0);
    expect(event?.viewerHasLiked).toBe(false);
    expect(event?.viewerHasReposted).toBe(false);
  });

  it("profile feeds stay the author's own activity: an authorId feed carries no repost events", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);
    await seedRepost(original.id, reposter.id, new Date());

    const authorFeed = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(author) },
    );
    const reposterFeed = await call(
      appRouter.post.list,
      { authorId: reposter.id },
      { context: contextFor(reposter) },
    );

    expect(authorFeed.items.every((i) => i.repostedBy === null)).toBe(true);
    expect(reposterFeed.items).toHaveLength(0);
  });
});

describe("quote posts", () => {
  it("a quote is a normal post: it lists in feeds and its profile, threads to its permalink, and embeds the quoted post everywhere", async () => {
    const author = await createTestUser();
    const quoter = await createTestUser();
    const viewer = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    const created = await call(
      appRouter.post.create,
      { content: "look at this", quotedPostId: original.id },
      { context: contextFor(quoter) },
    );
    expect(created.quotedPostId).toBe(original.id);

    const [feed, thread, search, profile] = await Promise.all([
      call(appRouter.post.list, {}, { context: contextFor(viewer) }),
      call(appRouter.post.thread, { postId: created.id }, { context: contextFor(viewer) }),
      call(appRouter.search.posts, { q: "look at this" }, { context: contextFor(viewer) }),
      call(appRouter.post.list, { authorId: quoter.id }, { context: contextFor(viewer) }),
    ]);

    const fromFeed = feed.items.find((i) => i.id === created.id)!;
    expect(fromFeed.quoted?.id).toBe(original.id);
    expect(fromFeed.quoted?.content).toBeTypeOf("string");
    expect(fromFeed.quoted?.author.id).toBe(author.id);
    expect(thread.post.quoted?.id).toBe(original.id);
    expect(search.items.find((i) => i.id === created.id)).toBeDefined();
    expect(profile.items.find((i) => i.id === created.id)).toBeDefined();
  });

  it("a quote whose original was author-deleted keeps its own text and renders the deletion stub for the embedded post", async () => {
    const author = await createTestUser();
    const quoter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    const created = await call(
      appRouter.post.create,
      { content: "quote survives", quotedPostId: original.id },
      { context: contextFor(quoter) },
    );
    await call(appRouter.post.delete, { postId: original.id }, { context: contextFor(author) });

    const feed = await call(
      appRouter.post.list,
      { authorId: quoter.id },
      { context: contextFor(quoter) },
    );
    const quote = feed.items.find((i) => i.id === created.id)!;

    expect(quote.content).toBe("quote survives");
    expect(quote.quoted).toMatchObject({ id: original.id, deleted: true, content: null });
  });

  it("a quote whose original was removed renders the removal stub for the embedded post, and the reason stays author-only", async () => {
    const moderator = await createModerator();
    const author = await createTestUser();
    const quoter = await createTestUser();
    const stranger = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    const created = await call(
      appRouter.post.create,
      { content: "quoting soon-to-be-removed", quotedPostId: original.id },
      { context: contextFor(quoter) },
    );
    await call(
      appRouter.moderation.removePost,
      { postId: original.id, reason: "spam" },
      { context: contextFor(moderator) },
    );

    const [asStranger, asAuthor] = await Promise.all([
      call(appRouter.post.thread, { postId: created.id }, { context: contextFor(stranger) }),
      call(appRouter.post.thread, { postId: created.id }, { context: contextFor(author) }),
    ]);

    expect(asStranger.post.quoted).toMatchObject({ removed: true, content: null });
    expect(asStranger.post.quoted!.removedReason).toBeNull();
    // The embedded stub follows the same author-only rule as the outer post:
    // the original's author is owed the why, nobody else.
    expect(asAuthor.post.quoted!.removedReason).toBe("spam");
  });

  it("a quote whose quoted author is blocked reads like the author is gone: the embedded post is null, the quote's own text survives", async () => {
    const author = await createTestUser();
    const quoter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    const created = await call(
      appRouter.post.create,
      { content: "quoted someone who then blocked me", quotedPostId: original.id },
      { context: contextFor(quoter) },
    );
    await call(appRouter.moderation.block, { userId: quoter.id }, { context: contextFor(author) });

    const thread = await call(
      appRouter.post.thread,
      { postId: created.id },
      { context: contextFor(quoter) },
    );

    expect(thread.post.content).toBe("quoted someone who then blocked me");
    expect(thread.post.quoted).toBeNull();
    expect(thread.post.quotedPostId).toBe(original.id);
  });

  it("quoting a post whose author blocked the caller reads as NOT_FOUND — same rule as replying", async () => {
    const author = await createTestUser();
    const quoter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    await call(appRouter.moderation.block, { userId: quoter.id }, { context: contextFor(author) });

    await expect(
      call(
        appRouter.post.create,
        { content: "sneaky quote", quotedPostId: original.id },
        { context: contextFor(quoter) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a reply cannot also be a quote — one embedded post per card", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const [a, b] = await seedPosts(author.id, 2);

    await expect(
      call(
        appRouter.post.create,
        { content: "both at once", parentId: a.id, quotedPostId: b.id },
        { context: contextFor(viewer) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the moderation case view shows the quoted post with raw content — a removed quote's evidence stays reviewable", async () => {
    const moderator = await createModerator();
    const author = await createTestUser();
    const quoter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    const created = await call(
      appRouter.post.create,
      { content: "the quoting post", quotedPostId: original.id },
      { context: contextFor(quoter) },
    );
    await call(
      appRouter.moderation.removePost,
      { postId: original.id, reason: "spam" },
      { context: contextFor(moderator) },
    );

    const target = await call(
      appRouter.moderation.case,
      { targetType: "post", targetId: created.id },
      { context: contextFor(moderator) },
    );

    expect(target.target.kind).toBe("post");
    if (target.target.kind === "post") {
      expect(target.target.quotedPostId).toBe(original.id);
      // Raw content even though the original is removed — the moderator
      // projection the case view already uses for the target itself.
      expect(target.target.quoted?.id).toBe(original.id);
      expect(target.target.quoted?.content).toContain("seed post");
    }
  });

  it("hard-deleting the quoted post leaves the quote standing with a null embedded card — quoted_post_id carries no FK on purpose", async () => {
    const author = await createTestUser();
    const quoter = await createTestUser();
    const [original] = await seedPosts(author.id, 1);

    const created = await call(
      appRouter.post.create,
      { content: "quote of a doomed post", quotedPostId: original.id },
      { context: contextFor(quoter) },
    );

    // A hard row delete only an account cascade performs in production. Had
    // `quoted_post_id` carried `onDelete: cascade` (like `parent_id`), this
    // would have taken the quoter's own post with it.
    await db.delete(post).where(eq(post.id, original.id));

    const thread = await call(
      appRouter.post.thread,
      { postId: created.id },
      { context: contextFor(quoter) },
    );
    expect(thread.post.content).toBe("quote of a doomed post");
    expect(thread.post.quoted).toBeNull();
  });
});
