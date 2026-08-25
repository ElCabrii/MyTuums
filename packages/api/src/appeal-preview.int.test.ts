/**
 * `moderation.appealPreview` — the author-gated look at the post an appeal is
 * about.
 *
 * What this pins is the authorization boundary, because that is the whole
 * reason the procedure exists in the shape it does: it is session-gated (a
 * post removal suspends nobody, so its author can always sign in), it answers
 * only to the appellant whatever identifier was presented, and it returns the
 * raw content and the tombstoned attachments that every other read surface
 * takes away.
 *
 * The `/media/` half of the same story — that the author may actually fetch
 * the attachment URLs this returns — is pinned in `./post-media.int.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { call, ORPCError } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { desc, eq } from "drizzle-orm";
import { moderationAction, post, postAttachment } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appealToken } from "./appeal-token.js";
import { removePostEffect, suspendUserEffect } from "./moderation-actions.js";
import { appRouter } from "./router.js";
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

async function latestActionFor(postId: string): Promise<string> {
  const [action] = await anonContext.db
    .select({ id: moderationAction.id })
    .from(moderationAction)
    .where(eq(moderationAction.targetPostId, postId))
    .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
    .limit(1);
  return action.id;
}

/** A removed post carrying `images` attachments, plus the action contesting it. */
async function removedPost(
  author: TestUser,
  content: string,
  images = 0,
): Promise<{ postId: string; actionId: string }> {
  const moderator = await createTestUser();
  await setUserRole(moderator.id, "moderator");
  const [row] = await anonContext.db
    .insert(post)
    .values({ authorId: author.id, content })
    .returning({ id: post.id });
  for (let position = 0; position < images; position += 1) {
    await anonContext.db.insert(postAttachment).values({
      postId: row.id,
      position,
      mediaPath: `/media/posts/${author.id}/${row.id}/${randomUUID()}.png`,
      contentType: "image/png",
      byteSize: 24,
      width: 64,
      height: 64,
    });
  }
  await removePostEffect(anonContext.db, {
    postId: row.id,
    actorId: moderator.id,
    reason: "spam",
  });
  return { postId: row.id, actionId: await latestActionFor(row.id) };
}

function preview(user: TestUser, input: { token?: string; postId?: string }) {
  return call(appRouter.moderation.appealPreview, input, { context: contextFor(user) });
}

describe("moderation.appealPreview", () => {
  it("returns the raw content and the tombstoned attachments an ordinary read takes away", async () => {
    const author = await createTestUser();
    const { postId, actionId } = await removedPost(author, "the removed words", 2);

    // Both identifiers the appeal page carries resolve to the same post.
    for (const input of [{ token: link(actionId, author.id) }, { postId }]) {
      const result = await preview(author, input);
      expect(result.post?.id).toBe(postId);
      expect(result.post?.content).toBe("the removed words");
      expect(result.post?.removedReason).toBe("spam");
      expect(result.post?.attachments).toHaveLength(2);
      expect(result.post?.attachments[0].url).toContain(`/media/posts/${author.id}/${postId}/`);
    }

    // The contrast that makes the procedure necessary: the ordinary read
    // surface nulls the content and drops the attachments, for the author too.
    const feed = await call(appRouter.post.thread, { postId }, { context: contextFor(author) });
    expect(feed.post.content).toBeNull();
    expect(feed.post.attachments).toHaveLength(0);
  });

  it("keeps an image-only post's attachments while its content reads empty", async () => {
    const author = await createTestUser();
    const { postId } = await removedPost(author, "", 1);

    const result = await preview(author, { postId });
    expect(result.post?.content).toBe("");
    expect(result.post?.attachments).toHaveLength(1);
  });

  it("answers only the appellant, whichever identifier is presented", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const { postId, actionId } = await removedPost(author, "not yours", 1);

    // A token handed onward is not a capability here: the session decides.
    await expect(preview(stranger, { token: link(actionId, author.id) })).rejects.toThrow(
      /no longer valid/,
    );
    await expect(preview(stranger, { postId })).rejects.toThrow(/no longer valid/);

    // Nor can a stranger mint themselves one — the HMAC still has to verify,
    // and the payload's own claim about who it belongs to buys nothing.
    await expect(preview(stranger, { token: link(actionId, stranger.id) })).rejects.toThrow(
      /no longer valid/,
    );
    await expect(preview(stranger, { token: "not.a.token" })).rejects.toThrow(
      /invalid or has expired/,
    );
  });

  it("requires exactly one identifier", async () => {
    const author = await createTestUser();
    const { postId, actionId } = await removedPost(author, "one or the other");

    await expect(preview(author, {})).rejects.toThrow(/either an appeal link or the removed post/);
    await expect(preview(author, { token: link(actionId, author.id), postId })).rejects.toThrow(
      /either an appeal link or the removed post/,
    );
  });

  it("previews nothing — successfully — for an action with no post behind it", async () => {
    const suspended = await createTestUser();
    const moderator = await createTestUser();
    await setUserRole(moderator.id, "moderator");
    const { pending } = await suspendUserEffect(anonContext.db, {
      userId: suspended.id,
      actorId: moderator.id,
      actorRole: "moderator",
      reason: "abuse",
      durationSeconds: 3600,
    });
    expect(pending).toHaveLength(1);
    const [action] = await anonContext.db
      .select({ id: moderationAction.id })
      .from(moderationAction)
      .where(eq(moderationAction.targetUserId, suspended.id))
      .orderBy(desc(moderationAction.createdAt), desc(moderationAction.id))
      .limit(1);

    // Not a refusal: the appeal form renders alone, exactly as it did before
    // this procedure existed.
    const result = await preview(suspended, { token: link(action.id, suspended.id) });
    expect(result.post).toBeNull();
  });

  it("refuses a post that was never removed", async () => {
    const author = await createTestUser();
    const [row] = await anonContext.db
      .insert(post)
      .values({ authorId: author.id, content: "still standing" })
      .returning({ id: post.id });

    await expect(preview(author, { postId: row.id })).rejects.toThrow(/no removal to appeal/);
    await expect(preview(author, { postId: row.id })).rejects.toBeInstanceOf(ORPCError);
  });
});
