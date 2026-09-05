import { call } from "@orpc/server";
import { randomUUID } from "node:crypto";
import { closeDb } from "@my-tuums/db";
import { notification, notificationLastSeen, postAttachment, user } from "@my-tuums/db/schema";
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

/**
 * Same idea at the staff rank: `banUser`/`unbanUser` are staff+ procedures,
 * and this test is the notification surface under them, not the ban gate.
 */
async function staffUser(): Promise<TestUser> {
  const staff = await createTestUser();
  await setUserRole(staff.id, "staff");
  return freshSessionFor(staff);
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
      postAttachments: [],
    });
    // The preview (issue #281): the liked post's own words.
    expect(page.items[0].postContent).toMatch(/^seed post 0 /);
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
    // through to, and the thing whose deletion tombstones it below — and
    // previews the reply's own words, not the parent's.
    expect(page.items[0]).toMatchObject({
      type: "reply",
      postId: reply.id,
      actor: { id: replier.id },
      postContent: "a reply",
      postAttachments: [],
    });

    // The self-reply created no row at all: the author's count is 1 (the
    // other person's reply), not 2.
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });

  it("reposting a post notifies the author exactly once, including under retry", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(reposter) });
    // The retried repost: the composite primary key swallowed the insert, so
    // the notice must not mint a second time either.
    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(reposter) });

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    // The notice points at the reposted post — the recipient's own — on the
    // same rule the like row follows, and previews it the same way.
    expect(page.items[0]).toMatchObject({
      type: "repost",
      postId: target.id,
      read: false,
      actor: { id: reposter.id },
      postAttachments: [],
    });
    expect(page.items[0].postContent).toMatch(/^seed post 0 /);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });

  it("an unrepost removes nothing; reposting again is a new event, like → unlike → like", async () => {
    const author = await createTestUser();
    const reposter = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(reposter) });
    await call(appRouter.post.unrepost, { postId: target.id }, { context: contextFor(reposter) });
    // Rows are historical — the unrepost leaves the notice standing.
    expect((await listFor(author)).items).toHaveLength(1);

    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(reposter) });
    // Three intent statements, two reposts that actually landed: two notices.
    const page = await listFor(author);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.type)).toEqual(["repost", "repost"]);
  });

  it("a repost the author caused themselves never notifies", async () => {
    const author = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    // Allowed — amplifying your own post — and silent, like a self-like.
    await call(appRouter.post.repost, { postId: target.id }, { context: contextFor(author) });

    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });
    expect((await listFor(author)).items).toHaveLength(0);
  });

  it("quoting a post notifies its author once; a self-quote does not", async () => {
    const author = await createTestUser();
    const quoter = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    const quote = await call(
      appRouter.post.create,
      { content: "a quote", quotedPostId: target.id },
      { context: contextFor(quoter) },
    );
    // Quoting your own post is allowed by the same rule a self-reply is.
    await call(
      appRouter.post.create,
      { content: "my own words back", quotedPostId: target.id },
      { context: contextFor(author) },
    );

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    // The notice points at the quote itself — what the quoter said is the
    // thing to click through to, the reply's shape exactly, preview included.
    expect(page.items[0]).toMatchObject({
      type: "quote",
      postId: quote.id,
      read: false,
      actor: { id: quoter.id },
      postContent: "a quote",
      postAttachments: [],
    });
    // The self-quote created no row: one notice, not two.
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

    // Three intent statements, two edges that actually landed: two notices,
    // both genuinely unread — read state is the recipient's cursor, never
    // something the mint decides. The badge's one-tick collapse of the burst
    // is the next test's subject.
    expect((await listFor(followed)).items).toHaveLength(2);
    expect((await listFor(followed)).items.map((item) => item.read)).toEqual([false, false]);
  });

  it("damps the badge to one tick per actor-minute while every row stays listed and unread", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [first, second, third] = await seedPosts(author.id, 3);

    // The burst's two events land inside one damping bucket (pinned to a
    // single instant below — two real-time mints could straddle a minute
    // boundary, which is the damper's documented best-effort slack, not
    // something this test should ever roll).
    await call(appRouter.post.like, { postId: first.id }, { context: contextFor(liker) });
    await call(appRouter.post.like, { postId: second.id }, { context: contextFor(liker) });
    await author.context.db
      .update(notification)
      .set({ createdAt: sql`date_trunc('minute', now()) - interval '61 seconds'` })
      .where(eq(notification.recipientId, author.id));

    // One tick for the burst, but both rows are on the page and both are
    // unread — the damper counts ticks, it never rewrites read state.
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
    const burst = await listFor(author);
    expect(burst.items).toHaveLength(2);
    expect(burst.items.map((item) => item.read)).toEqual([false, false]);

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

    // The next minute is a new bucket: the same actor's next like ticks
    // again without anyone touching the rows.
    await call(appRouter.post.like, { postId: third.id }, { context: contextFor(liker) });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 3,
    });
    // Nothing was lost and nothing was quietly read: every event the burst
    // caused is still on the page, still unread.
    const after = await listFor(author);
    expect(after.items).toHaveLength(4);
    expect(after.items.every((item) => !item.read)).toBe(true);
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
      // A moderation row carries no post preview: its `post_id` is null, the
      // action speaks for itself.
      postContent: null,
      postAttachments: [],
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

  it("a banned actor's notifications stop surfacing and come back when the ban is lifted", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    expect((await listFor(author)).items).toHaveLength(1);

    // No generation half to pin here, unlike the block test above: a ban
    // sweeps the banned account's sessions, so the cause itself is already
    // unreachable — that refusal is the ban's own, pinned in
    // moderation.int.test.ts. This test owns the surfacing half: the ban
    // term of `visibleNotification`.
    const staff = await staffUser();
    await call(
      appRouter.moderation.banUser,
      { userId: liker.id, reason: "spam" },
      { context: contextFor(staff) },
    );
    expect((await listFor(author)).items).toHaveLength(0);
    // The badge cannot show a number the page behind it would not clear.
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });

    // The row survives the ban — lifting it brings the history back.
    await call(
      appRouter.moderation.unbanUser,
      { userId: liker.id },
      { context: contextFor(staff) },
    );
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

  it("previews the post's content and attachments on the row (issue #281)", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    // A seeded attachment row: the read side must correlate the aggregate on
    // the row's own (un-aliased) post join — the failure mode is a silent
    // empty list, not an error, so only a real row pins the wiring.
    const attachmentId = randomUUID();
    await author.context.db.insert(postAttachment).values({
      id: attachmentId,
      postId: target.id,
      position: 0,
      mediaPath: "/media/posts/preview.png",
      contentType: "image/png",
      byteSize: 2048,
      width: 640,
      height: 480,
    });

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].postContent).toMatch(/^seed post 0 /);
    expect(page.items[0].postAttachments).toEqual([
      {
        id: attachmentId,
        url: "/media/posts/preview.png",
        position: 0,
        contentType: "image/png",
        byteSize: 2048,
        width: 640,
        height: 480,
      },
    ]);
  });

  it("a like on a moderator-removed post previews nothing — the tombstone rule follows the row", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const moderator = await moderatorUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    await call(
      appRouter.moderation.removePost,
      { postId: target.id, reason: "rule break" },
      { context: contextFor(moderator) },
    );

    // The removal notice joins the like row on the page; the like row itself
    // still surfaces (removal is not deletion) but its preview reads empty —
    // removed content stays behind the tombstone on this surface like on
    // every other one, including for the post's own author.
    const page = await listFor(author);
    expect(page.items).toHaveLength(2);
    const likeRow = page.items.find((item) => item.type === "like");
    expect(likeRow).toMatchObject({ postContent: null, postAttachments: [] });
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

  it("markRead never moves the cursor backwards — an out-of-order commit cannot resurrect rows as unread", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    await call(appRouter.notification.markRead, {}, { context: contextFor(author) });

    // `now()` reads the transaction's start time, so a page open that
    // started later can commit first; its newer stamp is what the cursor
    // must keep. Simulated deterministically by a stamp ahead of this
    // markRead's transaction clock: a blind `seen_at = now()` upsert would
    // write its own earlier time and the cursor would move backwards.
    await author.context.db
      .update(notificationLastSeen)
      .set({ seenAt: sql`now() + interval '1 hour'` })
      .where(eq(notificationLastSeen.recipientId, author.id));
    const [ahead] = await author.context.db
      .select({ seenAt: notificationLastSeen.seenAt })
      .from(notificationLastSeen)
      .where(eq(notificationLastSeen.recipientId, author.id));

    await call(appRouter.notification.markRead, {}, { context: contextFor(author) });

    const [after] = await author.context.db
      .select({ seenAt: notificationLastSeen.seenAt })
      .from(notificationLastSeen)
      .where(eq(notificationLastSeen.recipientId, author.id));
    expect(after.seenAt.getTime()).toBe(ahead.seenAt.getTime());
    // And the page still reads the row the ahead stamp covered.
    expect((await listFor(author)).items.every((item) => item.read)).toBe(true);
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

  it("an event that lands after the page was opened is unread again — the cursor, not a row rewrite, decides", async () => {
    const author = await createTestUser();
    const firstLiker = await createTestUser();
    const lateLiker = await createTestUser();
    const [a, b] = await seedPosts(author.id, 2);

    await call(appRouter.post.like, { postId: a.id }, { context: contextFor(firstLiker) });
    await call(appRouter.notification.markRead, {}, { context: contextFor(author) });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });

    // After the stamp, in the same damping bucket as nothing: a tick.
    await call(appRouter.post.like, { postId: b.id }, { context: contextFor(lateLiker) });
    const page = await listFor(author);
    expect(page.items.map((item) => item.read)).toEqual([false, true]);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });

  it("rows past the retention horizon leave the list and the badge together", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [fresh, old] = await seedPosts(author.id, 2);

    await call(appRouter.post.like, { postId: old.id }, { context: contextFor(liker) });
    // Past the horizon by the same database clock the read side compares on.
    await author.context.db
      .update(notification)
      .set({ createdAt: sql`now() - interval '91 days'` })
      .where(eq(notification.postId, old.id));
    await call(appRouter.post.like, { postId: fresh.id }, { context: contextFor(liker) });

    const page = await listFor(author);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ postId: fresh.id });
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });
});

