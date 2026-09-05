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
});
