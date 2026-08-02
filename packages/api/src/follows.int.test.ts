import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { follow } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "./context.js";
import { appRouter } from "./router.js";
import { anonContext, contextFor, createTestUser, truncateAll } from "./testing/harness.js";

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

/** Walks `user.followers` to exhaustion via `nextCursor`, collecting every follower id it returns. */
async function walkAllFollowerIds(username: string, context: Context, limit?: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await call(appRouter.user.followers, { username, cursor, limit }, { context });
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) throw new Error("walkAllFollowerIds: pagination looks like it's looping.");
  } while (cursor);

  return ids;
}

/** Walks `user.following` to exhaustion via `nextCursor`, collecting every followee id it returns. */
async function walkAllFollowingIds(username: string, context: Context, limit?: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const page = await call(appRouter.user.following, { username, cursor, limit }, { context });
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) throw new Error("walkAllFollowingIds: pagination looks like it's looping.");
  } while (cursor);

  return ids;
}

describe("user.follow / user.unfollow", () => {
  it("rejects following yourself — the handler guard is a courtesy on top of the follow_not_self CHECK constraint, which is the actual invariant (see the raw-insert test below)", async () => {
    const me = await createTestUser();
    await expect(
      call(appRouter.user.follow, { userId: me.id }, { context: contextFor(me) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("the follow_not_self CHECK constraint rejects a self-follow row even when the handler guard is bypassed entirely", async () => {
    const me = await createTestUser();
    await expect(
      me.context.db.insert(follow).values({ followerId: me.id, followingId: me.id }),
    ).rejects.toThrow();
  });

  it("unfollowing yourself is a legitimate no-op — deliberately NOT symmetric with follow's self-check", async () => {
    const me = await createTestUser();
    const result = await call(
      appRouter.user.unfollow,
      { userId: me.id },
      { context: contextFor(me) },
    );
    expect(result.viewerIsFollowing).toBe(false);
  });

  it("follow is idempotent — followerCount stays 1 after following twice", async () => {
    const follower = await createTestUser();
    const target = await createTestUser();

    const first = await call(
      appRouter.user.follow,
      { userId: target.id },
      { context: contextFor(follower) },
    );
    const second = await call(
      appRouter.user.follow,
      { userId: target.id },
      { context: contextFor(follower) },
    );

    expect(first.followerCount).toBe(1);
    expect(second.followerCount).toBe(1);
  });

  it("follow/unfollow of an unknown user is NOT_FOUND", async () => {
    const follower = await createTestUser();
    await expect(
      call(appRouter.user.follow, { userId: randomUUID() }, { context: contextFor(follower) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(appRouter.user.unfollow, { userId: randomUUID() }, { context: contextFor(follower) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("follow/unfollow require authentication", async () => {
    const target = await createTestUser();
    await expect(
      call(appRouter.user.follow, { userId: target.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.user.unfollow, { userId: target.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("counts are correct from both directions after a follow", async () => {
    const follower = await createTestUser();
    const target = await createTestUser();

    await call(appRouter.user.follow, { userId: target.id }, { context: contextFor(follower) });

    const targetProfile = await call(
      appRouter.user.byUsername,
      { username: target.session.user.username! },
      { context: anonContext },
    );
    const followerProfile = await call(
      appRouter.user.byUsername,
      { username: follower.session.user.username! },
      { context: anonContext },
    );

    expect(targetProfile.followerCount).toBe(1);
    expect(followerProfile.followingCount).toBe(1);
  });
});

describe("user.followers / user.following", () => {
  it("followers and following join opposite columns of the relation", async () => {
    const hub = await createTestUser();
    const followerOfHub = await createTestUser();
    const followedByHub = await createTestUser();

    await call(
      appRouter.user.follow,
      { userId: hub.id },
      { context: contextFor(followerOfHub) },
    );
    await call(
      appRouter.user.follow,
      { userId: followedByHub.id },
      { context: contextFor(hub) },
    );

    const hubUsername = hub.session.user.username!;
    const followers = await call(
      appRouter.user.followers,
      { username: hubUsername },
      { context: anonContext },
    );
    const following = await call(
      appRouter.user.following,
      { username: hubUsername },
      { context: anonContext },
    );

    expect(followers.items.map((i) => i.id)).toEqual([followerOfHub.id]);
    expect(following.items.map((i) => i.id)).toEqual([followedByHub.id]);
  });

  it("followers/following for an unknown handle is NOT_FOUND", async () => {
    await expect(
      call(appRouter.user.followers, { username: "nobodyusesthishandle" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(appRouter.user.following, { username: "nobodyusesthishandle" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a bad cursor is rejected on both lists", async () => {
    const hub = await createTestUser();
    const hubUsername = hub.session.user.username!;

    await expect(
      call(
        appRouter.user.followers,
        { username: hubUsername, cursor: "garbage" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        appRouter.user.following,
        { username: hubUsername, cursor: "garbage" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it(
    "followers paginates by keyset without repeats, even when many rows share created_at — the tie-break hazard the source comments warn about",
    async () => {
      const hub = await createTestUser();
      const followers = await Promise.all(Array.from({ length: 3 }, () => createTestUser()));

      const tiedAt = new Date("2025-06-01T12:00:00.000Z");
      await hub.context.db
        .insert(follow)
        .values(followers.map((f) => ({ followerId: f.id, followingId: hub.id, createdAt: tiedAt })));

      const ids = await walkAllFollowerIds(hub.session.user.username!, anonContext, 1);

      expect(ids).toHaveLength(3);
      expect(new Set(ids)).toEqual(new Set(followers.map((f) => f.id)));
    },
    20_000,
  );

  it(
    "following paginates by keyset without repeats, even when many rows share created_at",
    async () => {
      const hub = await createTestUser();
      const followees = await Promise.all(Array.from({ length: 3 }, () => createTestUser()));

      const tiedAt = new Date("2025-06-01T12:00:00.000Z");
      await hub.context.db
        .insert(follow)
        .values(followees.map((f) => ({ followerId: hub.id, followingId: f.id, createdAt: tiedAt })));

      const ids = await walkAllFollowingIds(hub.session.user.username!, anonContext, 1);

      expect(ids).toHaveLength(3);
      expect(new Set(ids)).toEqual(new Set(followees.map((f) => f.id)));
    },
    20_000,
  );

  it("rejects a cursor minted by a follow list when fed to post.list — the codecs are parameterised on different id schemas", async () => {
    // ./cursor.ts parameterises each codec on the tie-breaker's id schema.
    // A follow cursor's id is a BetterAuth user id (arbitrary text, not
    // uuid-shaped), so post.list's `z.uuid()` codec rejects it outright.
    // (The reverse direction can't prove the same point: a post id *is* a
    // valid non-empty string, so the follow codec's `z.string().min(1)`
    // happily accepts one as a syntactically fine cursor — it just wouldn't
    // match anything real. The asymmetry is the schemas' point, not a gap.)
    const hub = await createTestUser();
    const followerA = await createTestUser();
    const followerB = await createTestUser();

    await call(appRouter.user.follow, { userId: hub.id }, { context: contextFor(followerA) });
    await call(appRouter.user.follow, { userId: hub.id }, { context: contextFor(followerB) });

    const followPage = await call(
      appRouter.user.followers,
      { username: hub.session.user.username!, limit: 1 },
      { context: anonContext },
    );
    expect(followPage.nextCursor).not.toBeNull();

    await expect(
      call(appRouter.post.list, { cursor: followPage.nextCursor! }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