describe("notification deletion (issue #330)", () => {
  it("deleting your own notification removes it and clears its badge tick", async () => {
    const author = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    const before = await listFor(author);
    expect(before.items).toHaveLength(1);

    const result = await call(
      appRouter.notification.delete,
      { id: before.items[0].id },
      { context: contextFor(author) },
    );
    expect(result).toEqual({ success: true, id: before.items[0].id });

    expect((await listFor(author)).items).toHaveLength(0);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });
  });

  it("deleting someone else's notification is NOT_FOUND and keeps their row", async () => {
    const author = await createTestUser();
    const other = await createTestUser();
    const liker = await createTestUser();
    const [target] = await seedPosts(author.id, 1);

    await call(appRouter.post.like, { postId: target.id }, { context: contextFor(liker) });
    const [{ id }] = (await listFor(author)).items;

    await expect(
      call(appRouter.notification.delete, { id }, { context: contextFor(other) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listFor(author)).items).toHaveLength(1);
  });

  it("deleting an unknown notification is NOT_FOUND", async () => {
    const viewer = await createTestUser();

    await expect(
      call(appRouter.notification.delete, { id: randomUUID() }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deleting one of two unread notifications leaves the badge at one", async () => {
    const author = await createTestUser();
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

    const page = await listFor(author);
    await call(
      appRouter.notification.delete,
      { id: page.items[0].id },
      { context: contextFor(author) },
    );

    expect((await listFor(author)).items).toHaveLength(1);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 1,
    });
  });

  it("clearAll removes only the caller's rows and reports how many", async () => {
    const author = await createTestUser();
    const other = await createTestUser();
    const liker = await createTestUser();
    const [mine] = await seedPosts(author.id, 1);
    const [theirs] = await seedPosts(other.id, 1);

    await call(appRouter.post.like, { postId: mine.id }, { context: contextFor(liker) });
    await call(appRouter.post.like, { postId: theirs.id }, { context: contextFor(liker) });

    const cleared = await call(
      appRouter.notification.clearAll,
      {},
      { context: contextFor(author) },
    );
    expect(cleared).toEqual({ deletedCount: 1 });

    expect((await listFor(author)).items).toHaveLength(0);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(author) }),
    ).toEqual({
      unreadCount: 0,
    });
    // The other recipient's inbox is untouched.
    expect((await listFor(other)).items).toHaveLength(1);
  });

  it("clearAll on an empty inbox reports zero", async () => {
    const viewer = await createTestUser();

    await expect(
      call(appRouter.notification.clearAll, {}, { context: contextFor(viewer) }),
    ).resolves.toEqual({ deletedCount: 0 });
  });
});
