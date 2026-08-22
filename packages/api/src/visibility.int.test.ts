import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { follow, post } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  seedPosts,
  setUserBan,
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

/** A moderator for the removal fixtures — the moderation suite owns the procedure's own behaviour. */
async function moderatorUser(): Promise<TestUser> {
  const user = await createTestUser();
  await setUserRole(user.id, "moderator");
  return freshSessionFor(user);
}

/** A content-controlled post insert, so search queries can target exactly one post. */
async function seedContent(authorId: string, content: string): Promise<{ id: string }> {
  const [inserted] = await anonContext.db
    .insert(post)
    .values({ authorId, content })
    .returning({ id: post.id });
  return inserted;
}

describe("a live suspension makes the author invisible everywhere", () => {
  it("hides their posts from the global feed, their author feed, the thread, likes, and search", async () => {
    const alice = await createTestUser({ username: "visbanned" });
    const bob = await createTestUser({ username: "visviewer" });
    const carol = await createTestUser({ username: "viscontrol" });
    const alicePosts = await seedPosts(alice.id, 2);
    const tagged = await seedContent(alice.id, "vis-search-tag");
    const controlPost = await seedPosts(carol.id, 1);

    await setUserBan(alice.id, { reason: "spam", expiresAt: new Date(Date.now() + 3_600_000) });

    const globalFeed = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(bob) },
    );
    const ids = globalFeed.items.map((p) => p.id);
    expect(ids).not.toContain(alicePosts[0].id);
    expect(ids).not.toContain(alicePosts[1].id);
    expect(ids).not.toContain(tagged.id);
    expect(ids).toContain(controlPost[0].id);

    const authorFeed = await call(
      appRouter.post.list,
      { authorId: alice.id },
      { context: contextFor(bob) },
    );
    expect(authorFeed.items).toHaveLength(0);

    // The thread reads as nonexistent — same silence as a missing post.
    await expect(
      call(appRouter.post.thread, { postId: alicePosts[0].id }, { context: contextFor(bob) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Post not found." });
    await expect(
      call(appRouter.post.like, { postId: alicePosts[0].id }, { context: contextFor(bob) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Post not found." });
    await expect(
      call(appRouter.post.unlike, { postId: alicePosts[0].id }, { context: contextFor(bob) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Post not found." });

    const searchPosts = await call(
      appRouter.search.posts,
      { q: "vis-search-tag" },
      { context: contextFor(bob) },
    );
    expect(searchPosts.items).toHaveLength(0);
  });

  it("drops them from the following feed — their own posts stay put", async () => {
    const alice = await createTestUser({ username: "visfoll" });
    const bob = await createTestUser({ username: "visfollee" });
    await anonContext.db.insert(follow).values({ followerId: bob.id, followingId: alice.id });
    const alicePost = await seedPosts(alice.id, 1);
    const bobPost = await seedPosts(bob.id, 1);

    await setUserBan(alice.id, { reason: "spam", expiresAt: new Date(Date.now() + 3_600_000) });

    const feed = await call(
      appRouter.post.list,
      { feed: "following" },
      { context: contextFor(bob) },
    );
    const ids = feed.items.map((p) => p.id);
    expect(ids).not.toContain(alicePost[0].id);
    expect(ids).toContain(bobPost[0].id);
  });

  it("hides the account itself from search and the typeahead", async () => {
    const alice = await createTestUser({ username: "vishidden" });
    const bob = await createTestUser({ username: "visfinder" });
    await setUserBan(alice.id, { reason: "spam", expiresAt: new Date(Date.now() + 3_600_000) });

    const results = await call(
      appRouter.search.users,
      { q: "vishidden" },
      { context: contextFor(bob) },
    );
    expect(results.items).toHaveLength(0);
    const typeahead = await call(
      appRouter.search.typeahead,
      { q: "vishidden" },
      { context: contextFor(bob) },
    );
    expect(typeahead.users).toHaveLength(0);
  });

  it("drops the banned account from follower and following lists", async () => {
    const alice = await createTestUser({ username: "vislist" });
    const banned = await createTestUser({ username: "visgone" });
    const carol = await createTestUser({ username: "vispresent" });
    await anonContext.db.insert(follow).values({ followerId: banned.id, followingId: alice.id });
    await anonContext.db.insert(follow).values({ followerId: carol.id, followingId: alice.id });
    await anonContext.db.insert(follow).values({ followerId: alice.id, followingId: banned.id });
    await anonContext.db.insert(follow).values({ followerId: alice.id, followingId: carol.id });

    await setUserBan(banned.id, { reason: "spam", expiresAt: new Date(Date.now() + 3_600_000) });

    const followers = await call(
      appRouter.user.followers,
      { username: "vislist" },
      { context: contextFor(carol) },
    );
    const followerIds = followers.items.map((u) => u.id);
    expect(followerIds).not.toContain(banned.id);
    expect(followerIds).toContain(carol.id);

    const following = await call(
      appRouter.user.following,
      { username: "vislist" },
      { context: contextFor(carol) },
    );
    const followingIds = following.items.map((u) => u.id);
    expect(followingIds).not.toContain(banned.id);
    expect(followingIds).toContain(carol.id);
  });
});

describe("byUsername and the suspension stub", () => {
  it("resolves a live suspension as a stub — `suspended: true`, no ban columns leaked", async () => {
    const alice = await createTestUser({ username: "vissuspended" });
    const bob = await createTestUser({ username: "vissuspviewer" });
    await setUserBan(alice.id, { reason: "spam", expiresAt: new Date(Date.now() + 3_600_000) });

    const profile = await call(
      appRouter.user.byUsername,
      { username: "vissuspended" },
      { context: contextFor(bob) },
    );
    expect(profile.id).toBe(alice.id);
    expect(profile.username).toBe("vissuspended");
    expect(profile.suspended).toBe(true);
    // The profile stub is additive only — `publicUserColumns` is untouched,
    // so the ban columns stay off the wire entirely.
    expect("banned" in profile).toBe(false);
    expect("banReason" in profile).toBe(false);
    expect("banExpires" in profile).toBe(false);
    expect("role" in profile).toBe(false);
  });

  it("an expired suspension restores the account everywhere", async () => {
    const alice = await createTestUser({ username: "visexposed" });
    const bob = await createTestUser({ username: "visexposer" });
    const alicePost = await seedPosts(alice.id, 1);
    await setUserBan(alice.id, { reason: "spam", expiresAt: new Date(Date.now() - 3_600_000) });

    const feed = await call(appRouter.post.list, { feed: "global" }, { context: contextFor(bob) });
    expect(feed.items.map((p) => p.id)).toContain(alicePost[0].id);

    const profile = await call(
      appRouter.user.byUsername,
      { username: "visexposed" },
      { context: contextFor(bob) },
    );
    expect(profile.suspended).toBe(false);

    const results = await call(
      appRouter.search.users,
      { q: "visexposed" },
      { context: contextFor(bob) },
    );
    expect(results.items.map((u) => u.id)).toContain(alice.id);
  });

  it("a permanent ban stays hidden — null expiry is not a sentence that lapses", async () => {
    const alice = await createTestUser({ username: "vispermanent" });
    const bob = await createTestUser({ username: "vispermviewer" });
    const alicePost = await seedPosts(alice.id, 1);
    await setUserBan(alice.id, { reason: "spam", expiresAt: null });

    const feed = await call(appRouter.post.list, { feed: "global" }, { context: contextFor(bob) });
    expect(feed.items.map((p) => p.id)).not.toContain(alicePost[0].id);

    const profile = await call(
      appRouter.user.byUsername,
      { username: "vispermanent" },
      { context: contextFor(bob) },
    );
    expect(profile.suspended).toBe(true);
  });
});

describe("a block hides the two users from each other in both directions", () => {
  it("posts vanish from both feeds, and unblock restores them", async () => {
    const alice = await createTestUser({ username: "visblocker" });
    const bob = await createTestUser({ username: "visblocked" });
    const alicePosts = await seedPosts(alice.id, 1);
    const bobPosts = await seedPosts(bob.id, 1);

    await call(appRouter.moderation.block, { userId: bob.id }, { context: contextFor(alice) });

    const aliceFeed = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(alice) },
    );
    expect(aliceFeed.items.map((p) => p.id)).not.toContain(bobPosts[0].id);
    const bobFeed = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(bob) },
    );
    expect(bobFeed.items.map((p) => p.id)).not.toContain(alicePosts[0].id);

    await call(appRouter.moderation.unblock, { userId: bob.id }, { context: contextFor(alice) });
    const restored = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(alice) },
    );
    expect(restored.items.map((p) => p.id)).toContain(bobPosts[0].id);
  });

  it("profiles 404 in both directions — no existence leak", async () => {
    const alice = await createTestUser({ username: "visblocker2" });
    const bob = await createTestUser({ username: "visblocked2" });
    await call(appRouter.moderation.block, { userId: bob.id }, { context: contextFor(alice) });

    await expect(
      call(appRouter.user.byUsername, { username: "visblocked2" }, { context: contextFor(alice) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "No such user." });
    await expect(
      call(appRouter.user.byUsername, { username: "visblocker2" }, { context: contextFor(bob) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "No such user." });

    await call(appRouter.moderation.unblock, { userId: bob.id }, { context: contextFor(alice) });
    const profile = await call(
      appRouter.user.byUsername,
      { username: "visblocked2" },
      { context: contextFor(alice) },
    );
    expect(profile.id).toBe(bob.id);
    expect(profile.suspended).toBe(false);
  });

  it("follow is refused in both directions", async () => {
    const alice = await createTestUser({ username: "visblocker3" });
    const bob = await createTestUser({ username: "visblocked3" });
    await call(appRouter.moderation.block, { userId: bob.id }, { context: contextFor(alice) });

    await expect(
      call(appRouter.user.follow, { userId: bob.id }, { context: contextFor(alice) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can't follow this user." });
    await expect(
      call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can't follow this user." });

    await call(appRouter.moderation.unblock, { userId: bob.id }, { context: contextFor(alice) });
    await expect(
      call(appRouter.user.follow, { userId: bob.id }, { context: contextFor(alice) }),
    ).resolves.toMatchObject({ viewerIsFollowing: true });
  });
});

describe("a hidden parent is not replyable", () => {
  it("replying under a banned author's post reads as nonexistent", async () => {
    const alice = await createTestUser({ username: "vishidparent" });
    const bob = await createTestUser({ username: "visreplier" });
    const alicePost = await seedPosts(alice.id, 1);
    await setUserBan(alice.id, { reason: "spam", expiresAt: new Date(Date.now() + 3_600_000) });

    await expect(
      call(
        appRouter.post.create,
        { content: "reply into the void", parentId: alicePost[0].id },
        { context: contextFor(bob) },
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The post you replied to no longer exists.",
    });
  });
});

describe("removed posts stay visible as stubs — removal is not invisibility", () => {
  it("the feed carries the stub, the thread resolves it, and only the author sees the reason", async () => {
    const author = await createTestUser({ username: "visstubauthor" });
    const viewer = await createTestUser({ username: "visstubviewer" });
    const mod = await moderatorUser();
    const postRow = await seedContent(author.id, "stub me");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );

    const viewerFeed = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(viewer) },
    );
    const viewerItem = viewerFeed.items.find((p) => p.id === postRow.id);
    expect(viewerItem).toBeDefined();
    expect(viewerItem!.removed).toBe(true);
    expect(viewerItem!.content).toBeNull();
    expect(viewerItem!.removedReason).toBeNull();

    const authorFeed = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(author) },
    );
    const authorItem = authorFeed.items.find((p) => p.id === postRow.id);
    expect(authorItem!.removedReason).toBe("spam");

    // Contrast with the ban: the thread still resolves the removed post —
    // the tombstone is a first-class citizen of the conversation.
    const thread = await call(
      appRouter.post.thread,
      { postId: postRow.id },
      { context: contextFor(viewer) },
    );
    expect(thread.post.removed).toBe(true);
    expect(thread.post.content).toBeNull();
  });
});
