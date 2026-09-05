import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@my-tuums/db";
import { post, user } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { contextFor, createTestUser, seedPosts, truncateAll } from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

async function setPrivate(userId: string, isPrivate: boolean): Promise<void> {
  await db.update(user).set({ isPrivate }).where(eq(user.id, userId));
}

describe("account privacy (issue #328)", () => {
  it("private posts drop from the global feed for non-followers, but the author and followers still see them", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    await setPrivate(alice.id, true);

    const [post] = await seedPosts(alice.id, 1);
    // Bob follows Alice (needs request + accept since Alice is private).
    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    const inbox = await call(appRouter.user.followRequest.list, {}, { context: contextFor(alice) });
    expect(inbox.items.map((i) => i.id)).toContain(bob.id);
    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );

    const globalForCarol = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(carol) },
    );
    expect(globalForCarol.items.map((i) => i.id)).not.toContain(post.id);

    const globalForBob = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(bob) },
    );
    expect(globalForBob.items.map((i) => i.id)).toContain(post.id);

    const globalForAlice = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(alice) },
    );
    expect(globalForAlice.items.map((i) => i.id)).toContain(post.id);
  });

  it("following a private account creates a request, not an edge — accepting converts it", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);

    const res = await call(
      appRouter.user.follow,
      { userId: alice.id },
      { context: contextFor(bob) },
    );
    expect(res.viewerIsFollowing).toBe(false);
    expect(res.requested).toBe(true);

    const profile = await call(
      appRouter.user.byUsername,
      { username: alice.session.user.username! },
      { context: contextFor(bob) },
    );
    expect(profile.viewerIsFollowing).toBe(false);
    expect(profile.hasRequested).toBe(true);

    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );

    const after = await call(
      appRouter.user.byUsername,
      { username: alice.session.user.username! },
      { context: contextFor(bob) },
    );
    expect(after.viewerIsFollowing).toBe(true);
    expect(after.hasRequested).toBe(false);
  });

  it("rejecting and cancelling remove the request without an edge", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    await setPrivate(alice.id, true);

    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await call(
      appRouter.user.followRequest.reject,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );
    const afterReject = await call(
      appRouter.user.byUsername,
      { username: alice.session.user.username! },
      { context: contextFor(bob) },
    );
    expect(afterReject.viewerIsFollowing).toBe(false);
    expect(afterReject.hasRequested).toBe(false);

    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(carol) });
    await call(
      appRouter.user.followRequest.cancel,
      { targetId: alice.id },
      { context: contextFor(carol) },
    );
    const afterCancel = await call(
      appRouter.user.byUsername,
      { username: alice.session.user.username! },
      { context: contextFor(carol) },
    );
    expect(afterCancel.hasRequested).toBe(false);
  });

  it("private graphs read as empty for non-followers", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    await setPrivate(alice.id, true);

    // Bob follows Alice via request; Carol does not.
    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );

    const followersForCarol = await call(
      appRouter.user.followers,
      { username: alice.session.user.username! },
      { context: contextFor(carol) },
    );
    expect(followersForCarol.items).toHaveLength(0);

    const followersForBob = await call(
      appRouter.user.followers,
      { username: alice.session.user.username! },
      { context: contextFor(bob) },
    );
    expect(followersForBob.items.map((i) => i.id)).toContain(bob.id);
  });

  it("post.create inherits the account default and allows per-post override", async () => {
    const alice = await createTestUser();
    await setPrivate(alice.id, true);

    const implicit = await call(
      appRouter.post.create,
      { content: "private by default" },
      { context: contextFor(alice) },
    );
    const [implicitRow] = await db
      .select({ isPrivate: post.isPrivate })
      .from(post)
      .where(eq(post.id, implicit.id))
      .limit(1);
    expect(implicitRow?.isPrivate).toBe(true);

    const opened = await call(
      appRouter.post.create,
      { content: "opened explicitly", isPrivate: false },
      { context: contextFor(alice) },
    );
    // A public post from a private account is still gated by the account —
    // the feed hides it from non-followers via the author flag.
    const bob = await createTestUser();
    const globalForBob = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(bob) },
    );
    expect(globalForBob.items.map((i) => i.id)).not.toContain(opened.id);
    expect(globalForBob.items.map((i) => i.id)).not.toContain(implicit.id);
  });

  it("per-post private hides from non-followers even when the account is public", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();

    const priv = await call(
      appRouter.post.create,
      { content: "followers only", isPrivate: true },
      { context: contextFor(alice) },
    );

    const globalForBob = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(bob) },
    );
    expect(globalForBob.items.map((i) => i.id)).not.toContain(priv.id);

    const threadCall = call(
      appRouter.post.thread,
      { postId: priv.id },
      { context: contextFor(bob) },
    );
    await expect(threadCall).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("search excludes private posts and private accounts for non-followers", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);
    const tag = `priv${Date.now().toString(36)}`;
    await call(appRouter.post.create, { content: `hello #${tag}` }, { context: contextFor(alice) });

    const posts = await call(appRouter.search.posts, { q: tag }, { context: contextFor(bob) });
    expect(posts.items).toHaveLength(0);

    const users = await call(
      appRouter.search.users,
      { q: alice.session.user.username! },
      { context: contextFor(bob) },
    );
    expect(users.items.map((i) => i.id)).not.toContain(alice.id);
  });

  it("notification reply previews redact a private replier's content while the row still surfaces", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);

    // Bob's post is public, so Alice (private) may reply to it; her reply
    // inherits her account default and is hidden from Bob in threads.
    const [parent] = await seedPosts(bob.id, 1);
    const reply = await call(
      appRouter.post.create,
      { content: "secret reply", parentId: parent.id },
      { context: contextFor(alice) },
    );

    const page = await call(appRouter.notification.list, {}, { context: contextFor(bob) });
    expect(page.items.map((i) => i.postId)).toContain(reply.id);
    const row = page.items.find((i) => i.postId === reply.id)!;
    expect(row.type).toBe("reply");
    // The row surfaces — Bob should know someone replied — but the preview
    // must not leak the private text Bob cannot open.
    expect(row.postContent).toBeNull();
    expect(row.postAttachments).toEqual([]);
  });

  it("notification like previews do not redact the recipient's own post", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);
    const [target] = await seedPosts(bob.id, 1);

    // Alice likes Bob's public post: the notice previews Bob's own post,
    // which Bob may always see, so no redaction applies.
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(alice) });

    const page = await call(appRouter.notification.list, {}, { context: contextFor(bob) });
    const row = page.items.find((i) => i.type === "like");
    expect(row?.postId).toBe(target.id);
    expect(row?.postContent).toMatch(/^seed post 0 /);
  });

  it("accepting notifies the target they gained a follower, not the requester", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);

    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );

    // The edge is Bob → Alice, so Alice (the followed) gets the same `follow`
    // notice a public follow mints — actor Bob, recipient Alice.
    const forAlice = await call(appRouter.notification.list, {}, { context: contextFor(alice) });
    const followRow = forAlice.items.find((i) => i.type === "follow");
    expect(followRow?.actor?.id).toBe(bob.id);

    // Bob gets no backwards "{Alice} followed you" — Alice did not follow him.
    const forBob = await call(appRouter.notification.list, {}, { context: contextFor(bob) });
    expect(forBob.items.filter((i) => i.type === "follow")).toHaveLength(0);
  });

  it("re-following a private account while already following reports Following, not Requested", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);

    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );

    // A retry after a lost response, or a follow against a stale profile —
    // the edge is the terminal state, so the answer stays Following.
    const res = await call(
      appRouter.user.follow,
      { userId: alice.id },
      { context: contextFor(bob) },
    );
    expect(res.viewerIsFollowing).toBe(true);
    expect(res.requested).toBe(false);
  });

  it("following after the target goes public clears the pre-existing request", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);

    // Bob requests while Alice is private; Alice toggles public before acting.
    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await setPrivate(alice.id, false);

    const res = await call(
      appRouter.user.follow,
      { userId: alice.id },
      { context: contextFor(bob) },
    );
    expect(res.viewerIsFollowing).toBe(true);
    expect(res.requested).toBe(false);

    // The edge stands and no orphaned request survives it: the inbox is empty
    // and the profile reads Following, not Requested.
    const inbox = await call(appRouter.user.followRequest.list, {}, { context: contextFor(alice) });
    expect(inbox.items.map((i) => i.id)).not.toContain(bob.id);
    const profile = await call(
      appRouter.user.byUsername,
      { username: alice.session.user.username! },
      { context: contextFor(bob) },
    );
    expect(profile.viewerIsFollowing).toBe(true);
    expect(profile.hasRequested).toBe(false);
  });

  it("a text-filtered feed excludes private originals instead of surfacing a redacted oracle", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    await setPrivate(alice.id, true);
    const tag = `oracle${Date.now().toString(36)}`;

    const post = await call(
      appRouter.post.create,
      { content: `hidden words ${tag}` },
      { context: contextFor(alice) },
    );

    // Bob follows Alice, so he can see and amplify the private post; Carol
    // follows Bob (public) but not Alice.
    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );
    await call(appRouter.post.repost, { postId: post.id }, { context: contextFor(bob) });
    await call(appRouter.user.follow, { userId: bob.id }, { context: contextFor(carol) });

    // Unfiltered, Carol sees Bob's event redacted to unavailable — the repost
    // is Bob's, the content is not Carol's to read.
    const unfiltered = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(carol) },
    );
    const redacted = unfiltered.items.find((i) => i.id === post.id && i.repostedBy);
    expect(redacted).toMatchObject({ unavailable: true });

    // Filtered by the hidden words, the event must vanish entirely — matching
    // the raw text while redacting the row would be a one-bit oracle.
    const filtered = await call(
      appRouter.post.list,
      { feed: "global", q: tag },
      { context: contextFor(carol) },
    );
    expect(filtered.items.map((i) => i.id)).not.toContain(post.id);
  });

  it("likes and reposts on private posts stay removable after unfollowing", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    await setPrivate(alice.id, true);
    const [target] = await seedPosts(alice.id, 1);

    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });
    await call(
      appRouter.user.followRequest.accept,
      { requesterId: bob.id },
      { context: contextFor(alice) },
    );
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(bob) });
    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(bob) });

    // Bob unfollows: the post hides from him, but his own rows must not strand.
    await call(appRouter.user.unfollow, { userId: alice.id }, { context: contextFor(bob) });

    const unliked = await call(
      appRouter.post.unlike,
      { postId: target.id },
      { context: contextFor(bob) },
    );
    expect(unliked.viewerHasLiked).toBe(false);
    const unreposted = await call(
      appRouter.post.unrepost,
      { postId: target.id },
      { context: contextFor(bob) },
    );
    expect(unreposted.viewerHasReposted).toBe(false);
  });

  it("your own followers list shows private followers you have not followed back", async () => {
    const alice = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    await setPrivate(bob.id, true);
    // Alice stays public so Bob can follow her directly.

    await call(appRouter.user.follow, { userId: alice.id }, { context: contextFor(bob) });

    const own = await call(
      appRouter.user.followers,
      { username: alice.session.user.username! },
      { context: contextFor(alice) },
    );
    expect(own.items.map((i) => i.id)).toContain(bob.id);

    // A third party who does not follow Bob still cannot enumerate him.
    const forCarol = await call(
      appRouter.user.followers,
      { username: alice.session.user.username! },
      { context: contextFor(carol) },
    );
    expect(forCarol.items.map((i) => i.id)).not.toContain(bob.id);
  });
});
