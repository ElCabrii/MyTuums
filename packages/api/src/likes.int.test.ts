import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("post.like / post.unlike", () => {
  it("like requires authentication", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await expect(
      call(appRouter.post.like, { postId: target.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("liking an unknown post is NOT_FOUND", async () => {
    const liker = await createTestUser();
    await expect(
      call(appRouter.post.like, { postId: randomUUID() }, { context: contextFor(liker) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("liking twice is idempotent — the (post_id, user_id) primary key IS the rule; onConflictDoNothing is just the mechanism that avoids erroring on the duplicate", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const first = await call(
      appRouter.post.like,
      { postId: target.id },
      { context: contextFor(liker) },
    );
    const second = await call(
      appRouter.post.like,
      { postId: target.id },
      { context: contextFor(liker) },
    );

    expect(first.likeCount).toBe(1);
    expect(second.likeCount).toBe(1);
  });

  it("unliking a post the viewer never liked is a no-op, not an error", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const result = await call(
      appRouter.post.unlike,
      { postId: target.id },
      { context: contextFor(viewer) },
    );

    expect(result.viewerHasLiked).toBe(false);
    expect(result.likeCount).toBe(0);
  });

  it("two different users liking the same post gives likeCount: 2, and viewerHasLiked is per-viewer", async () => {
    const author = await createTestUser();
    const alice = await createTestUser();
    const bob = await createTestUser();
    const stranger = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(alice) });
    const bobResult = await call(
      appRouter.post.like,
      { postId: target.id },
      { context: contextFor(bob) },
    );
    expect(bobResult.likeCount).toBe(2);

    const [fromAlice, fromBob, fromStranger] = await Promise.all([
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(alice) }),
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(bob) }),
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(stranger) }),
    ]);

    expect(fromAlice.post.viewerHasLiked).toBe(true);
    expect(fromBob.post.viewerHasLiked).toBe(true);
    expect(fromStranger.post.viewerHasLiked).toBe(false);
  });

  it("the count returned by like/unlike matches what post.list and post.thread subsequently report", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const likeResult = await call(
      appRouter.post.like,
      { postId: target.id },
      { context: contextFor(liker) },
    );
    const [threadAfterLike, listAfterLike] = await Promise.all([
      call(appRouter.post.thread, { postId: target.id }, { context: contextFor(liker) }),
      call(appRouter.post.list, { authorId: author.id }, { context: contextFor(liker) }),
    ]);
    expect(threadAfterLike.post.likeCount).toBe(likeResult.likeCount);
    expect(listAfterLike.items.find((i) => i.id === target.id)!.likeCount).toBe(
      likeResult.likeCount,
    );

    const unlikeResult = await call(
      appRouter.post.unlike,
      { postId: target.id },
      { context: contextFor(liker) },
    );
    const threadAfterUnlike = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(liker) },
    );
    expect(threadAfterUnlike.post.likeCount).toBe(unlikeResult.likeCount);
  });

  it("deleting a user cascades their likes off the post's count", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    const before = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(author) },
    );
    expect(before.post.likeCount).toBe(1);

    // post_like.user_id references user.id with onDelete: "cascade". Deleting
    // the liker directly (there's no delete-user procedure) is what actually
    // exercises the FK's cascade, rather than an application-level
    // decrement that could paper over a missing cascade in the schema.
    await author.context.db.delete(user).where(eq(user.id, liker.id));

    const after = await call(
      appRouter.post.thread,
      { postId: target.id },
      { context: contextFor(author) },
    );
    expect(after.post.likeCount).toBe(0);
  });
});
