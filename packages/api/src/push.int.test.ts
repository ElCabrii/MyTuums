import { call } from "@orpc/server";
import { afterAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  notification,
  pushDelivery,
  pushSubscription,
  session,
  userBlock,
} from "@my-tuums/db/schema";
import { db, closeDb } from "./testing/runtime.js";
import { anonContext, contextFor, createTestUser, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";
import { notificationInsert } from "./notification-writer.js";
import { deliverPushNotifications } from "./push-delivery.js";
import type { PushSender } from "./web-push.js";

const publicKey = `B${"a".repeat(86)}`;
beforeEach(truncateAll);
afterAll(closeDb);

async function subscribedUser() {
  const viewer = await createTestUser();
  const context = { ...contextFor(viewer), webPushPublicKey: publicKey };
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
  await call(appRouter.push.subscribe, { endpoint, applicationServerKey: publicKey }, { context });
  return { viewer, context, endpoint };
}

it("requires authentication and refuses arbitrary HTTP destinations", async () => {
  await expect(call(appRouter.push.status, {}, { context: anonContext })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  const { context } = await subscribedUser();
  for (const endpoint of [
    "https://localhost/private",
    "https://fcm.googleapis.com.evil.example/token",
    "http://fcm.googleapis.com/token",
    "https://fcm.googleapis.com:8080/token",
    "https://user:password@fcm.googleapis.com/token",
  ]) {
    await expect(
      call(appRouter.push.subscribe, { endpoint, applicationServerKey: publicKey }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
});

it("only queues future notifications, and rolls back delivery with its cause", async () => {
  const viewer = await createTestUser();
  const actor = await createTestUser();
  await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
  const context = { ...contextFor(viewer), webPushPublicKey: publicKey };
  await call(
    appRouter.push.subscribe,
    { endpoint: "https://web.push.apple.com/test", applicationServerKey: publicKey },
    { context },
  );
  expect(await db.select().from(pushDelivery)).toHaveLength(0);
  const notice = notificationInsert(db, {
    recipientId: viewer.id,
    actorId: actor.id,
    type: "follow",
  });
  if (!notice) throw new Error("Expected notification statement");
  await expect(
    db.batch([
      notice,
      db.insert(notification).values({
        id: crypto.randomUUID(),
        recipientId: viewer.id,
        actorId: actor.id,
        type: "like",
      }),
    ]),
  ).rejects.toThrow();
  expect(await db.select().from(pushDelivery)).toHaveLength(0);
  await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
  expect(await db.select().from(pushDelivery)).toHaveLength(1);
  await call(
    appRouter.push.subscribe,
    { endpoint: "https://web.push.apple.com/test", applicationServerKey: publicKey },
    { context },
  );
  expect(await db.select().from(pushDelivery)).toHaveLength(1);
});

it("cannot take over or unsubscribe another login's device", async () => {
  const first = await subscribedUser();
  const second = await subscribedUser();
  await expect(
    call(
      appRouter.push.subscribe,
      { endpoint: first.endpoint, applicationServerKey: publicKey },
      { context: second.context },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await call(appRouter.push.unsubscribe, {}, { context: second.context });
  expect(await call(appRouter.push.status, {}, { context: first.context })).toMatchObject({
    endpoint: first.endpoint,
  });
  expect(await call(appRouter.push.status, {}, { context: second.context })).toMatchObject({
    endpoint: null,
  });
});

it.each(["unsubscribe", "logout", "expired"] as const)(
  "revokes queued deliveries on %s",
  async (action) => {
    const { viewer, context } = await subscribedUser();
    const actor = await createTestUser();
    await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
    if (action === "unsubscribe") await call(appRouter.push.unsubscribe, {}, { context });
    if (action === "logout")
      await db.delete(session).where(eq(session.id, viewer.session.session.id));
    if (action === "expired")
      await db
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.id, viewer.session.session.id));
    const delivered: string[] = [];
    await deliverPushNotifications(db, {
      publicKey,
      send: (endpoint) => {
        delivered.push(endpoint);
        return Promise.resolve("sent" as const);
      },
    });
    expect(delivered).toEqual([]);
    expect(await db.select().from(pushDelivery)).toHaveLength(0);
    expect(await db.select().from(pushSubscription)).toHaveLength(0);
  },
);

it.each(["blocked", "read", "deleted"] as const)(
  "rechecks %s notifications at delivery time",
  async (state) => {
    const { viewer, context } = await subscribedUser();
    const actor = await createTestUser();
    await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
    if (state === "blocked")
      await db.insert(userBlock).values({ blockerId: viewer.id, blockedId: actor.id });
    if (state === "read") await call(appRouter.notification.markRead, {}, { context });
    if (state === "deleted") await call(appRouter.notification.clearAll, {}, { context });
    const delivered: string[] = [];
    await deliverPushNotifications(db, {
      publicKey,
      send: (endpoint) => {
        delivered.push(endpoint);
        return Promise.resolve("sent" as const);
      },
    });
    expect(delivered).toEqual([]);
    expect(await db.select().from(pushDelivery)).toHaveLength(0);
  },
);

it("retries transient failures durably and retires expired endpoints", async () => {
  const { viewer, endpoint } = await subscribedUser();
  const actor = await createTestUser();
  await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
  const failedSender: PushSender = { publicKey, send: () => Promise.resolve("retry") };
  await deliverPushNotifications(db, failedSender);
  const [pending] = await db.select().from(pushDelivery);
  expect(pending.attempts).toBe(1);
  expect(pending.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  const delivered: string[] = [];
  const sender: PushSender = {
    publicKey,
    send: (target) => {
      delivered.push(target);
      return Promise.resolve("sent" as const);
    },
  };
  await deliverPushNotifications(db, sender);
  expect(delivered).toEqual([]);
  await db.update(pushDelivery).set({ nextAttemptAt: new Date(0) });
  await Promise.all([deliverPushNotifications(db, sender), deliverPushNotifications(db, sender)]);
  expect(delivered).toEqual([endpoint]);
  expect(await db.select().from(pushDelivery)).toHaveLength(0);
  await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
  await deliverPushNotifications(db, { publicKey, send: () => Promise.resolve("gone") });
  expect(await db.select().from(pushSubscription)).toHaveLength(0);
});

it("bounds retry exhaustion and drops stale notifications", async () => {
  const { viewer } = await subscribedUser();
  const actor = await createTestUser();
  await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
  await db.update(pushDelivery).set({ attempts: 5 });
  await deliverPushNotifications(db, { publicKey, send: () => Promise.resolve("retry") });
  expect(await db.select().from(pushDelivery)).toHaveLength(0);
  await notificationInsert(db, { recipientId: viewer.id, actorId: actor.id, type: "follow" });
  await db.update(notification).set({ createdAt: sql`0` });
  const result = await deliverPushNotifications(db, {
    publicKey,
    send: () => Promise.resolve("sent"),
  });
  expect(result.sent).toBe(0);
  expect(await db.select().from(pushDelivery)).toHaveLength(0);
});

it("reports unavailable push when the environment has no signing key configured", async () => {
  const viewer = await createTestUser();
  expect(await call(appRouter.push.status, {}, { context: contextFor(viewer) })).toEqual({
    publicKey: null,
    endpoint: null,
  });
});
