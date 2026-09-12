import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { moderationAction, notification, notificationLastSeen } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";
import { pruneExpiredNotifications } from "./notification-retention.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("D1 notification lifecycle", () => {
  it("concurrent page opens count each newly read row once and leave future rows unread", async () => {
    const recipient = await createTestUser();
    const actor = await createTestUser();
    const [current, future] = await db
      .insert(notification)
      .values([
        { recipientId: recipient.id, actorId: actor.id, type: "follow" },
        {
          recipientId: recipient.id,
          actorId: actor.id,
          type: "follow",
          createdAt: new Date(Date.now() + 3600000),
        },
      ])
      .returning({ id: notification.id });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(appRouter.notification.markRead, {}, { context: contextFor(recipient) }),
      ),
    );
    expect(results.map(({ read }) => read).sort()).toEqual([0, 0, 0, 0, 0, 1]);
    const page = await call(appRouter.notification.list, {}, { context: contextFor(recipient) });
    expect(page.items.map(({ id, read }) => ({ id, read }))).toEqual([
      { id: future.id, read: false },
      { id: current.id, read: true },
    ]);
  });

  it("never damps actionable requests or null-actor video failure notices", async () => {
    const recipient = await createTestUser();
    const actor = await createTestUser();
    const createdAt = new Date(Math.floor(Date.now() / 60000) * 60000);
    await db.insert(notification).values([
      { recipientId: recipient.id, actorId: actor.id, type: "follow_request", createdAt },
      { recipientId: recipient.id, actorId: actor.id, type: "follow_request", createdAt },
      { recipientId: recipient.id, type: "video_failed", videoId: crypto.randomUUID(), createdAt },
      { recipientId: recipient.id, type: "video_failed", videoId: crypto.randomUUID(), createdAt },
    ]);
    expect(
      await call(appRouter.notification.unreadCount, {}, { context: contextFor(recipient) }),
    ).toEqual({ unreadCount: 4 });
    const page = await call(appRouter.notification.list, {}, { context: contextFor(recipient) });
    expect(page.items).toHaveLength(4);
    expect(
      page.items.filter(({ type }) => type === "video_failed").map(({ actor }) => actor),
    ).toEqual([null, null]);
  });

  it("prunes in bounded restartable steps without losing moderation notices or read cursors", async () => {
    const recipient = await createTestUser();
    const actor = await createTestUser();
    const createdAt = new Date(Date.now() - 91 * 86400000);
    const [action] = await db
      .insert(moderationAction)
      .values({
        action: "user_banned",
        targetType: "user",
        targetUserId: recipient.id,
        reason: "Synthetic retention fixture",
        createdAt,
      })
      .returning({ id: moderationAction.id });
    const [retained] = await db
      .insert(notification)
      .values({
        recipientId: recipient.id,
        type: "moderation",
        actionId: action.id,
        createdAt,
      })
      .returning({ id: notification.id });
    await db.run(sql`insert into notification (id, recipient_id, actor_id, type, created_at)
      select value, ${recipient.id}, ${actor.id}, 'follow', ${createdAt.getTime()}
      from json_each(${JSON.stringify(Array.from({ length: 251 }, () => crypto.randomUUID()))})`);
    await call(appRouter.notification.markRead, {}, { context: contextFor(recipient) });
    const [cursor] = await db
      .select()
      .from(notificationLastSeen)
      .where(eq(notificationLastSeen.recipientId, recipient.id));
    const [fresh] = await db
      .insert(notification)
      .values({
        recipientId: recipient.id,
        actorId: actor.id,
        type: "follow",
        createdAt: new Date(cursor.seenAt.getTime() + 1),
      })
      .returning({ id: notification.id });

    expect(await pruneExpiredNotifications(db)).toEqual({ deletedCount: 250, hasMore: true });
    expect(await pruneExpiredNotifications(db)).toEqual({ deletedCount: 1, hasMore: false });
    expect(await pruneExpiredNotifications(db)).toEqual({ deletedCount: 0, hasMore: false });
    const page = await call(appRouter.notification.list, {}, { context: contextFor(recipient) });
    expect(page.items.map(({ id, read }) => ({ id, read }))).toEqual([
      { id: fresh.id, read: false },
      { id: retained.id, read: true },
    ]);
    expect(
      await db
        .select()
        .from(notificationLastSeen)
        .where(eq(notificationLastSeen.recipientId, recipient.id)),
    ).toEqual([cursor]);
    expect(
      await db.select().from(moderationAction).where(eq(moderationAction.id, action.id)),
    ).toHaveLength(1);
  });
});
