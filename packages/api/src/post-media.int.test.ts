import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb } from "@my-tuums/db";
import { post, postAttachment, userBlock } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canViewPostMedia } from "./post-media.js";
import {
  anonContext,
  createTestUser,
  freshSessionFor,
  seedPosts,
  setUserRole,
  truncateAll,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("canViewPostMedia", () => {
  it("applies post tombstones, author blocks, and the moderator exception", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();
    const moderator = await createTestUser();
    await setUserRole(moderator.id, "moderator");
    const moderatorSession = await freshSessionFor(moderator);
    const [target] = await seedPosts(author.id, 1);
    const key = `posts/${author.id}/${target.id}/${randomUUID()}.png`;

    await anonContext.db.insert(postAttachment).values({
      postId: target.id,
      position: 0,
      mediaPath: `/media/${key}`,
      contentType: "image/png",
      byteSize: 24,
      width: 256,
      height: 128,
    });

    expect(await canViewPostMedia(anonContext.db, key, viewer.id)).toBe(true);

    await anonContext.db
      .update(post)
      .set({ removedAt: new Date(), removedReason: "policy" })
      .where(eq(post.id, target.id));
    expect(await canViewPostMedia(anonContext.db, key, viewer.id)).toBe(false);
    expect(await canViewPostMedia(anonContext.db, key, moderatorSession.id)).toBe(true);

    await anonContext.db.update(post).set({ removedAt: null }).where(eq(post.id, target.id));
    await anonContext.db.insert(userBlock).values({ blockerId: author.id, blockedId: viewer.id });
    expect(await canViewPostMedia(anonContext.db, key, viewer.id)).toBe(false);
    expect(await canViewPostMedia(anonContext.db, key, author.id)).toBe(true);

    // The row stays authoritative through moderation state changes; only the
    // media authorization result changes. This is what lets restore recover it.
    await anonContext.db.delete(userBlock).where(eq(userBlock.blockerId, author.id));
    expect(await canViewPostMedia(anonContext.db, key, viewer.id)).toBe(true);
  });
});
