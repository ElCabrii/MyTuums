import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { auth } from "@my-tuums/auth";
import { closeDb } from "@my-tuums/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  appeal,
  follow,
  moderationAction,
  post,
  postLike,
  report,
  user,
  userBlock,
} from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appealToken } from "./appeal-token.js";
import type { Context } from "./context.js";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  seedPosts,
  sessionHeaders,
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

/** A user promoted to moderator through the row, re-fetched so the session carries the role (no cookieCache). */
async function moderatorUser(): Promise<TestUser> {
  const user = await createTestUser();
  await setUserRole(user.id, "moderator");
  return freshSessionFor(user);
}

/** Same idea as `moderatorUser`, one rank up. */
async function staffUser(): Promise<TestUser> {
  const user = await createTestUser();
  await setUserRole(user.id, "staff");
  return freshSessionFor(user);
}

/** Same idea as `moderatorUser`, at the top of the hierarchy. */
async function adminUser(): Promise<TestUser> {
  const user = await createTestUser();
  await setUserRole(user.id, "admin");
  return freshSessionFor(user);
}

/**
 * Direct inserts for content-controlled post fixtures — the same idea as
 * `seedPosts` in testing/harness.ts, but with caller-chosen content, which
 * the case view and the removal emails quote. Goes through `anonContext.db`
 * (a raw drizzle handle, not a rate-limited procedure call).
 */
async function seedPostContent(
  authorId: string,
  content: string,
  opts: { createdAt?: Date; parentId?: string } = {},
): Promise<{ id: string; createdAt: Date }> {
  const row: typeof post.$inferInsert = { authorId, content };
  if (opts.parentId) row.parentId = opts.parentId;
  if (opts.createdAt) row.createdAt = opts.createdAt;
  const [inserted] = await anonContext.db
    .insert(post)
    .values(row)
    .returning({ id: post.id, createdAt: post.createdAt });
  return inserted;
}

/**
 * Direct report inserts for fixtures where the procedure gets in the way —
 * mostly so `createdAt` can be controlled precisely, which the queue's
 * grouping and tie-breaking tests need. Skips the procedure's self-report and
 * block checks deliberately: these are fixtures, not contract assertions.
 */
async function seedReport(
  reporterId: string,
  targetType: "post" | "user",
  targetId: string,
  reason: string,
  createdAt?: Date,
): Promise<void> {
  const row: typeof report.$inferInsert = { reporterId, targetType, targetId, reason };
  if (createdAt) row.createdAt = createdAt;
  await anonContext.db.insert(report).values(row);
}

/**
 * Wipes every report and appeal row created so far.
 *
 * The queue's group view is global — an open case created by one test would
 * show up in another's absolute assertions ("the queue is empty"). These are
 * fixture rows the tests own, so every test that creates them sweeps them up
 * at its end; `moderation_action` rows are deliberately left behind, because
 * the audit-log walk asserts against the whole table.
 */
async function clearQueueFixtures(): Promise<void> {
  await anonContext.db.delete(appeal);
  await anonContext.db.delete(report);
}

/** The newest `moderation_action` row matching an action code and target — what a test asserts after acting. */
async function latestAction(
  actionCode: string,
  targetType: "post" | "user",
  targetId: string,
): Promise<typeof moderationAction.$inferSelect | undefined> {
  const where =
    targetType === "post"
      ? and(
          eq(moderationAction.action, actionCode),
          eq(moderationAction.targetType, "post"),
          eq(moderationAction.targetPostId, targetId),
        )
      : and(
          eq(moderationAction.action, actionCode),
          eq(moderationAction.targetType, "user"),
          eq(moderationAction.targetUserId, targetId),
        );
  const [row] = await anonContext.db
    .select()
    .from(moderationAction)
    .where(where)
    .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
    .limit(1);
  return row;
}

/**
 * Mints an appeal link exactly the way the emails do: the process-wide
 * signer (the test env sets `BETTER_AUTH_SECRET`, which the signer is keyed
 * on — see appeal-token.ts), with the token's `userId` bound to the account
 * the action happened to.
 */
function appealLink(
  actionId: string,
  userId: string,
  opts: { iat?: number; nonce?: string } = {},
): string {
  return appealToken.sign({
    purpose: "appeal",
    actionId,
    userId,
    nonce: opts.nonce ?? randomUUID(),
    iat: opts.iat ?? Math.floor(Date.now() / 1000),
  });
}

/** Walks `moderation.queue` to exhaustion via `nextCursor`, collecting every case's target key. */
async function walkAllQueuePages(
  context: Context,
  limit?: number,
): Promise<Array<{ targetType: string; targetId: string }>> {
  const keys: Array<{ targetType: string; targetId: string }> = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await call(
      appRouter.moderation.queue,
      { cursor, ...(limit ? { limit } : {}) },
      { context },
    );
    keys.push(
      ...page.items.map((item) => ({ targetType: item.targetType, targetId: item.targetId })),
    );
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) {
      throw new Error("walkAllQueuePages: exceeded 500 pages — pagination looks like it's looping.");
    }
  } while (cursor);
  return keys;
}

/** Walks `moderation.auditLog` to exhaustion via `nextCursor`, collecting every action id in order. */
async function walkAllAuditPages(context: Context, limit?: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await call(
      appRouter.moderation.auditLog,
      { cursor, ...(limit ? { limit } : {}) },
      { context },
    );
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) {
      throw new Error("walkAllAuditPages: exceeded 500 pages — pagination looks like it's looping.");
    }
  } while (cursor);
  return ids;
}

/** The queue's expected content, computed straight from the DB: every unresolved report group's key. */
async function openCaseKeysFromDb(): Promise<string[]> {
  const rows = await anonContext.db.execute<{ target_type: string; target_id: string }>(sql`
    select ${report.targetType} as target_type, ${report.targetId} as target_id
    from ${report}
    where ${report.resolvedAt} is null
    group by ${report.targetType}, ${report.targetId}
  `);
  return rows.map((row) => `${row.target_type}:${row.target_id}`);
}

