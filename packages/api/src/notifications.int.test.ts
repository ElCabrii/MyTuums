import { call } from "@orpc/server";
import { closeDb } from "@my-tuums/db";
import { notification, user } from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import {
  contextFor,
  createTestUser,
  freshSessionFor,
  seedPosts,
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

/** A user promoted to moderator through the row, re-fetched so the session carries the role. */
async function moderatorUser(): Promise<TestUser> {
  const moderator = await createTestUser();
  await setUserRole(moderator.id, "moderator");
  return freshSessionFor(moderator);
}

/** The caller's notifications through the list procedure — the surface under test. */
function listFor(viewer: TestUser, cursor?: string, limit = 20) {
  return call(appRouter.notification.list, { cursor, limit }, { context: contextFor(viewer) });
}

describe("notification writes (issue #259)", () => {
  it("liking a post notifies the author exactly once, including under retry", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    // The retried like: idempotent for the like, so it must be for the notice.
    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      type: "like",
      postId: target.id,
      read: false,
      actor: { id: liker.id },
    });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });

  it("a like the author caused themselves never notifies", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(author) });

    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });
    expect((await listFor(author)).items).toHaveLength(0);
  });

  it("replying to a post notifies its author once; a self-reply does not", async () => {
    const author = await createTestUser();
    const replier = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const reply = await call(
      appRouter.post.create,
      { content: "a reply", parentId: target.id },
      { context: contextFor(replier) },
    );
    // A reply is not idempotent input, but one create is one notification.
    await call(
      appRouter.post.create,
      { content: "my own thread", parentId: target.id },
      { context: contextFor(author) },
    );

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    // The notification points at the reply itself — the thing to click
    // through to, and the thing whose deletion tombstones it below.
    expect(page.items[0]).toMatchObject({
      type: "reply",
      postId: reply.id,
      actor: { id: replier.id },
    });

    // The self-reply created no row at all: the author's count is 1 (the
    // other person's reply), not 2.
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });

  it("following notifies once under retry; unfollow and follow again is a new event, not a collapsed one", async () => {
    const followed = await createTestUser();
    const follower = await createTestUser();

    await call(appRouter.user.follow, { userId: followed.id }, { context: contextFor(follower) });
    await call(appRouter.user.follow, { userId: followed.id }, { context: contextFor(follower) });
    expect((await listFor(followed)).items).toHaveLength(1);

    await call(appRouter.user.unfollow, { userId: followed.id }, { context: contextFor(follower) });
    await call(appRouter.user.follow, { userId: followed.id }, { context: contextFor(follower) });

    // Three intent statements, two edges that actually landed: two notices.
    expect((await listFor(followed)).items).toHaveLength(2);
    // The second follow landed inside the burst window after the first, so
    // its row mints but arrives already read — follow cycling is the badge
    // flood vector, and the damper (pinned by the next test) is what keeps
    // it from pumping the badge while the honest two rows still show.
    expect((await listFor(followed)).items.map((item) => item.read)).toEqual([true, false]);
  });

  it("damps a same-type burst to one badge tick per actor-minute while listing every event", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [first, second, third] = await seedPosts(author.id, 3);

    // The burst's first event ticks; the second, same actor and same type
    // inside the window, lands born-read — visible on the page, silent to
    // the badge.
    await call(appRouter.post.like, { postId: first.id }, { context: contextFor(liker) });
    await call(appRouter.post.like, { postId: second.id }, { context: contextFor(liker) });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
    const burst = await listFor(author);
    expect(burst.items).toHaveLength(2);
    expect(burst.items[0]).toMatchObject({ type: "like", read: true });
    expect(burst.items[1]).toMatchObject({ type: "like", read: false });

    // A different type from the same actor is a different signal: it ticks.
    await call(
      appRouter.post.create,
      { content: "a burst reply", parentId: first.id },
      { context: contextFor(liker) },
    );
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 2,
    });

    // The window trails the burst, not the calendar: age the rows past it by
    // hand (a minute is too long to wait honestly) and the same actor's
    // next like ticks again.
    await author.context.db
      .update(notification)
      .set({ createdAt: sql`${notification.createdAt} - make_interval(secs => 61)` })
      .where(eq(notification.recipientId, author.id));
    await call(appRouter.post.like, { postId: third.id }, { context: contextFor(liker) });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 3,
    });
    // Nothing was lost: every event the burst caused is still on the page.
    expect((await listFor(author)).items).toHaveLength(4);
  });

  it("a moderation action notifies the affected user in-app alongside the email it already sends", async () => {
    const author = await createTestUser();
    const moderator = await moderatorUser();
    const [target] = await seedPosts(author.id, 1);

    await call(
      appRouter.moderation.removePost,
      { postId: target.id, reason: "rule break" },
      { context: contextFor(moderator) },
    );

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      type: "moderation",
      read: false,
      // The notice is from MyTuums, matching the branded email — the
      // moderator's identity is audit-log material, not recipient-facing.
      actor: null,
      action: { code: "post_removed", reason: "rule break", targetPostId: target.id },
    });
  });

  it("a user blocked by the recipient stops generating and surfacing notifications for them", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });

    // Generation: once blocked, the liker cannot even like again — the block
    // hides the author from them, so the cause itself is refused.
    await call(appRouter.moderation.block, { userId: liker.id }, { context: contextFor(author) });
    const [second] = await seedPosts(author.id, 1);
    await expect(
      call(appRouter.post.like, { postId: second.id }, { context: contextFor(liker) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Surfacing: the pre-block notice no longer renders for the recipient,
    // and the badge cannot show a number the page would not clear.
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });
    expect((await listFor(author)).items).toHaveLength(0);

    // The row survives the block — unblocking brings the history back.
    await call(appRouter.moderation.unblock, { userId: liker.id }, { context: contextFor(author) });
    expect((await listFor(author)).items).toHaveLength(1);
  });

  it("deleting a post tombstones its notifications, like it tombstones its replies", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    const reply = await call(
      appRouter.post.create,
      { content: "a reply", parentId: target.id },
      { context: contextFor(liker) },
    );
    expect((await listFor(author)).items).toHaveLength(2);

    // The author deletes the liked post: its like notification goes with it.
    await call(appRouter.post.delete, { postId: target.id }, { context: contextFor(author) });
    expect((await listFor(author)).items).toHaveLength(1);

    // The liker deletes the reply: the reply notification goes with it too.
    await call(appRouter.post.delete, { postId: reply.id }, { context: contextFor(liker) });
    expect((await listFor(author)).items).toHaveLength(0);

    // Tombstoned, not removed: the rows stand with their read state intact.
    const rows = await author.context.db
      .select({ id: notification.id })
      .from(notification)
      .where(eq(notification.recipientId, author.id));
    expect(rows).toHaveLength(2);
  });

  it("a user-caused notification whose actor was hard-deleted drops off the list", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    expect((await listFor(author)).items).toHaveLength(1);

    await author.context.db.delete(user).where(eq(user.id, liker.id));
    expect((await listFor(author)).items).toHaveLength(0);
  });
});

