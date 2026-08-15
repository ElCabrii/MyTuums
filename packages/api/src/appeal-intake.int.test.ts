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
 * - the insert race, where the database's unique constraints — not the
 *   pre-read — are what make an appeal exactly-once.
 *
 * Everything runs against real Postgres. The race tests deliberately use real
 * concurrent calls rather than a stubbed constraint: what is being verified is
 * that the `appeal` table's unique `token_nonce` and its partial unique
 * open-per-action index actually settle the race, which a fake cannot show.
 */
import { randomUUID } from "node:crypto";
import { closeDb } from "@my-tuums/db";
import { desc, eq } from "drizzle-orm";
import { appeal, moderationAction, post } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("appeal intake — the insert race", () => {
  /**
   * The refusals a loser may legitimately get. Which one it is depends on
   * whether it lost at the pre-read or at the constraint, and that is a real
   * interleaving the test does not pin: what must hold either way is that the
   * loser gets a caller-facing BAD_REQUEST and never an untranslated database
   * error. Deleting the unique-violation branch in `insertAppeal` turns the
   * constraint loser into a 500 and fails this.
   */
  const LOSER_MESSAGES = [
    "This appeal link has already been used.",
    "There's already an open appeal for this action.",
  ];

  function refusals(results: PromiseSettledResult<unknown>[]): { code: string; message: string }[] {
    return results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason as { code: string; message: string });
  }

  it("distinct links racing the same action: exactly one appeal, every loser a BAD_REQUEST", async () => {
    const author = await createTestUser();
    const { actionId } = await removedPost(author);

    // Eight fresh links — distinct nonces, so each spends its own budget and
    // the only thing that can separate them is the open-per-action index.
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

    // The same link eight times — one nonce, so the unique `token_nonce`
    // column is the constraint in play. All eight share one rate-limit key
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
