import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("user.byUsername", () => {
  it("never returns email or emailVerified — this is the privacy boundary: widening publicUserColumns should fail this test", async () => {
    const alice = await createTestUser();
    const result = await call(
      appRouter.user.byUsername,
      { username: alice.session.user.username! },
      { context: anonContext },
    );

    expect(Object.keys(result).sort()).toEqual(
      [
        "id",
        "name",
        "username",
        "displayUsername",
        "image",
        // Profile content, added deliberately when profiles became editable —
        // these are what a visitor is meant to see.
        "bio",
        "bannerImage",
        "createdAt",
        "followerCount",
        "followingCount",
        "viewerIsFollowing",
      ].sort(),
    );
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("emailVerified");
    // Reconnaissance, not profile: which accounts a stolen password alone would
    // open, and which provider to phish.
    expect(result).not.toHaveProperty("twoFactorEnabled");
    expect(result).not.toHaveProperty("lastLoginMethod");
    // Settings, not profile. Nobody visiting a profile needs its owner's theme.
    expect(result).not.toHaveProperty("themePreference");
    expect(result).not.toHaveProperty("localePreference");
    expect(result).not.toHaveProperty("dateOfBirth");
  });

  it("followers/following items carry the same public columns — no email there either, since they spread publicUserColumns", async () => {
    const hub = await createTestUser();
    const follower = await createTestUser();
    await call(appRouter.user.follow, { userId: hub.id }, { context: contextFor(follower) });

    const followers = await call(
      appRouter.user.followers,
      { username: hub.session.user.username! },
      { context: anonContext },
    );
    const following = await call(
      appRouter.user.following,
      { username: follower.session.user.username! },
      { context: anonContext },
    );

    expect(followers.items).not.toHaveLength(0);
    expect(following.items).not.toHaveLength(0);
    for (const item of [...followers.items, ...following.items]) {
      expect(item).not.toHaveProperty("email");
      expect(item).not.toHaveProperty("emailVerified");
    }
  });

  it("resolves case-insensitively and preserves the typed display casing", async () => {
    const created = await createTestUser({ username: "AlexMercer" });

    const byMixed = await call(
      appRouter.user.byUsername,
      { username: "AlexMercer" },
      { context: anonContext },
    );
    const byLower = await call(
      appRouter.user.byUsername,
      { username: "alexmercer" },
      { context: anonContext },
    );

    expect(byMixed.id).toBe(created.id);
    expect(byLower.id).toBe(created.id);
    expect(byMixed.username).toBe("alexmercer");
    expect(byMixed.displayUsername).toBe("AlexMercer");
  });

  it("an unknown handle is NOT_FOUND", async () => {
    await expect(
      call(appRouter.user.byUsername, { username: "nosuchhandleatall" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects handles shorter than 3 or longer than 20 characters, and accepts the boundary lengths", async () => {
    await expect(
      call(appRouter.user.byUsername, { username: "ab" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(appRouter.user.byUsername, { username: "a".repeat(21) }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // 3 and 20 chars are valid *lengths*; no user has these exact handles, so
    // the boundary is proven by NOT_FOUND rather than BAD_REQUEST — a
    // BAD_REQUEST here would mean the length check is still off by one.
    await expect(
      call(appRouter.user.byUsername, { username: "abc" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(appRouter.user.byUsername, { username: "a".repeat(20) }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports correct followerCount/followingCount/viewerIsFollowing, false for an anonymous viewer", async () => {
    const hub = await createTestUser();
    const follower = await createTestUser();
    await call(appRouter.user.follow, { userId: hub.id }, { context: contextFor(follower) });

    const hubUsername = hub.session.user.username!;
    const asAnon = await call(
      appRouter.user.byUsername,
      { username: hubUsername },
      { context: anonContext },
    );
    expect(asAnon.followerCount).toBe(1);
    expect(asAnon.viewerIsFollowing).toBe(false);

    const asFollower = await call(
      appRouter.user.byUsername,
      { username: hubUsername },
      { context: contextFor(follower) },
    );
    expect(asFollower.viewerIsFollowing).toBe(true);

    const followerProfile = await call(
      appRouter.user.byUsername,
      { username: follower.session.user.username! },
      { context: anonContext },
    );
    expect(followerProfile.followingCount).toBe(1);
  });
});
