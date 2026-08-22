/**
 * Focused tests for the appeal-intake module's own interface.
 *
 * The end-to-end behaviour of `moderation.appealOpen` — every refusal message,
 * both rate budgets, the token checks, the appealability gates — is pinned
 * through the procedure in `moderation.int.test.ts` and stays there: the
 * procedure is the interface its callers use. What lives here is what only the
 * module's own interface can reach:
 *
 * - the two sources normalising to the SAME appeal target, so an action
 *   appealed through one capability is closed to the other;
 * - concurrent opens, where the contested action-row lock serializes intake
 *   and the database constraints remain the final exactly-once backstop.
 *
 * Everything runs against real Postgres. The concurrency tests deliberately
 * use real calls rather than a stubbed lock: what is being verified is that
 * callers serialize on the real `moderation_action` row and still produce one
 * appeal with caller-facing refusals for every loser.
 */
import { randomUUID } from "node:crypto";
import { closeDb } from "@my-tuums/db";
import { desc, eq } from "drizzle-orm";
import { appeal, moderationAction, post } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { openAppeal } from "./appeal-intake.js";
import { appealToken } from "./appeal-token.js";
import { removePostEffect } from "./moderation-actions.js";
import {
  anonContext,
  contextFor,
  createTestUser,
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

/** A removed post and the `post_removed` row an appeal against it contests. */
async function removedPost(author: TestUser): Promise<{ postId: string; actionId: string }> {
  const moderator = await createTestUser();
  await setUserRole(moderator.id, "moderator");
  const [row] = await anonContext.db
    .insert(post)
    .values({ authorId: author.id, content: `intake fixture ${randomUUID()}` })
    .returning({ id: post.id });
  await removePostEffect(anonContext.db, {
    postId: row.id,
    actorId: moderator.id,
    reason: "spam",
  });
  const [action] = await anonContext.db
    .select({ id: moderationAction.id })
    .from(moderationAction)
    .where(eq(moderationAction.targetPostId, row.id))
    .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
    .limit(1);
  return { postId: row.id, actionId: action.id };
}

/** An email link for an action, minted the way `makeAppealUrl` does. */
function link(actionId: string, userId: string): string {
  return appealToken.sign({
    purpose: "appeal",
    actionId,
    userId,
    nonce: randomUUID(),
    iat: Math.floor(Date.now() / 1000),
  });
}

/** Every appeal row against one action — the exactly-once assertion's subject. */
async function appealsFor(actionId: string): Promise<{ id: string; tokenNonce: string }[]> {
  return anonContext.db
    .select({ id: appeal.id, tokenNonce: appeal.tokenNonce })
    .from(appeal)
    .where(eq(appeal.actionId, actionId));
}

describe("appeal intake — one target from two sources", () => {
  it("an appeal opened from the removed-post stub closes the email link for the same action", async () => {
    const author = await createTestUser();
    const { postId, actionId } = await removedPost(author);

    const opened = await openAppeal(contextFor(author), {
      postId,
      reason: "Appealing from the stub",
    });
    expect(opened.status).toBe("open");

    // The link names the same action, so it must meet the open appeal the
    // stub created — the sources differ, the target they normalise to does not.
    await expect(
      openAppeal(anonContext, {
        token: link(actionId, author.id),
        reason: "Appealing the same removal by link",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "There's already an open appeal for this action.",
    });

    expect(await appealsFor(actionId)).toHaveLength(1);
    await anonContext.db.delete(appeal);
  });

  it("an appeal opened from the email link closes the removed-post stub for the same action", async () => {
    const author = await createTestUser();
    const { postId, actionId } = await removedPost(author);

    await openAppeal(anonContext, {
      token: link(actionId, author.id),
      reason: "Appealing by link first",
    });

    await expect(
      openAppeal(contextFor(author), { postId, reason: "Appealing from the stub too" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "There's already an open appeal for this action.",
    });

    expect(await appealsFor(actionId)).toHaveLength(1);
    await anonContext.db.delete(appeal);
  });
});

describe("appeal intake — concurrent exactly-once", () => {
  const refusalSchema = z.object({ code: z.string(), message: z.string() });
  /**
   * The refusal depends on whether the loser presented the winning nonce or a
   * different link for the same action. Either way it must get a caller-facing
   * BAD_REQUEST after the action-row lock lets it observe the winner.
   */
  const LOSER_MESSAGES = [
    "This appeal link has already been used.",
    "There's already an open appeal for this action.",
  ];

  function refusals<Result>(results: PromiseSettledResult<Result>[]) {
    return results
      .filter((result) => result.status === "rejected")
      .map((result) => refusalSchema.parse(result.reason));
  }

  it("distinct links racing the same action: exactly one appeal, every loser a BAD_REQUEST", async () => {
    const author = await createTestUser();
    const { actionId } = await removedPost(author);

    // Eight fresh links — distinct nonces, so each spends its own budget. The
    // action-row lock serializes their replay reads; the open-per-action index
    // remains the database backstop.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        openAppeal(anonContext, {
          token: link(actionId, author.id),
          reason: `Racing appeal number ${String(i)}`,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await appealsFor(actionId)).toHaveLength(1);
    for (const refusal of refusals(results)) {
      expect(refusal.code).toBe("BAD_REQUEST");
      expect(LOSER_MESSAGES).toContain(refusal.message);
    }

    await anonContext.db.delete(appeal);
  });

  it("one link replayed concurrently: the nonce is spent once, every loser a BAD_REQUEST", async () => {
    const author = await createTestUser();
    const { actionId } = await removedPost(author);
    const token = link(actionId, author.id);

    // The same link eight times — all serialize on the action row and then see
    // the winning nonce as spent. The unique `token_nonce` column remains the
    // database backstop. All eight share one rate-limit key
    // (`report:appeal:<nonce>`), which the report tier's 20/min clears.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        openAppeal(anonContext, { token, reason: "Replaying one link concurrently" }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rows = await appealsFor(actionId);
    expect(rows).toHaveLength(1);
    for (const refusal of refusals(results)) {
      expect(refusal.code).toBe("BAD_REQUEST");
      expect(refusal.message).toBe("This appeal link has already been used.");
    }

    await anonContext.db.delete(appeal);
  });
});
