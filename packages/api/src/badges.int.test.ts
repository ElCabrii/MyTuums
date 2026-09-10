import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { LEGAL_VERSION } from "@my-tuums/auth/rules";
import { closeDb, db } from "@my-tuums/db";
import { grantFounderBadge } from "@my-tuums/db/grant-founder-badge";
import { follow, postLike, user, userBadge } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import {
  contextFor,
  createTestUser,
  seedPosts,
  setUserBan,
  truncateAll,
} from "./testing/harness.js";

/**
 * The badge system's integration pins (issue #308), over the three surfaces
 * that own the behavior: the auth sign-up path (join-badge stamping),
 * `user.follow` and `post.like` (tiered stamping, which upgrades — one row
 * per family, raised to the next tier by the crossing that earns it), and
 * `user.byUsername` (display set + the suspended stub's redaction). The
 * catalog itself — ids, thresholds, tier selection, canonical order — is
 * unit-pinned in badges.test.ts; these tests pin the database behavior
 * around it.
 *
 * Every fixture that needs more than a couple of accounts is bulk-inserted as
 * bare `user` rows rather than BetterAuth sign-ups: a threshold is 1,000+ or
 * 10,000+ accounts, and minting that many real sessions is minutes of scrypt
 * for no extra assertion. Bare rows carry no badges — only the real creation
 * path stamps the join badges — which is also what keeps every non-join
 * assertion below free of badges its subject never earned.
 *
 * The join tests run FIRST and top the user count up to exact targets,
 * because the sign-up hook ranks a new account by how many rows already
 * exist; the count only grows within the file, and the later suites seed
 * past every rank that could matter.
 */
beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

type BareUser = typeof user.$inferInsert;

/** Bare `user` rows in bulk — no session, no credential; presence is all a badge reads. */
async function seedBareUsers(count: number): Promise<string[]> {
  const rows: BareUser[] = Array.from({ length: count }, () => ({
    id: randomUUID(),
    name: "Badge Fixture",
    email: `badges+${randomUUID()}@example.com`,
  }));
  const ids: string[] = [];
  for (const part of chunk(rows, 4000)) {
    const inserted = await db.insert(user).values(part).returning({ id: user.id });
    ids.push(...inserted.map((row) => row.id));
  }
  return ids;
}

/** Seeds bare rows until exactly `target` accounts exist — the next sign-up's rank. */
async function topUpUsersTo(target: number): Promise<void> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(user);
  if (row.count < target) await seedBareUsers(target - row.count);
}

/** A profile-read subject with a controlled handle (a bare row — no badges). */
async function seedSubjectUser(username: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      id: randomUUID(),
      name: username,
      email: `badges+${randomUUID()}@example.com`,
      username,
      displayUsername: username,
    })
    .returning({ id: user.id });
  return row.id;
}

/** Signs up through the production auth instance — the only path that stamps join badges. */
async function signUpFresh(username: string): Promise<string> {
  await auth.api.signUpEmail({
    body: {
      email: `badges+${randomUUID()}@example.com`,
      password: "vitest-Sup3rSecret!",
      name: "Badge Fixture",
      username,
      legalAcceptedAt: new Date(),
      legalVersion: LEGAL_VERSION,
    },
  });
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username))
    .limit(1);
  return row.id;
}

async function seedFollows(followerIds: readonly string[], followingId: string): Promise<void> {
  for (const part of chunk(followerIds, 8000)) {
    await db.insert(follow).values(part.map((followerId) => ({ followerId, followingId })));
  }
}

async function seedLikes(postId: string, likerIds: readonly string[]): Promise<void> {
  for (const part of chunk(likerIds, 8000)) {
    await db
      .insert(postLike)
      .values(part.map((userId) => ({ postId, userId })))
      .onConflictDoNothing();
  }
}

/** The subject's `user_badge` rows — the stamping contract, straight from the table. */
function stampedRows(userId: string) {
  return db.select({ badge: userBadge.badge }).from(userBadge).where(eq(userBadge.userId, userId));
}

