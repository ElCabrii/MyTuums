import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { closeDb } from "@my-tuums/db";
import { appeal, moderationAction, post } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appealToken } from "./appeal-token.js";
import { openAppealFromRemovedPost, openAppealFromToken } from "./appeal-intake.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  setUserRole,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";

/**
 * Focused tests for the deep appeal-intake module's interface
 * (`./appeal-intake.ts`), called directly rather than through the oRPC
 * procedure. The full behaviour is already pinned end-to-end by
 * `moderation.int.test.ts` through `moderation.appealOpen`; these exercise
 * the module's own seam — the two source adapters and the common tail — so a
 * change to the module that the procedure still forwards to cannot slip past
 * both suites.
 */

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** A user promoted to moderator through the row, re-fetched so the session carries the role. */
async function moderatorUser(): Promise<TestUser> {
  const user = await createTestUser();
  await setUserRole(user.id, "moderator");
  return freshSessionFor(user);
}

/** Direct insert for a content-controlled post fixture. */
async function seedPostContent(authorId: string, content: string): Promise<{ id: string }> {
  const [inserted] = await anonContext.db
    .insert(post)
    .values({ authorId, content })
    .returning({ id: post.id });
  return inserted;
}

/**
 * Removes a post the way `removePostEffect` does — the tombstone AND the
 * `post_removed` audit row — so the intake module's `isActionCurrent` live
 * state check sees a genuinely current removal. A bare audit row with no
 * tombstone reads as "already undone".
 */
async function removePost(
  actorId: string,
  postId: string,
  reason: string,
): Promise<{ actionId: string }> {
  await anonContext.db
    .update(post)
    .set({ removedAt: new Date(), removedBy: actorId, removedReason: reason })
    .where(eq(post.id, postId));
  const [action] = await anonContext.db
    .insert(moderationAction)
    .values({
      action: "post_removed",
      actorId,
      targetType: "post",
      targetPostId: postId,
      reason,
    })
    .returning({ id: moderationAction.id });
  return { actionId: action.id };
}

/** The newest `moderation_action` row matching an action code and target. */
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

/** Mints an appeal link the way the emails do, bound to the action's user. */
function appealLink(actionId: string, userId: string): string {
  return appealToken.sign({
    purpose: "appeal",
    actionId,
    userId,
    nonce: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  });
}

/** Reads one appeal row by id. */
async function appealRow(id: string) {
  const [row] = await anonContext.db
    .select({
      actionId: appeal.actionId,
      appellantId: appeal.appellantId,
      tokenNonce: appeal.tokenNonce,
      reason: appeal.reason,
      status: appeal.status,
    })
    .from(appeal)
    .where(eq(appeal.id, id));
  return row;
}

describe("appeal intake module", () => {
  it("the token adapter and the removed-post adapter normalize to the same appeal target", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "intake module target");
    const removal = await removePost(mod.id, postRow.id, "spam");

    // Token path — signed out.
    const fromToken = await openAppealFromToken(
      anonContext,
      appealLink(removal.actionId, author.id),
      "Appealing from the email link",
    );
    expect(fromToken.status).toBe("open");
    const tokenRow = await appealRow(fromToken.appealId);
    expect(tokenRow?.actionId).toBe(removal.actionId);
    expect(tokenRow?.appellantId).toBe(author.id);
    expect(tokenRow?.reason).toBe("Appealing from the email link");
    expect(tokenRow?.status).toBe("open");

    // Removed-post path — signed in as the author. A fresh removal so the
    // open-per-action partial index does not collide with the token appeal.
    const postRow2 = await seedPostContent(author.id, "intake module stub");
    const removal2 = await removePost(mod.id, postRow2.id, "spam");

    const fromStub = await openAppealFromRemovedPost(
      contextFor(author),
      author.session.user,
      postRow2.id,
      "Appealing from the stub",
    );
    expect(fromStub.status).toBe("open");
    const stubRow = await appealRow(fromStub.appealId);
    expect(stubRow?.actionId).toBe(removal2.actionId);
    expect(stubRow?.appellantId).toBe(author.id);
    expect(stubRow?.reason).toBe("Appealing from the stub");
    expect(stubRow?.status).toBe("open");

    await anonContext.db.delete(appeal);
  });

  it("the common tail refuses a replayed link and a second open appeal on the same action", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "intake replay");
    const removal = await removePost(mod.id, postRow.id, "spam");
    const token = appealLink(removal.actionId, author.id);

    await openAppealFromToken(anonContext, token, "First appeal");

    // Replaying the same link is refused — the nonce is spent.
    await expect(
      openAppealFromToken(anonContext, token, "Replaying the same link"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This appeal link has already been used.",
    });

    // A fresh link for the same action collides on the open appeal.
    await expect(
      openAppealFromToken(anonContext, appealLink(removal.actionId, author.id), "Second appeal"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "There's already an open appeal for this action.",
    });

    await anonContext.db.delete(appeal);
  });

  it("the common tail refuses a non-appealable action, a wrong-user link, and an undone action", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "intake validity");
    const removal = await removePost(mod.id, postRow.id, "spam");

    // A token for the wrong user is refused.
    await expect(
      openAppealFromToken(anonContext, appealLink(removal.actionId, stranger.id), "Not my action"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This appeal link is no longer valid.",
    });

    // A non-appealable action (post_restored) is refused.
    await anonContext.db
      .insert(moderationAction)
      .values({
        action: "post_restored",
        actorId: mod.id,
        targetType: "post",
        targetPostId: postRow.id,
        reason: null,
      })
      .returning({ id: moderationAction.id });
    const restore = await latestAction("post_restored", "post", postRow.id);
    await expect(
      openAppealFromToken(anonContext, appealLink(restore!.id, author.id), "Restore this restore"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This action can't be appealed." });

    // An undone action (the removal was restored) is refused.
    await anonContext.db
      .update(post)
      .set({ removedAt: null, removedBy: null, removedReason: null })
      .where(eq(post.id, postRow.id));
    await expect(
      openAppealFromToken(anonContext, appealLink(removal.actionId, author.id), "The removal was wrong"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "There's nothing to appeal anymore — this action was already undone.",
    });

    await anonContext.db.delete(appeal);
  });

  it("the removed-post adapter refuses a stranger and a post with no removal", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const mod = await moderatorUser();
    const postRow = await seedPostContent(author.id, "intake stub ownership");
    await removePost(mod.id, postRow.id, "spam");

    // A stranger cannot appeal the author's removed post.
    await expect(
      openAppealFromRemovedPost(
        contextFor(stranger),
        stranger.session.user,
        postRow.id,
        "Not my post",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "You can only appeal your own posts." });

    // A post with no removal record has nothing to appeal.
    const neverRemoved = await seedPostContent(author.id, "never removed");
    await expect(
      openAppealFromRemovedPost(
        contextFor(author),
        author.session.user,
        neverRemoved.id,
        "Nothing happened here",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "This post has no removal to appeal." });

    await anonContext.db.delete(appeal);
  });
});