describe("notification reads (issue #259)", () => {
  it("pages newest-first with an exactly-once keyset walk", async () => {
    const author = await createTestUser();
    const [p1, p2, p3, p4, p5, p6] = await seedPosts(author.id, 6);
    const posts = [p1, p2, p3, p4, p5, p6];
    const likers = await Promise.all(
      posts.map(async (_, i) => {
        const liker = await createTestUser();
        // One distinct liker per post, so each like is a distinct event.
        await call(appRouter.post.like, { postId: posts[i].id }, { context: contextFor(liker) });
        return liker;
      }),
    );

    const first = await listFor(author, undefined, 4);
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await listFor(author, first.nextCursor!, 4);
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(6);

    // Newest first: the later-liked posts (created later) lead the list.
    const all = await listFor(author, undefined, 20);
    const createdOrder = all.items.map((item) => item.createdAt.getTime());
    expect([...createdOrder].sort((a, b) => b - a)).toEqual(createdOrder);
    // Every row carries its actor's public summary — one distinct liker each.
    const actorIds = new Set(all.items.map((item) => item.actor?.id));
    expect(actorIds.size).toBe(6);
    for (const liker of likers) expect(actorIds.has(liker.id)).toBe(true);
  });

  it("markRead stamps every unread row once and takes the badge to zero", async () => {
    const author = await createTestUser();
    // Two likers, not one: a same-type event from the same actor inside the
    // burst window arrives born-read (see the damper test), and this test is
    // about stamping two genuinely unread rows.
    const firstLiker = await createTestUser();
    const secondLiker = await createTestUser();
    const [a, b] = await seedPosts(author.id, 2);
    await call(appRouter.post.like, { postId: a.id }, { context: contextFor(firstLiker) });
    await call(appRouter.post.like, { postId: b.id }, { context: contextFor(secondLiker) });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 2,
    });

    const first = await call(appRouter.notification.markRead, {}, { context: contextFor(author) });
    expect(first).toEqual({ read: 2 });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });
    expect((await listFor(author)).items.every((item) => item.read)).toBe(true);

    // Idempotent: repeating states the same end state.
    const second = await call(appRouter.notification.markRead, {}, { context: contextFor(author) });
    expect(second).toEqual({ read: 0 });
  });

  it("the list serves only its recipient", async () => {
    const author = await createTestUser();
    const other = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });

    expect((await listFor(other)).items).toHaveLength(0);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(other) }),
    ).toEqual({
      unreadCount: 0,
    });
  });
});