describe("join-badge stamping at sign-up (issue #308)", () => {
  it("stamps only super_early_access for an account created in the first 50 — never both tiers", async () => {
    await topUpUsersTo(30);
    const username = `dayzero${randomUUID().slice(0, 8)}`;
    const subject = await signUpFresh(username);

    // The two join badges are tiers of one family: the first 50 carry
    // super-early alone, not super-early beside early.
    expect(await stampedRows(subject)).toEqual([{ badge: "super_early_access" }]);

    const viewer = await createTestUser();
    const profile = await call(
      appRouter.user.byUsername,
      { username },
      { context: contextFor(viewer) },
    );
    expect(profile.badges).toEqual(["super_early_access"]);
  });

  it("stamps early_access for the 999th account — the 1,000th earns nothing", async () => {
    await topUpUsersTo(999);
    const subject = await signUpFresh(`ranknine${randomUUID().slice(0, 8)}`);
    expect(await stampedRows(subject)).toEqual([{ badge: "early_access" }]);

    await topUpUsersTo(1_000);
    const latecomer = await signUpFresh(`rankout${randomUUID().slice(0, 8)}`);
    expect(await stampedRows(latecomer)).toEqual([]);
  });
});

describe("user.follow badge stamping (issue #308)", () => {
  it("upgrades the tier as thresholds are passed; unfollows and recedes never take it back", async () => {
    const username = `keepsake${randomUUID().slice(0, 8)}`;
    const subject = await seedSubjectUser(username);
    const followers = await seedBareUsers(1_000);
    await seedFollows(followers, subject);

    // 1,000 followers is exactly at the threshold — nothing earned yet,
    // proving the stamp waits for "passed", not "reached".
    expect(await stampedRows(subject)).toEqual([]);

    const first = await createTestUser();
    await call(appRouter.user.follow, { userId: subject }, { context: contextFor(first) });
    expect(await stampedRows(subject)).toEqual([{ badge: "popular" }]);

    // The retried follow: idempotent for the follow, so it must be for the badge.
    await call(appRouter.user.follow, { userId: subject }, { context: contextFor(first) });
    expect(await stampedRows(subject)).toEqual([{ badge: "popular" }]);

    // Followers recede strictly below the threshold. An achievement once
    // earned is kept — the row stays, and the profile keeps displaying the
    // tier even though the live count no longer reaches it.
    await db
      .delete(follow)
      .where(
        and(eq(follow.followingId, subject), inArray(follow.followerId, followers.slice(0, 2))),
      );

    const viewer = await createTestUser();
    const profile = () =>
      call(appRouter.user.byUsername, { username }, { context: contextFor(viewer) });
    expect((await profile()).followerCount).toBe(999);
    expect((await profile()).badges).toEqual(["popular"]);

    // Climbing back over the threshold is not a second achievement: the
    // insert conflicts, and the row count stays at one.
    const second = await createTestUser();
    const third = await createTestUser();
    await call(appRouter.user.follow, { userId: subject }, { context: contextFor(second) });
    await call(appRouter.user.follow, { userId: subject }, { context: contextFor(third) });
    expect(await stampedRows(subject)).toEqual([{ badge: "popular" }]);

    // The next threshold upgrades in place: "popular" becomes "rising_star",
    // it does not stack beside it.
    const surge = await seedBareUsers(9_001);
    await seedFollows(surge, subject);
    const fourth = await createTestUser();
    await call(appRouter.user.follow, { userId: subject }, { context: contextFor(fourth) });
    expect(await stampedRows(subject)).toEqual([{ badge: "rising_star" }]);
    expect((await profile()).badges).toEqual(["rising_star"]);

    // Receding below the LOWER tier again stamps nothing: the family's
    // higher tier was already earned and is never withdrawn, so a count
    // that re-crosses 1,000 has nothing new to say.
    await db
      .delete(follow)
      .where(
        and(eq(follow.followingId, subject), inArray(follow.followerId, surge.slice(0, 8_994))),
      );
    const fifth = await createTestUser();
    await call(appRouter.user.follow, { userId: subject }, { context: contextFor(fifth) });
    expect(await stampedRows(subject)).toEqual([{ badge: "rising_star" }]);
  });
});

