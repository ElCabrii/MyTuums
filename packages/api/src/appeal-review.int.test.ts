import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appeal, moderationAction, notification, post } from "@my-tuums/db/schema";
import { reviewAppeal } from "./appeal-review.js";
import { openAppeal } from "./appeal-intake.js";
import { removePost } from "./moderation-actions.js";
import { db } from "./testing/runtime.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  seedPosts,
  testEmailSender,
  truncateAll,
} from "./testing/harness.js";

beforeEach(truncateAll);
afterAll(truncateAll);

async function removedPostAppeal() {
  const author = await createTestUser();
  const moderator = await createTestUser();
  const [target] = await seedPosts(author.id, 1);
  await removePost(anonContext, { postId: target.id, actorId: moderator.id, reason: "Fixture" });
  const opened = await openAppeal(contextFor(author), {
    postId: target.id,
    reason: "Please review this removal.",
  });
  vi.mocked(testEmailSender.send).mockClear();
  return { target, opened };
}

describe("atomic D1 appeal review", () => {
  it("rolls back a restoration, both audit rows and notices when the final review stamp fails", async () => {
    const { target, opened } = await removedPostAppeal();
    const reviewer = await createTestUser();
    const [before] = await db.select().from(appeal).where(eq(appeal.id, opened.appealId));
    await db.run(sql`create trigger reject_review_test before update on appeal
      when new.status = 'overturned'
      begin select raise(abort, 'injected review stamp failure'); end`);
    try {
      await expect(
        reviewAppeal(anonContext, {
          appealId: opened.appealId,
          outcome: "overturned",
          actorId: reviewer.id,
          actorRole: "moderator",
          note: "Restore this post",
        }),
      ).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_review_test`);
    }
    expect((await db.select().from(appeal).where(eq(appeal.id, opened.appealId)))[0]).toEqual(
      before,
    );
    expect(
      (await db.select().from(post).where(eq(post.id, target.id)))[0].removedAt,
    ).not.toBeNull();
    expect(await db.select().from(moderationAction)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
    expect(
      await reviewAppeal(anonContext, {
        appealId: opened.appealId,
        outcome: "overturned",
        actorId: reviewer.id,
        actorRole: "moderator",
        note: "Restore this post",
      }),
    ).toEqual({ appealId: opened.appealId, status: "overturned" });
    expect((await db.select().from(post).where(eq(post.id, target.id)))[0].removedAt).toBeNull();
    expect(await db.select().from(moderationAction)).toHaveLength(3);
    expect(await db.select().from(notification)).toHaveLength(3);
    expect(vi.mocked(testEmailSender.send)).toHaveBeenCalledTimes(2);
  });

  it("commits one of two conflicting reviews with exactly its state, audit, timestamp and notices", async () => {
    const { target, opened } = await removedPostAppeal();
    const first = await createTestUser();
    const second = await createTestUser();
    const requests = [
      { outcome: "upheld" as const, actorId: first.id, note: "Decision stands" },
      { outcome: "overturned" as const, actorId: second.id, note: "Restore this post" },
    ];
    const results = await Promise.allSettled(
      requests.map((input) =>
        reviewAppeal(anonContext, {
          ...input,
          appealId: opened.appealId,
          actorRole: "moderator",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "BAD_REQUEST", message: "This appeal has already been resolved." },
    });
    const winner = requests[results.findIndex((result) => result.status === "fulfilled")];
    const [reviewed] = await db.select().from(appeal).where(eq(appeal.id, opened.appealId));
    expect(reviewed).toMatchObject({
      status: winner.outcome,
      reviewedBy: winner.actorId,
      reviewNote: winner.note,
    });
    const actions = await db.select().from(moderationAction);
    const resolutions = actions.filter((action) => action.action === "appeal_resolved");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      actorId: winner.actorId,
      details: { outcome: winner.outcome },
    });
    expect(reviewed.reviewedAt).toEqual(resolutions[0].createdAt);
    const overturn = winner.outcome === "overturned";
    expect((await db.select().from(post).where(eq(post.id, target.id)))[0].removedAt === null).toBe(
      overturn,
    );
    expect(actions.filter((action) => action.action === "post_restored")).toHaveLength(
      overturn ? 1 : 0,
    );
    expect(await db.select().from(notification)).toHaveLength(overturn ? 3 : 2);
    expect(vi.mocked(testEmailSender.send)).toHaveBeenCalledTimes(overturn ? 2 : 1);
  });
});
