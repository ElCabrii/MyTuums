import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appeal, moderationAction, notification, post } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import {
  anonContext,
  createTestUser,
  seedPosts,
  testEmailSender,
  truncateAll,
} from "./testing/harness.js";
import { removePost, restorePost } from "./moderation-actions.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("D1 post moderation appeal state", () => {
  it("rolls back manual reversal with its appeal stamps and notices, then closes the appeal without review fields", async () => {
    const author = await createTestUser();
    const moderator = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    await removePost(anonContext, { postId: target.id, actorId: moderator.id, reason: "Fixture" });
    const [action] = await db.select().from(moderationAction);
    const [opened] = await db
      .insert(appeal)
      .values({
        actionId: action.id,
        appellantId: author.id,
        tokenNonce: crypto.randomUUID(),
        reason: "Please review this removal.",
      })
      .returning();
    const restore = () => restorePost(anonContext, { postId: target.id, actorId: moderator.id });
    vi.mocked(testEmailSender.send).mockClear();
    await db.run(sql`create trigger reject_restore_test before update on post
      when old.removed_at is not null and new.removed_at is null
      begin select raise(abort, 'injected restore failure'); end`);
    try {
      await expect(restore()).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_restore_test`);
    }
    expect((await db.select().from(appeal).where(eq(appeal.id, opened.id)))[0]).toEqual(opened);
    expect(
      (await db.select().from(post).where(eq(post.id, target.id)))[0].removedAt,
    ).not.toBeNull();
    expect(await db.select().from(moderationAction)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
    await Promise.all([restore(), restore()]);
    expect((await db.select().from(appeal).where(eq(appeal.id, opened.id)))[0]).toMatchObject({
      status: "reversed",
      reviewedAt: null,
      reviewedBy: null,
      reviewNote: null,
    });
    expect(await db.select().from(moderationAction)).toHaveLength(2);
    expect(await db.select().from(notification)).toHaveLength(2);
    expect(vi.mocked(testEmailSender.send)).toHaveBeenCalledTimes(1);
  });

  it("commits withdrawal before refusing moderation of an author-deleted legacy post", async () => {
    const author = await createTestUser();
    const moderator = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    await removePost(anonContext, { postId: target.id, actorId: moderator.id, reason: "Fixture" });
    const [action] = await db.select().from(moderationAction);
    const [opened] = await db
      .insert(appeal)
      .values({
        actionId: action.id,
        appellantId: author.id,
        tokenNonce: crypto.randomUUID(),
        reason: "Please review this removal.",
      })
      .returning();
    // Legacy data may carry both tombstones; the normal author route refuses
    // deletion of a removed post. Withdrawal must still work for this state.
    await db.update(post).set({ deletedAt: new Date() }).where(eq(post.id, target.id));
    vi.mocked(testEmailSender.send).mockClear();
    await expect(
      restorePost(anonContext, { postId: target.id, actorId: moderator.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db.select().from(appeal).where(eq(appeal.id, opened.id)))[0]).toMatchObject({
      status: "withdrawn",
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(await db.select().from(moderationAction)).toHaveLength(1);
    expect(await db.select().from(notification)).toHaveLength(1);
    expect(vi.mocked(testEmailSender.send)).not.toHaveBeenCalled();
  });
});