describe("post.like badge stamping (issue #308)", () => {
  it("stamps the tier exactly once when a like first passes 10,000; a retried like mints nothing", async () => {
    const author = await seedSubjectUser(`overnight${randomUUID().slice(0, 8)}`);
    const [target] = await seedPosts(author, 1);
    const likers = await seedBareUsers(10_000);
    await seedLikes(target.id, likers);
    const liker = await createTestUser();

    // 10,000 likes is exactly at the threshold — nothing earned yet, proving
    // the stamp waits for "passed", not "reached".
    expect(await stampedRows(author)).toEqual([]);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    expect(await stampedRows(author)).toEqual([{ badge: "noticed" }]);

    // The retried like: idempotent for the like, so it must be for the badge.
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    expect(await stampedRows(author)).toEqual([{ badge: "noticed" }]);
  });

  it("upgrades noticed to trendy when a post passes the next threshold; recedes never take it back", async () => {
    const author = await seedSubjectUser(`flashfame${randomUUID().slice(0, 8)}`);
    const [firstPost, secondPost] = await seedPosts(author, 2);
    const likers = await seedBareUsers(100_000);
    await seedLikes(firstPost.id, likers.slice(0, 10_000));
    await seedLikes(secondPost.id, likers);

    const first = await createTestUser();
    await call(appRouter.post.like, { postId: firstPost.id }, { context: contextFor(first) });
    expect(await stampedRows(author)).toEqual([{ badge: "noticed" }]);

    // A different post passing the NEXT threshold upgrades the family's row:
    // the badge is measured by the author's most-liked post, and "noticed"
    // becomes "trendy" rather than stacking beside it.
    const second = await createTestUser();
    await call(appRouter.post.like, { postId: secondPost.id }, { context: contextFor(second) });
    expect(await stampedRows(author)).toEqual([{ badge: "trendy" }]);

    const viewer = await createTestUser();
    const authorHandle = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, author));
    const profile = await call(
      appRouter.user.byUsername,
      { username: authorHandle[0].username! },
      { context: contextFor(viewer) },
    );
    expect(profile.badges).toEqual(["trendy"]);

    // Likes receding below the trendy threshold keep the upgrade — an
    // achievement once earned is never withdrawn.
    await db
      .delete(postLike)
      .where(
        and(eq(postLike.postId, secondPost.id), inArray(postLike.userId, likers.slice(0, 100))),
      );
    expect(await stampedRows(author)).toEqual([{ badge: "trendy" }]);

    // And a like that re-crosses only the LOWER threshold stamps nothing:
    // the family already holds trendy, and there is nothing below it to say.
    const third = await createTestUser();
    await call(appRouter.post.like, { postId: firstPost.id }, { context: contextFor(third) });
    expect(await stampedRows(author)).toEqual([{ badge: "trendy" }]);
    // The trendy threshold is 100,001 likes from 100,001 distinct accounts:
    // seeding them is the bulk of this test's runtime, not the assertions.
  }, 120_000);
});

describe("founder badge grant (issue #308)", () => {
  it("grants up to the three founder accounts, never a re-grant, never a fourth", async () => {
    const founder = await seedSubjectUser(`thefounder${randomUUID().slice(0, 8)}`);
    const handle = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, founder));
    const username = handle[0].username!;

    await expect(grantFounderBadge(username)).resolves.toContain("Founder");
    expect(await stampedRows(founder)).toEqual([{ badge: "founder" }]);

    const viewer = await createTestUser();
    const profile = await call(
      appRouter.user.byUsername,
      { username },
      { context: contextFor(viewer) },
    );
    // A bare fixture carries no other badge, so founder is the whole display set.
    expect(profile.badges).toEqual(["founder"]);

    // Once per account: a repeat for the same account is refused.
    await expect(grantFounderBadge(username)).rejects.toThrow(/already carries/);

    // The two remaining partners are granted, then the budget is spent.
    // (The prefixes stay short of the 20-char handle bound with the uuid
    // suffix appended — `user.byUsername` validates its input.)
    const partnerTwo = await seedSubjectUser(`foundertwo${randomUUID().slice(0, 8)}`);
    const partnerThree = await seedSubjectUser(`founderthree${randomUUID().slice(0, 7)}`);
    for (const partner of [partnerTwo, partnerThree]) {
      const partnerHandle = await db
        .select({ username: user.username })
        .from(user)
        .where(eq(user.id, partner));
      await expect(grantFounderBadge(partnerHandle[0].username!)).resolves.toContain("Founder");
    }

    const latecomer = await seedSubjectUser(`founderfour${randomUUID().slice(0, 8)}`);
    const latecomerHandle = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, latecomer));
    await expect(grantFounderBadge(latecomerHandle[0].username!)).rejects.toThrow(/spent/);
  });

  it("redacts the founder badge on the suspended stub, like every authored field", async () => {
    // The earliest-granted holder, deterministically — the grant order is
    // pinned by the test above, not by whichever row the query returns first.
    const founder = await db
      .select({ userId: userBadge.userId })
      .from(userBadge)
      .where(eq(userBadge.badge, "founder"))
      .orderBy(userBadge.earnedAt)
      .limit(1);
    const handle = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, founder[0].userId));
    const viewer = await createTestUser();

    await setUserBan(founder[0].userId, { reason: "test", expiresAt: null });
    const profile = await call(
      appRouter.user.byUsername,
      { username: handle[0].username! },
      { context: contextFor(viewer) },
    );

    expect(profile.suspended).toBe(true);
    expect(profile.badges).toEqual([]);
  });
});