describe("report", () => {
  it("is idempotent per (reporter, target) — a repeat refreshes the timestamp, never a new row", async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();
    const postRow = await seedPostContent(author.id, "report me once");

    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(reporter) },
    );
    const [before] = await anonContext.db
      .select({ createdAt: report.createdAt })
      .from(report)
      .where(eq(report.reporterId, reporter.id));

    // The reason is fixed at first report (the upsert only clears the
    // resolution stamp and refreshes the clock) — pinning that contract.
    const second = await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "harassment" },
      { context: contextFor(reporter) },
    );
    expect(second).toEqual({ reported: true });

    const rows = await anonContext.db
      .select({ reason: report.reason, createdAt: report.createdAt })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("spam");
    expect(rows[0].createdAt.getTime()).toBeGreaterThanOrEqual(before.createdAt.getTime());

    await clearQueueFixtures();
  });

  it("reopens after a dismissal — a stamp clearing, still one row", async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "reopen me");

    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(reporter) },
    );
    await call(
      appRouter.moderation.resolve,
      { targetType: "post", targetId: postRow.id, outcome: "dismissed", note: "not a violation" },
      { context: contextFor(mod) },
    );
    const [resolved] = await anonContext.db
      .select({ resolvedAt: report.resolvedAt })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(resolved?.resolvedAt).not.toBeNull();

    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(reporter) },
    );
    const rows = await anonContext.db
      .select({ resolvedAt: report.resolvedAt })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].resolvedAt).toBeNull();

    await clearQueueFixtures();
  });

  it("refuses self-reports, missing targets, and cross-block reports", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const author = await createTestUser();
    const postRow = await seedPostContent(author.id, "don't report me");

    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "user", targetId: a.id, reason: "spam" },
        { context: contextFor(a) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can't report yourself." });

    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "post", targetId: randomUUID(), reason: "spam" },
        { context: contextFor(a) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "The thing you reported doesn't exist." });
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "user", targetId: randomUUID(), reason: "spam" },
        { context: contextFor(a) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "The thing you reported doesn't exist." });

    await call(appRouter.moderation.block, { userId: b.id }, { context: contextFor(a) });
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "user", targetId: b.id, reason: "harassment" },
        { context: contextFor(a) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can't report this user." });
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "user", targetId: a.id, reason: "harassment" },
        { context: contextFor(b) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can't report this user." });

    // The same post stays reportable after all that.
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "post", targetId: postRow.id, reason: "spam" },
        { context: contextFor(a) },
      ),
    ).resolves.toEqual({ reported: true });

    await clearQueueFixtures();
  });

  it("enforces the per-kind reason codes — a post code is refused for a user target and vice versa", async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();
    const postRow = await seedPostContent(author.id, "reason code fodder");

    // "nsfw" exists for posts only; "impersonation" for users only. The input
    // schema is a discriminated union on targetType, so a wrong-kind reason
    // is a compile error in typed code — `as never` is the only way to put
    // the bad payload on the wire, which is exactly what an untyped client
    // can do, and zod is the layer that must refuse it.
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "user", targetId: author.id, reason: "nsfw" } as never,
        { context: contextFor(reporter) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "post", targetId: postRow.id, reason: "impersonation" } as never,
        { context: contextFor(reporter) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("block and unblock", () => {
  it("block severs follows in both directions, is idempotent, and leaves likes alone", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const postRow = await seedPostContent(b.id, "liked through the block");

    await anonContext.db.insert(follow).values({ followerId: a.id, followingId: b.id });
    await anonContext.db.insert(follow).values({ followerId: b.id, followingId: a.id });
    await anonContext.db.insert(postLike).values({ userId: a.id, postId: postRow.id });

    const result = await call(
      appRouter.moderation.block,
      { userId: b.id },
      { context: contextFor(a) },
    );
    expect(result).toEqual({ userId: b.id, blocked: true });

    expect(await anonContext.db.select().from(follow)).toHaveLength(0);
    expect(await anonContext.db.select().from(postLike)).toHaveLength(1);

    // Idempotent.
    await expect(
      call(appRouter.moderation.block, { userId: b.id }, { context: contextFor(a) }),
    ).resolves.toEqual({ userId: b.id, blocked: true });
    const [blockRow] = await anonContext.db
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.blockerId, a.id), eq(userBlock.blockedId, b.id)));
    expect(blockRow).toBeDefined();
  });

  it("blocking yourself or a missing account is refused", async () => {
    const a = await createTestUser();
    await expect(
      call(appRouter.moderation.block, { userId: a.id }, { context: contextFor(a) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You can't block yourself." });
    await expect(
      call(appRouter.moderation.block, { userId: randomUUID() }, { context: contextFor(a) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This account doesn't exist." });
  });

  it("unblock removes the edge and is idempotent — and never resurrects the severed follows", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await anonContext.db.insert(follow).values({ followerId: a.id, followingId: b.id });
    await call(appRouter.moderation.block, { userId: b.id }, { context: contextFor(a) });

    const result = await call(
      appRouter.moderation.unblock,
      { userId: b.id },
      { context: contextFor(a) },
    );
    expect(result).toEqual({ userId: b.id, blocked: false });

    // Scoped to this test's edge — an earlier test's block row may still be
    // standing (blocks are silent, and never swept).
    const remaining = await anonContext.db
      .select()
      .from(userBlock)
      .where(and(eq(userBlock.blockerId, a.id), eq(userBlock.blockedId, b.id)));
    expect(remaining).toHaveLength(0);
    // The severed follow does not come back — unblock is not an undo.
    expect(await anonContext.db.select().from(follow)).toHaveLength(0);

    await expect(
      call(appRouter.moderation.unblock, { userId: b.id }, { context: contextFor(a) }),
    ).resolves.toEqual({ userId: b.id, blocked: false });
    await expect(
      call(appRouter.moderation.unblock, { userId: randomUUID() }, { context: contextFor(a) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This account doesn't exist." });
  });
});

describe("queue", () => {
  it("groups unresolved reports by target, counting reporters and deduping reasons", async () => {
    const author = await createTestUser();
    const r1 = await createTestUser();
    const r2 = await createTestUser();
    const r3 = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "group me");

    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(r1) },
    );
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(r2) },
    );
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "harassment" },
      { context: contextFor(r3) },
    );

    const page = await call(
      appRouter.moderation.queue,
      { limit: 10 },
      { context: contextFor(mod) },
    );
    expect(page.items).toHaveLength(1);
    const [only] = page.items;
    expect(only.targetType).toBe("post");
    expect(only.targetId).toBe(postRow.id);
    expect(only.reportCount).toBe(3);
    expect([...only.reasons].sort()).toEqual(["harassment", "spam"]);
    expect(only.appeal).toBeNull();
    expect(page.nextCursor).toBeNull();

    await clearQueueFixtures();
  });

  it("keyset walk returns every open case exactly once, at any page size — the boundary case is never dropped", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const mod = await moderatorUser();
    const base = Date.UTC(2026, 7, 6, 12, 0, 0);
    const posts = await seedPosts(author.id, 6, {
      createdAt: (index) => new Date(base - index * 60_000),
    });
    for (const p of posts) {
      await seedReport(reporter.id, "post", p.id, "spam", p.createdAt);
    }

    // Regression guard: the queue cursor anchors on the LAST case actually
    // returned (the house pattern); anchoring on the first case past the
    // page instead dropped exactly that case at every page boundary.
    for (const limit of [1, 2, 5]) {
      const walked = await walkAllQueuePages(contextFor(mod), limit);
      const keys = walked.map((k) => `${k.targetType}:${k.targetId}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(keys)).toEqual(new Set(await openCaseKeysFromDb()));
    }

    await clearQueueFixtures();
  });

  it("ties on the newest timestamp break on targetId desc", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const mod = await moderatorUser();
    const instant = new Date(Date.UTC(2026, 7, 6, 12, 0, 0));
    const posts = await seedPosts(author.id, 3, { createdAt: instant });
    for (const p of posts) {
      await seedReport(reporter.id, "post", p.id, "spam", instant);
    }

    const walked = await walkAllQueuePages(contextFor(mod), 1);
    const expectedOrder = (
      await anonContext.db.execute<{ target_id: string }>(sql`
        select ${report.targetId} as target_id
        from ${report}
        where ${report.resolvedAt} is null
        group by ${report.targetType}, ${report.targetId}
        order by max(${report.createdAt}) desc, ${report.targetId} desc
      `)
    ).map((row) => row.target_id);
    expect(walked.map((k) => k.targetId)).toEqual(expectedOrder);

    await clearQueueFixtures();
  });

  it("merges open appeals — an appeal-only case has reportCount 0; a reported-and-appealed case carries both halves", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const reporter2 = await createTestUser();
    const mod = await moderatorUser();

    // P1: reported, removed (stamping that report actioned), re-reported by a
    // second user, then appealed — the queue case carries both halves.
    const p1 = await seedPostContent(author.id, "reported and appealed");
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: p1.id, reason: "spam" },
      { context: contextFor(reporter) },
    );
    await call(
      appRouter.moderation.removePost,
      { postId: p1.id, reason: "rule break" },
      { context: contextFor(mod) },
    );
    const removal1 = await latestAction("post_removed", "post", p1.id);
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: p1.id, reason: "harassment" },
      { context: contextFor(reporter2) },
    );
    await call(
      appRouter.moderation.appealOpen,
      { token: appealLink(removal1!.id, author.id), reason: "This removal is unfair" },
      { context: anonContext },
    );

    // P2: removed with no reports, then appealed — appeal-only case.
    const p2 = await seedPostContent(author.id, "appealed only");
    await call(
      appRouter.moderation.removePost,
      { postId: p2.id, reason: "rule break" },
      { context: contextFor(mod) },
    );
    const removal2 = await latestAction("post_removed", "post", p2.id);
    await call(
      appRouter.moderation.appealOpen,
      { token: appealLink(removal2!.id, author.id), reason: "This removal too" },
      { context: anonContext },
    );

    const page = await call(
      appRouter.moderation.queue,
      { limit: 10 },
      { context: contextFor(mod) },
    );
    const byId = new Map(page.items.map((item) => [item.targetId, item]));
    const case1 = byId.get(p1.id);
    const case2 = byId.get(p2.id);
    expect(case1).toBeDefined();
    expect(case1!.reportCount).toBe(1);
    expect([...case1!.reasons]).toEqual(["harassment"]);
    // Shape pin: exactly id + reason + createdAt — the appeal half of a
    // merged case carries nothing else.
    expect(Object.keys(case1!.appeal!).sort()).toEqual(["createdAt", "id", "reason"]);
    expect(case1!.appeal!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(case1!.appeal!.reason).toBe("This removal is unfair");
    expect(case1!.appeal!.createdAt).toBeInstanceOf(Date);
    expect(case2).toBeDefined();
    expect(case2!.reportCount).toBe(0);
    expect([...case2!.reasons]).toEqual([]);
    expect(case2!.appeal?.reason).toBe("This removal too");

    await clearQueueFixtures();
  });

  it("drops cases once their reports are resolved", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "resolved fodder");
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(reporter) },
    );

    expect(await walkAllQueuePages(contextFor(mod), 1)).toHaveLength(1);
    await call(
      appRouter.moderation.resolve,
      { targetType: "post", targetId: postRow.id, outcome: "dismissed" },
      { context: contextFor(mod) },
    );
    expect(await walkAllQueuePages(contextFor(mod), 1)).toHaveLength(0);

    await clearQueueFixtures();
  });

  it("rejects a malformed cursor", async () => {
    const mod = await moderatorUser();
    await expect(
      call(appRouter.moderation.queue, { cursor: "%%%not-a-cursor%%%" }, { context: contextFor(mod) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Malformed pagination cursor." });
  });
});

describe("case", () => {
  it("shows the moderator projection: raw content and removal fields for a removed post", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "this is the raw body");
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(reporter) },
    );
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "rule break" },
      { context: contextFor(mod) },
    );

    const result = await call(
      appRouter.moderation.case,
      { targetType: "post", targetId: postRow.id },
      { context: contextFor(mod) },
    );
    if (result.target.kind !== "post") throw new Error("expected a post target");
    expect(result.target.id).toBe(postRow.id);
    // The feeds hide the content of a removed post; the case view must not.
    expect(result.target.content).toBe("this is the raw body");
    expect(result.target.removedAt).not.toBeNull();
    expect(result.target.removedBy).toBe(mod.id);
    expect(result.target.removedReason).toBe("rule break");
    expect(result.target.author.username).toBe(author.session.user.username);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0].reporterId).toBe(reporter.id);

    await clearQueueFixtures();
  });

  it("returns the full report history, newest first, resolved rows included", async () => {
    const author = await createTestUser();
    const r1 = await createTestUser();
    const r2 = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "history please");
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(r1) },
    );
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "harassment" },
      { context: contextFor(r2) },
    );
    await call(
      appRouter.moderation.resolve,
      { targetType: "post", targetId: postRow.id, outcome: "dismissed" },
      { context: contextFor(mod) },
    );
    // r1 re-reports after the dismissal — the newest row reopens.
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(r1) },
    );

    const result = await call(
      appRouter.moderation.case,
      { targetType: "post", targetId: postRow.id },
      { context: contextFor(mod) },
    );
    expect(result.reports).toHaveLength(2);
    expect(result.reports[0].reporterId).toBe(r1.id);
    expect(result.reports[0].resolvedAt).toBeNull();
    expect(result.reports[1].reporterId).toBe(r2.id);
    expect(result.reports[1].resolvedOutcome).toBe("dismissed");
    expect(result.appeal).toBeNull();

    await clearQueueFixtures();
  });

  it("shows the account state for a user target", async () => {
    const victim = await createTestUser();
    const mod = await moderatorUser();
    await setUserBan(victim.id, {
      reason: "bad actor",
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const result = await call(
      appRouter.moderation.case,
      { targetType: "user", targetId: victim.id },
      { context: contextFor(mod) },
    );
    if (result.target.kind !== "user") throw new Error("expected a user target");
    expect(result.target.id).toBe(victim.id);
    expect(result.target.username).toBe(victim.session.user.username);
    expect(result.target.role).toBe("user");
    expect(result.target.banned).toBe(true);
    expect(result.target.banReason).toBe("bad actor");
    expect(result.target.banExpires).toBeInstanceOf(Date);
  });

  it("is NOT_FOUND for a target that doesn't exist", async () => {
    const mod = await moderatorUser();
    await expect(
      call(
        appRouter.moderation.case,
        { targetType: "post", targetId: randomUUID() },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This post doesn't exist." });
    await expect(
      call(
        appRouter.moderation.case,
        { targetType: "user", targetId: randomUUID() },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This account doesn't exist." });
  });
});

describe("resolve", () => {
  it("stamps the case's open reports, logs case_resolved with the outcome and reporter count", async () => {
    const author = await createTestUser();
    const r1 = await createTestUser();
    const r2 = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "resolve me");
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(r1) },
    );
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "harassment" },
      { context: contextFor(r2) },
    );

    const result = await call(
      appRouter.moderation.resolve,
      { targetType: "post", targetId: postRow.id, outcome: "dismissed", note: "no rule broken" },
      { context: contextFor(mod) },
    );
    expect(result).toEqual({ targetType: "post", targetId: postRow.id, resolved: 2 });

    const stamped = await anonContext.db
      .select({
        resolvedAt: report.resolvedAt,
        resolvedBy: report.resolvedBy,
        resolvedOutcome: report.resolvedOutcome,
        resolutionNote: report.resolutionNote,
      })
      .from(report)
      .where(eq(report.targetId, postRow.id));
    for (const row of stamped) {
      expect(row.resolvedAt).not.toBeNull();
      expect(row.resolvedBy).toBe(mod.id);
      expect(row.resolvedOutcome).toBe("dismissed");
      expect(row.resolutionNote).toBe("no rule broken");
    }

    const action = await latestAction("case_resolved", "post", postRow.id);
    expect(action?.details).toEqual({ outcome: "dismissed", reporterCount: 2 });
    expect(action?.note).toBe("no rule broken");
  });
});

describe("removePost and restorePost", () => {
  it("tombstones the post: feeds keep a bare stub, only the author sees the reason", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "remove me please");

    const result = await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam content" },
      { context: contextFor(mod) },
    );
    expect(result).toEqual({ postId: postRow.id, removed: true });

    const viewerFeed = await call(appRouter.post.list, { feed: "global" }, { context: contextFor(viewer) });
    const viewerItem = viewerFeed.items.find((p) => p.id === postRow.id);
    expect(viewerItem?.removed).toBe(true);
    expect(viewerItem?.content).toBeNull();
    expect(viewerItem?.removedReason).toBeNull();

    const authorFeed = await call(appRouter.post.list, { feed: "global" }, { context: contextFor(author) });
    const authorItem = authorFeed.items.find((p) => p.id === postRow.id);
    expect(authorItem?.removed).toBe(true);
    expect(authorItem?.content).toBeNull();
    expect(authorItem?.removedReason).toBe("spam content");

    // The moderator case view still shows what the feeds hide.
    const caseResult = await call(
      appRouter.moderation.case,
      { targetType: "post", targetId: postRow.id },
      { context: contextFor(mod) },
    );
    if (caseResult.target.kind !== "post") throw new Error("expected a post target");
    expect(caseResult.target.content).toBe("remove me please");
  });

  it("replies to a removed post stay visible and creatable", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const parent = await seedPostContent(author.id, "removed parent");
    await call(
      appRouter.moderation.removePost,
      { postId: parent.id, reason: "spam" },
      { context: contextFor(mod) },
    );

    const created = await call(
      appRouter.post.create,
      { content: "still fine down here", parentId: parent.id },
      { context: contextFor(author) },
    );
    const replies = await call(
      appRouter.post.list,
      { parentId: parent.id },
      { context: contextFor(author) },
    );
    expect(replies.items.map((p) => p.id)).toContain(created.id);
    expect(replies.items[0].removed).toBe(false);
  });

  it("stamps the post's open reports actioned", async () => {
    const author = await createTestUser();
    const reporter = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "stamp me");
    await call(
      appRouter.moderation.report,
      { targetType: "post", targetId: postRow.id, reason: "spam" },
      { context: contextFor(reporter) },
    );

    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );
    const [stamped] = await anonContext.db
      .select({
        resolvedAt: report.resolvedAt,
        resolvedBy: report.resolvedBy,
        resolvedOutcome: report.resolvedOutcome,
      })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(stamped?.resolvedAt).not.toBeNull();
    expect(stamped?.resolvedBy).toBe(mod.id);
    expect(stamped?.resolvedOutcome).toBe("actioned");
  });

  it("logs post_removed, and restorePost logs post_restored and clears the tombstone", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "round trip");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "rule break" },
      { context: contextFor(mod) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);
    expect(removal?.reason).toBe("rule break");
    expect(removal?.actorId).toBe(mod.id);

    await call(
      appRouter.moderation.restorePost,
      { postId: postRow.id, note: "appeal won" },
      { context: contextFor(mod) },
    );
    const [restored] = await anonContext.db
      .select({ removedAt: post.removedAt, removedReason: post.removedReason })
      .from(post)
      .where(eq(post.id, postRow.id));
    expect(restored?.removedAt).toBeNull();
    expect(restored?.removedReason).toBeNull();
    const restoreAction = await latestAction("post_restored", "post", postRow.id);
    expect(restoreAction?.note).toBe("appeal won");

    const feed = await call(appRouter.post.list, { feed: "global" }, { context: contextFor(author) });
    const item = feed.items.find((p) => p.id === postRow.id);
    expect(item?.removed).toBe(false);
    expect(item?.content).toBe("round trip");
  });

  it("removing twice is refused, restoring twice is a silent no-op", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "double trouble");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );
    await expect(
      call(
        appRouter.moderation.removePost,
        { postId: postRow.id, reason: "spam again" },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This post is already removed." });

    await call(
      appRouter.moderation.restorePost,
      { postId: postRow.id },
      { context: contextFor(mod) },
    );
    await expect(
      call(appRouter.moderation.restorePost, { postId: postRow.id }, { context: contextFor(mod) }),
    ).resolves.toEqual({ postId: postRow.id, restored: true });
  });

  it("is NOT_FOUND for a missing post", async () => {
    const mod = await moderatorUser();
    await expect(
      call(
        appRouter.moderation.removePost,
        { postId: randomUUID(), reason: "spam" },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This post doesn't exist." });
    await expect(
      call(appRouter.moderation.restorePost, { postId: randomUUID() }, { context: contextFor(mod) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("suspendUser", () => {
  it("locks the account: every session dies and sign-in is refused", async () => {
    const victim = await createTestUser();
    const mod = await moderatorUser();
    const result = await call(
      appRouter.moderation.suspendUser,
      { userId: victim.id, reason: "spam", durationSeconds: 3600 },
      { context: contextFor(mod) },
    );
    expect(result.suspended).toBe(true);
    expect(Math.abs(result.banExpires.getTime() - (Date.now() + 3600_000))).toBeLessThan(60_000);

    expect(await auth.api.getSession({ headers: sessionHeaders(victim) })).toBeNull();
    const [victimRow] = await anonContext.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, victim.id));
    await expect(
      auth.api.signInEmail({
        body: { email: victimRow.email, password: "vitest-Sup3rSecret!" },
        returnHeaders: true,
      }),
    ).rejects.toThrow();
  });

  it("stamps open user-target reports actioned and logs the duration", async () => {
    const victim = await createTestUser();
    const reporter = await createTestUser();
    const mod = await moderatorUser();
    await call(
      appRouter.moderation.report,
      { targetType: "user", targetId: victim.id, reason: "harassment" },
      { context: contextFor(reporter) },
    );

    await call(
      appRouter.moderation.suspendUser,
      { userId: victim.id, reason: "harassing others", durationSeconds: 3600 },
      { context: contextFor(mod) },
    );
    const [stamped] = await anonContext.db
      .select({ resolvedOutcome: report.resolvedOutcome, resolvedBy: report.resolvedBy })
      .from(report)
      .where(eq(report.reporterId, reporter.id));
    expect(stamped?.resolvedOutcome).toBe("actioned");
    expect(stamped?.resolvedBy).toBe(mod.id);
    const action = await latestAction("user_suspended", "user", victim.id);
    expect(action?.details).toEqual({ durationSeconds: 3600 });
    expect(action?.reason).toBe("harassing others");
  });

  it("the rank guard refuses moderators acting on moderators, staff, admins, or themselves", async () => {
    const mod = await moderatorUser();
    const mod2 = await moderatorUser();
    const staff = await staffUser();
    const admin = await adminUser();

    const attempt = (userId: string) =>
      call(
        appRouter.moderation.suspendUser,
        { userId, reason: "spam", durationSeconds: 3600 },
        { context: contextFor(mod) },
      );
    await expect(attempt(mod2.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attempt(staff.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attempt(admin.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attempt(mod.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Staff may suspend a moderator — one rank down.
    await expect(
      call(
        appRouter.moderation.suspendUser,
        { userId: mod2.id, reason: "spam", durationSeconds: 3600 },
        { context: contextFor(staff) },
      ),
    ).resolves.toMatchObject({ suspended: true });
  });

  it("bounds the duration — 3599s and 31536001s are refused", async () => {
    const victim = await createTestUser();
    const mod = await moderatorUser();
    for (const durationSeconds of [3599, 31_536_001]) {
      await expect(
        call(
          appRouter.moderation.suspendUser,
          { userId: victim.id, reason: "spam", durationSeconds },
          { context: contextFor(mod) },
        ),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("is NOT_FOUND for a missing account", async () => {
    const mod = await moderatorUser();
    await expect(
      call(
        appRouter.moderation.suspendUser,
        { userId: randomUUID(), reason: "spam", durationSeconds: 3600 },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This account doesn't exist." });
  });
});

describe("banUser and unbanUser", () => {
  it("banUser is staff-only", async () => {
    const victim = await createTestUser();
    const mod = await moderatorUser();
    await expect(
      call(
        appRouter.moderation.banUser,
        { userId: victim.id, reason: "spam" },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("banUser bans permanently; unbanUser logs user_unbanned", async () => {
    const victim = await createTestUser();
    const staff = await staffUser();
    await call(
      appRouter.moderation.banUser,
      { userId: victim.id, reason: "permanent spam" },
      { context: contextFor(staff) },
    );
    const [banned] = await anonContext.db
      .select({ banned: user.banned, banExpires: user.banExpires, banReason: user.banReason })
      .from(user)
      .where(eq(user.id, victim.id));
    expect(banned?.banned).toBe(true);
    expect(banned?.banExpires).toBeNull();
    expect(banned?.banReason).toBe("permanent spam");
    expect(await auth.api.getSession({ headers: sessionHeaders(victim) })).toBeNull();

    await call(
      appRouter.moderation.unbanUser,
      { userId: victim.id, note: "appeal won" },
      { context: contextFor(staff) },
    );
    const [cleared] = await anonContext.db
      .select({ banned: user.banned, banReason: user.banReason })
      .from(user)
      .where(eq(user.id, victim.id));
    expect(cleared?.banned).toBe(false);
    expect(cleared?.banReason).toBeNull();
    const action = await latestAction("user_unbanned", "user", victim.id);
    expect(action?.note).toBe("appeal won");
  });

  it("unsuspending logs user_unsuspended — the code follows the expiry read", async () => {
    const victim = await createTestUser();
    const staff = await staffUser();
    await call(
      appRouter.moderation.suspendUser,
      { userId: victim.id, reason: "temporary spam", durationSeconds: 3600 },
      { context: contextFor(staff) },
    );
    await call(
      appRouter.moderation.unbanUser,
      { userId: victim.id },
      { context: contextFor(staff) },
    );
    expect(await latestAction("user_unsuspended", "user", victim.id)).toBeDefined();
    expect(await latestAction("user_unbanned", "user", victim.id)).toBeUndefined();
  });

  it("unbanUser on an unbanned account is refused", async () => {
    const victim = await createTestUser();
    const staff = await staffUser();
    await expect(
      call(
        appRouter.moderation.unbanUser,
        { userId: victim.id },
        { context: contextFor(staff) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This account isn't banned or suspended." });
  });
});

describe("setRole, team, auditLog", () => {
  it("setRole: staff may grant moderator; admin grants staff and admin; the swing is logged", async () => {
    const staff = await staffUser();
    const admin = await adminUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    const dave = await createTestUser();

    await call(
      appRouter.moderation.setRole,
      { userId: bob.id, role: "moderator" },
      { context: contextFor(staff) },
    );
    const [bobRow] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, bob.id));
    expect(bobRow?.role).toBe("moderator");
    const action = await latestAction("role_changed", "user", bob.id);
    expect(action?.details).toEqual({ oldRole: "user", newRole: "moderator" });

    // Staff cannot grant staff or admin — that needs admin.
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: carol.id, role: "staff" },
        { context: contextFor(staff) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await call(
      appRouter.moderation.setRole,
      { userId: carol.id, role: "staff" },
      { context: contextFor(admin) },
    );
    await call(
      appRouter.moderation.setRole,
      { userId: dave.id, role: "admin" },
      { context: contextFor(admin) },
    );
    const [carolRow] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, carol.id));
    expect(carolRow?.role).toBe("staff");
  });

  it("setRole: granting at or above your own rank is refused, and same-role is a BAD_REQUEST", async () => {
    const admin = await adminUser();
    const staff = await staffUser();
    const bob = await createTestUser();
    await call(
      appRouter.moderation.setRole,
      { userId: bob.id, role: "staff" },
      { context: contextFor(admin) },
    );

    // Staff cannot touch another staff member (same rank), nor grant admin.
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: bob.id, role: "moderator" },
        { context: contextFor(staff) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: bob.id, role: "admin" },
        { context: contextFor(staff) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nobody can act on their own rank — even the admin on themselves.
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: admin.id, role: "moderator" },
        { context: contextFor(admin) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Same-role is a plain refusal, not a no-op.
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: bob.id, role: "staff" },
        { context: contextFor(admin) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This account already has that role." });
  });

  it("the promoted user's next session opens the moderator surface", async () => {
    const admin = await adminUser();
    const bob = await createTestUser();
    await call(
      appRouter.moderation.setRole,
      { userId: bob.id, role: "moderator" },
      { context: contextFor(admin) },
    );
    // No cookieCache: the new role lands on the NEXT session fetch.
    const promoted = await freshSessionFor(bob);
    const [bobRow] = await anonContext.db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, bob.id));
    expect(bobRow?.role).toBe("moderator");
    await expect(
      call(appRouter.moderation.queue, {}, { context: contextFor(promoted) }),
    ).resolves.toMatchObject({ items: [] });
  });

  it("team lists the moderation team ranked admin → staff → moderator", async () => {
    const admin = await adminUser();
    const staff = await staffUser();
    const mod = await moderatorUser();
    const result = await call(appRouter.moderation.team, undefined, { context: contextFor(admin) });
    const roles = result.items
      .filter((member) => [admin.id, staff.id, mod.id].includes(member.id))
      .map((member) => member.role);
    expect(roles).toEqual(["admin", "staff", "moderator"]);

    await expect(
      call(appRouter.moderation.team, undefined, { context: contextFor(mod) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("auditLog keyset walk returns every action exactly once, newest first — the boundary row is never dropped", async () => {
    const staff = await staffUser();
    const victim = await createTestUser();
    const bob = await createTestUser();
    const carol = await createTestUser();
    const p1 = await seedPostContent(victim.id, "audit 1");
    const p2 = await seedPostContent(victim.id, "audit 2");

    await call(
      appRouter.moderation.setRole,
      { userId: bob.id, role: "moderator" },
      { context: contextFor(staff) },
    );
    await call(
      appRouter.moderation.setRole,
      { userId: carol.id, role: "moderator" },
      { context: contextFor(staff) },
    );
    await call(
      appRouter.moderation.removePost,
      { postId: p1.id, reason: "one" },
      { context: contextFor(staff) },
    );
    await call(
      appRouter.moderation.removePost,
      { postId: p2.id, reason: "two" },
      { context: contextFor(staff) },
    );
    await call(
      appRouter.moderation.suspendUser,
      { userId: carol.id, reason: "three", durationSeconds: 3600 },
      { context: contextFor(staff) },
    );

    const expected = (
      await anonContext.db
        .select({ id: moderationAction.id })
        .from(moderationAction)
        .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
    ).map((row) => row.id);
    expect(expected.length).toBeGreaterThanOrEqual(5);

    // Regression guard for the cursor fix: every page size walks the exact
    // DB order — no dropped boundary row, no repeats, order preserved.
    for (const limit of [1, 3, 10]) {
      const walked = await walkAllAuditPages(contextFor(staff), limit);
      expect(walked).toEqual(expected);
    }

    // Append-only: one more action lands at the head of a re-walk.
    await call(
      appRouter.moderation.unbanUser,
      { userId: carol.id },
      { context: contextFor(staff) },
    );
    const newAction = await latestAction("user_unsuspended", "user", carol.id);
    const rewalked = await walkAllAuditPages(contextFor(staff), 10);
    expect(rewalked[0]).toBe(newAction!.id);
    expect(rewalked).toEqual([newAction!.id, ...expected]);
  });

  it("auditLog carries actor and target summaries for the actions", async () => {
    const staff = await staffUser();
    const bob = await createTestUser();
    // This test's own action becomes the newest row — nothing from an
    // earlier test can masquerade as the head of the walk.
    await call(
      appRouter.moderation.setRole,
      { userId: bob.id, role: "moderator" },
      { context: contextFor(staff) },
    );

    const page = await call(
      appRouter.moderation.auditLog,
      { limit: 10 },
      { context: contextFor(staff) },
    );
    const [first] = page.items;
    expect(first.action).toBe("role_changed");
    expect(first.actor?.id).toBe(staff.id);
    expect(first.actor?.username).toBe(staff.session.user.username);
    expect(first.targetUser?.id).toBe(bob.id);
    expect(first.targetUser?.username).toBe(bob.session.user.username);
    expect(first.targetPostId).toBeNull();
  });
});

describe("appeal flow", () => {
  it("signed-out appeal from the email link, reviewed by a different moderator, overturns and restores the post", async () => {
    const author = await createTestUser();
    const mod1 = await moderatorUser();
    const mod2 = await moderatorUser();
    const postRow = await seedPostContent(author.id, "appeal me please");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "rules violation" },
      { context: contextFor(mod1) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);
    const token = appealLink(removal!.id, author.id);

    // Signed-out: the email link opens the appeal with no session at all.
    const opened = await call(
      appRouter.moderation.appealOpen,
      { token, reason: "I disagree with this removal" },
      { context: anonContext },
    );
    expect(opened.appealId).toMatch(/^[0-9a-f-]{36}$/);
    expect(opened.status).toBe("open");
    const [appealRow] = await anonContext.db
      .select({
        actionId: appeal.actionId,
        appellantId: appeal.appellantId,
        tokenNonce: appeal.tokenNonce,
        reason: appeal.reason,
      })
      .from(appeal)
      .where(eq(appeal.id, opened.appealId));
    expect(appealRow?.actionId).toBe(removal!.id);
    expect(appealRow?.appellantId).toBe(author.id);
    expect(appealRow?.reason).toBe("I disagree with this removal");

    // Replaying the same link is refused — the nonce is spent.
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token, reason: "replaying the same link" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This appeal link has already been used." });

    // The actor of the original action cannot review their own work.
    await expect(
      call(
        appRouter.moderation.appealReview,
        { appealId: opened.appealId, outcome: "overturned" },
        { context: contextFor(mod1) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "You can't review your own action." });

    // A different moderator overturns: the post comes back, the inverse and
    // the resolution are both logged.
    const reviewed = await call(
      appRouter.moderation.appealReview,
      { appealId: opened.appealId, outcome: "overturned", note: "no rule broken" },
      { context: contextFor(mod2) },
    );
    expect(reviewed).toEqual({ appealId: opened.appealId, status: "overturned" });
    const [restored] = await anonContext.db
      .select({ removedAt: post.removedAt })
      .from(post)
      .where(eq(post.id, postRow.id));
    expect(restored?.removedAt).toBeNull();
    expect(await latestAction("post_restored", "post", postRow.id)).toBeDefined();
    const resolution = await latestAction("appeal_resolved", "post", postRow.id);
    expect(resolution?.details).toEqual({ outcome: "overturned" });

    // The case leaves the queue, and the author's feed shows the post again.
    expect(await walkAllQueuePages(contextFor(mod2), 1)).toHaveLength(0);
    const feed = await call(appRouter.post.list, { feed: "global" }, { context: contextFor(author) });
    const item = feed.items.find((p) => p.id === postRow.id);
    expect(item?.removed).toBe(false);
    expect(item?.content).toBe("appeal me please");

    // Reviewing twice is refused.
    await expect(
      call(
        appRouter.moderation.appealReview,
        { appealId: opened.appealId, outcome: "upheld" },
        { context: contextFor(mod2) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This appeal has already been reviewed." });
  });

  it("upholding leaves the action in force", async () => {
    const author = await createTestUser();
    const mod1 = await moderatorUser();
    const mod2 = await moderatorUser();
    const postRow = await seedPostContent(author.id, "uphold me");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "rules violation" },
      { context: contextFor(mod1) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);
    const opened = await call(
      appRouter.moderation.appealOpen,
      { token: appealLink(removal!.id, author.id), reason: "I want it back" },
      { context: anonContext },
    );
    const reviewed = await call(
      appRouter.moderation.appealReview,
      { appealId: opened.appealId, outcome: "upheld", note: "the rule was broken" },
      { context: contextFor(mod2) },
    );
    expect(reviewed).toEqual({ appealId: opened.appealId, status: "upheld" });

    const [stillRemoved] = await anonContext.db
      .select({ removedAt: post.removedAt })
      .from(post)
      .where(eq(post.id, postRow.id));
    expect(stillRemoved?.removedAt).not.toBeNull();
    expect(await latestAction("post_restored", "post", postRow.id)).toBeUndefined();
    const resolution = await latestAction("appeal_resolved", "post", postRow.id);
    expect(resolution?.details).toEqual({ outcome: "upheld" });
  });

  it("a token for the wrong user, an expired token, and garbage are refused", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "token checks");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);

    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: appealLink(removal!.id, stranger.id), reason: "This link is not for me" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This appeal link is no longer valid." });

    const expired = appealLink(removal!.id, author.id, {
      iat: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
    });
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: expired, reason: "This link is stale" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This appeal link is invalid or has expired." });

    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: "garbage-not-a-token", reason: "This link is nonsense" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This appeal link is invalid or has expired." });
  });

  it("an action that can't be appealed, or one already undone, is refused", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "appealability checks");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);
    await call(
      appRouter.moderation.restorePost,
      { postId: postRow.id },
      { context: contextFor(mod) },
    );
    const restoreAction = await latestAction("post_restored", "post", postRow.id);

    // post_restored is not an appealable action.
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: appealLink(restoreAction!.id, author.id), reason: "Restore this restore" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This action can't be appealed." });

    // The removal was already undone — nothing left to contest.
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: appealLink(removal!.id, author.id), reason: "The removal was wrong" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "There's nothing to appeal anymore — this action was already undone.",
    });
  });

  it("a second open appeal on the same action is refused", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "one appeal only");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);

    await call(
      appRouter.moderation.appealOpen,
      { token: appealLink(removal!.id, author.id), reason: "First appeal" },
      { context: anonContext },
    );
    // A fresh link for the same action still collides on the open appeal.
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: appealLink(removal!.id, author.id), reason: "Second appeal" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "There's already an open appeal for this action." });

    await clearQueueFixtures();
  });

  it("the signed-in stub path: the author appeals their own removed post; others are refused", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "stub appeal");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );

    const opened = await call(
      appRouter.moderation.appealOpen,
      { postId: postRow.id, reason: "Appealing from the stub" },
      { context: contextFor(author) },
    );
    expect(opened.appealId).toMatch(/^[0-9a-f-]{36}$/);
    expect(opened.status).toBe("open");

    await expect(
      call(
        appRouter.moderation.appealOpen,
        { postId: postRow.id, reason: "Not my post to appeal" },
        { context: contextFor(stranger) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "You can only appeal your own posts." });

    // A post with no removal record has nothing to appeal.
    const neverRemoved = await seedPostContent(author.id, "never removed");
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { postId: neverRemoved.id, reason: "Nothing happened here" },
        { context: contextFor(author) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This post has no removal to appeal." });

    // Signed out, the stub path has no session to authenticate with.
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { postId: postRow.id, reason: "No session at all" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await clearQueueFixtures();
  });

  it("exactly one of token or postId must be provided — and the reason has its 10..2000 bounds", async () => {
    const mod = await moderatorUser();
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { reason: "No identifier at all" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Provide either an appeal link or the removed post." });
    await expect(
      call(
        appRouter.moderation.appealOpen,
        {
          token: "whatever",
          postId: randomUUID(),
          reason: "Both identifiers at once",
        },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Provide either an appeal link or the removed post." });

    const author = await createTestUser();
    const postRow = await seedPostContent(author.id, "reason bounds");
    await call(
      appRouter.moderation.removePost,
      { postId: postRow.id, reason: "spam" },
      { context: contextFor(mod) },
    );
    const removal = await latestAction("post_removed", "post", postRow.id);
    await expect(
      call(
        appRouter.moderation.appealOpen,
        { token: appealLink(removal!.id, author.id), reason: "short" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("suspension overturn: the account is unsuspended and can sign back in", async () => {
    const victim = await createTestUser();
    const mod1 = await moderatorUser();
    const mod2 = await moderatorUser();
    await call(
      appRouter.moderation.suspendUser,
      { userId: victim.id, reason: "spam", durationSeconds: 3600 },
      { context: contextFor(mod1) },
    );
    const suspension = await latestAction("user_suspended", "user", victim.id);

    const opened = await call(
      appRouter.moderation.appealOpen,
      { token: appealLink(suspension!.id, victim.id), reason: "I was not spamming" },
      { context: anonContext },
    );
    await call(
      appRouter.moderation.appealReview,
      { appealId: opened.appealId, outcome: "overturned" },
      { context: contextFor(mod2) },
    );

    const [cleared] = await anonContext.db
      .select({ banned: user.banned, banExpires: user.banExpires, banReason: user.banReason })
      .from(user)
      .where(eq(user.id, victim.id));
    expect(cleared?.banned).toBe(false);
    expect(cleared?.banExpires).toBeNull();
    expect(cleared?.banReason).toBeNull();
    expect(await latestAction("user_unsuspended", "user", victim.id)).toBeDefined();

    // The account can sign back in and hold a live session again.
    const [victimRow] = await anonContext.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, victim.id));
    const signIn = await auth.api.signInEmail({
      body: { email: victimRow.email, password: "vitest-Sup3rSecret!" },
      returnHeaders: true,
    });
    expect(signIn.headers.get("set-cookie")).toBeTruthy();
  });
});

describe("gates", () => {
  it("anonymous callers are refused every procedure except appealOpen", async () => {
    const author = await createTestUser();
    const postRow = await seedPostContent(author.id, "gate fodder");

    // Every session-gated moderation procedure, with a shape-valid input so
    // the gate is what fires, not validation.
    await expect(
      call(
        appRouter.moderation.report,
        { targetType: "post", targetId: postRow.id, reason: "spam" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.block, { userId: author.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.unblock, { userId: author.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.queue, {}, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.case,
        { targetType: "post", targetId: postRow.id },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.resolve,
        { targetType: "post", targetId: postRow.id, outcome: "dismissed" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.removePost,
        { postId: postRow.id, reason: "spam" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.restorePost, { postId: postRow.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.suspendUser,
        { userId: author.id, reason: "spam", durationSeconds: 3600 },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.banUser,
        { userId: author.id, reason: "spam" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.unbanUser, { userId: author.id }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: author.id, role: "moderator" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.team, undefined, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.moderation.auditLog, {}, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        appRouter.moderation.appealReview,
        { appealId: randomUUID(), outcome: "upheld" },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a plain user is refused the moderator surface, a moderator the staff surface", async () => {
    const plain = await createTestUser();
    const mod = await moderatorUser();
    const victim = await createTestUser();
    const postRow = await seedPostContent(victim.id, "role gate fodder");

    // Plain user → moderator procedures: FORBIDDEN, never a leak.
    await expect(
      call(appRouter.moderation.queue, {}, { context: contextFor(plain) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.case,
        { targetType: "post", targetId: postRow.id },
        { context: contextFor(plain) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.resolve,
        { targetType: "post", targetId: postRow.id, outcome: "dismissed" },
        { context: contextFor(plain) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.removePost,
        { postId: postRow.id, reason: "spam" },
        { context: contextFor(plain) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(appRouter.moderation.restorePost, { postId: postRow.id }, { context: contextFor(plain) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.suspendUser,
        { userId: victim.id, reason: "spam", durationSeconds: 3600 },
        { context: contextFor(plain) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.appealReview,
        { appealId: randomUUID(), outcome: "upheld" },
        { context: contextFor(plain) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Moderator → staff procedures: FORBIDDEN.
    await expect(
      call(
        appRouter.moderation.banUser,
        { userId: victim.id, reason: "spam" },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(appRouter.moderation.unbanUser, { userId: victim.id }, { context: contextFor(mod) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        appRouter.moderation.setRole,
        { userId: victim.id, role: "moderator" },
        { context: contextFor(mod) },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(appRouter.moderation.team, undefined, { context: contextFor(mod) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(appRouter.moderation.auditLog, {}, { context: contextFor(mod) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
