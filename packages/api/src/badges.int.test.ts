import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
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
 * The badge system's integration pins (issue #308), over the two surfaces
 * that own the behavior: `user.byUsername` (derivation + display set + the
 * suspended stub's redaction) and `post.like` (threshold stamping). The
 * catalog itself — ids, thresholds, tier selection, canonical order — is
 * unit-pinned in badges.test.ts; these tests pin the database behavior around
 * it.
 *
 * Every fixture that needs more than a couple of accounts is bulk-inserted as
 * bare `user` rows rather than BetterAuth sign-ups: a threshold is 1,000+ or
 * 10,000+ accounts, and minting that many real sessions is minutes of scrypt
 * for no extra assertion. The badge derivation only reads the rows. Subjects
 * whose badges are asserted get a controlled `created_at` (backdated below
 * every wall-clock row), so their creation rank is exactly what the test
 * staged — the file truncates in beforeAll, runs in declaration order, and
 * the ranks below never depend on how many users earlier tests created.
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
async function seedBareUsers(count: number, createdAt?: Date): Promise<string[]> {
  const rows: BareUser[] = Array.from({ length: count }, () => ({
    id: randomUUID(),
    name: "Badge Fixture",
    email: `badges+${randomUUID()}@example.com`,
  }));
  // The column is omitted when not given (not passed as `undefined`) so the
  // column's own `defaultNow()` applies — the same convention as seedPosts.
  if (createdAt) {
    for (const row of rows) row.createdAt = createdAt;
  }
  const ids: string[] = [];
  for (const part of chunk(rows, 4000)) {
    const inserted = await db.insert(user).values(part).returning({ id: user.id });
    ids.push(...inserted.map((row) => row.id));
  }
  return ids;
}

/** A profile-read subject with a controlled handle and creation instant. */
async function seedSubjectUser(opts: { username: string; createdAt: Date }): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      id: randomUUID(),
      name: opts.username,
      email: `badges+${randomUUID()}@example.com`,
      username: opts.username,
      displayUsername: opts.username,
      createdAt: opts.createdAt,
    })
    .returning({ id: user.id });
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

describe("user.byUsername badge derivation (issue #308)", () => {
  it("ranks the very first account as super-early — and early, in canonical order", async () => {
    const viewer = await createTestUser();
    const subject = await seedSubjectUser({
      username: `dayzero${randomUUID().slice(0, 8)}`,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const created = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, subject));
    const profile = await call(
      appRouter.user.byUsername,
      { username: created[0].username! },
      { context: contextFor(viewer) },
    );

    expect(profile.badges).toEqual(["super_early_access", "early_access"]);
  });

  it("carries no join badge once 1,000 accounts were created first — and nothing else either", async () => {
    const viewer = await createTestUser();
    // Backdated above the day-zero subject but below every wall-clock row, so
    // exactly these 1,000 precede the subject regardless of test order.
    await seedBareUsers(1_000, new Date("2021-01-01T00:00:00.000Z"));
    const subject = await seedSubjectUser({
      username: `rankedout${randomUUID().slice(0, 8)}`,
      createdAt: new Date(),
    });
    const created = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, subject));
    const profile = await call(
      appRouter.user.byUsername,
      { username: created[0].username! },
      { context: contextFor(viewer) },
    );

    expect(profile.badges).toEqual([]);
  });

  it("derives the follower tier live: >1,000 followers earns popular, dropping below loses it", async () => {
    const viewer = await createTestUser();
    const subject = await seedSubjectUser({
      username: `hummingbird${randomUUID().slice(0, 8)}`,
      createdAt: new Date("2020-02-01T00:00:00.000Z"),
    });
    const followers = await seedBareUsers(1_001);
    await seedFollows(followers, subject);
    const created = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, subject));

    const read = () =>
      call(
        appRouter.user.byUsername,
        { username: created[0].username! },
        { context: contextFor(viewer) },
      );

    // Only the day-zero subject precedes this one (the 1,000 rank fixtures
    // are backdated to 2021), so the join badges are deterministic here.
    expect((await read()).badges).toEqual(["popular", "super_early_access", "early_access"]);

    // Live state, not an achievement: two unfollows take the count to 999 —
    // strictly below the threshold — and the tier goes with it.
    await db
      .delete(follow)
      .where(
        and(eq(follow.followingId, subject), inArray(follow.followerId, followers.slice(0, 2))),
      );
    expect((await read()).badges).toEqual(["super_early_access", "early_access"]);
  });
});

describe("post.like badge stamping (issue #308)", () => {
  it("stamps the tier exactly once when a like first passes 10,000; a retried like mints nothing", async () => {
    const author = await seedSubjectUser({
      username: `overnight${randomUUID().slice(0, 8)}`,
      createdAt: new Date("2020-03-01T00:00:00.000Z"),
    });
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

  it("keeps a stamped tier when likes recede, and a re-crossing adds no second row", async () => {
    const author = await seedSubjectUser({
      username: `flashfame${randomUUID().slice(0, 8)}`,
      createdAt: new Date("2020-03-02T00:00:00.000Z"),
    });
    const [target] = await seedPosts(author, 1);
    const likers = await seedBareUsers(10_000);
    await seedLikes(target.id, likers);
    const first = await createTestUser();
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(first) });
    expect(await stampedRows(author)).toEqual([{ badge: "noticed" }]);

    // Likes recede below the threshold. An achievement once earned is kept —
    // the row stays, and the profile keeps displaying it.
    await db
      .delete(postLike)
      .where(and(eq(postLike.postId, target.id), inArray(postLike.userId, likers.slice(0, 100))));

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
    expect(profile.badges).toContain("noticed");

    // Climbing back over the threshold is not a second achievement: the
    // composite primary key's conflict does nothing, exactly like a re-like.
    const second = await createTestUser();
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(second) });
    expect(await stampedRows(author)).toEqual([{ badge: "noticed" }]);
  });
});

describe("founder badge grant (issue #308)", () => {
  it("grants exactly one account out of band, displays founder, and never grants again", async () => {
    const founder = await seedSubjectUser({
      username: `thefounder${randomUUID().slice(0, 8)}`,
      createdAt: new Date(),
    });
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
    // This file's fixtures put every living subject past the 1,000th account,
    // so founder is the entire display set.
    expect(profile.badges).toEqual(["founder"]);

    // One badge, one account, ever: a repeat for the same account and a grant
    // to any other account are both refused.
    await expect(grantFounderBadge(username)).rejects.toThrow(/already/);
    const other = await seedSubjectUser({
      username: `notthefounder${randomUUID().slice(0, 8)}`,
      createdAt: new Date(),
    });
    const otherHandle = await db
      .select({ username: user.username })
      .from(user)
      .where(eq(user.id, other));
    await expect(grantFounderBadge(otherHandle[0].username!)).rejects.toThrow(
      /already been granted/,
    );
  });

  it("redacts the founder badge on the suspended stub, like every authored field", async () => {
    const founder = await db
      .select({ userId: userBadge.userId })
      .from(userBadge)
      .where(eq(userBadge.badge, "founder"));
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
