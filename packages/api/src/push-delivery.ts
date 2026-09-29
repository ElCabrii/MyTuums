import type { Database } from "@my-tuums/db";
import {
  notification,
  notificationLastSeen,
  post,
  pushDelivery,
  pushSubscription,
  session,
  user,
} from "@my-tuums/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { visibleNotification } from "./notification-visibility.js";
import type { PushSender } from "./web-push.js";

const now = sql`cast(unixepoch('subsec') * 1000 as integer)`;

/** Bounded, leased delivery. A crash after provider acceptance may repeat a generic alert. */
export async function deliverPushNotifications(db: Database, sender: PushSender) {
  // Expired sessions may remain stored; stop their subscriptions even before auth prunes them.
  await db.delete(pushSubscription).where(sql`${pushSubscription.id} in (
    select s.id from push_subscription s join session on session.id = s.session_id
    where session.expires_at <= ${now} limit 100
  )`);
  const due = await db
    .select({ delivery: pushDelivery, userId: pushSubscription.userId })
    .from(pushDelivery)
    .innerJoin(pushSubscription, eq(pushSubscription.id, pushDelivery.subscriptionId))
    .where(sql`${pushDelivery.nextAttemptAt} <= ${now}`)
    .orderBy(pushDelivery.nextAttemptAt)
    .limit(25);
  let sent = 0;
  for (const { delivery, userId } of due) {
    const identity = and(
      eq(pushDelivery.subscriptionId, delivery.subscriptionId),
      eq(pushDelivery.notificationId, delivery.notificationId),
    );
    const lease = crypto.randomUUID();
    const [claimed] = await db
      .update(pushDelivery)
      .set({
        lease,
        attempts: sql`${pushDelivery.attempts} + 1`,
        nextAttemptAt: sql`${now} + 60000`,
      })
      .where(and(identity, sql`${pushDelivery.nextAttemptAt} <= ${now}`))
      .returning();
    if (!claimed) continue;
    const owned = and(identity, eq(pushDelivery.lease, lease));
    const recipient = alias(user, "push_recipient");
    const [target] = await db
      .select({ endpoint: pushSubscription.endpoint, key: pushSubscription.applicationServerKey })
      .from(pushSubscription)
      .innerJoin(session, eq(session.id, pushSubscription.sessionId))
      .innerJoin(recipient, eq(recipient.id, pushSubscription.userId))
      .innerJoin(
        notification,
        and(
          eq(notification.id, delivery.notificationId),
          eq(notification.recipientId, pushSubscription.userId),
        ),
      )
      .leftJoin(user, eq(user.id, notification.actorId))
      .leftJoin(post, eq(post.id, notification.postId))
      .leftJoin(notificationLastSeen, eq(notificationLastSeen.recipientId, pushSubscription.userId))
      .where(
        and(
          eq(pushSubscription.id, delivery.subscriptionId),
          sql`${session.expiresAt} > ${now}`,
          sql`(${recipient.banned} is not true or (${recipient.banExpires} is not null and ${recipient.banExpires} <= ${now}))`,
          sql`${notification.createdAt} > ${now} - 86400000`,
          sql`(${notificationLastSeen.seenAt} is null or ${notification.createdAt} > ${notificationLastSeen.seenAt})`,
          visibleNotification(userId),
        ),
      );
    if (!target || target.key !== sender.publicKey) {
      await db.delete(pushDelivery).where(owned);
      continue;
    }
    let result: "sent" | "gone" | "retry";
    try {
      result = await sender.send(target.endpoint);
    } catch {
      result = "retry";
    }
    if (result === "gone") {
      await db.delete(pushSubscription).where(eq(pushSubscription.id, delivery.subscriptionId));
    } else if (result === "sent" || claimed.attempts >= 6) {
      await db.delete(pushDelivery).where(owned);
      if (result === "sent") sent += 1;
    } else {
      const delay = Math.min(3600000, 60000 * 2 ** claimed.attempts);
      await db
        .update(pushDelivery)
        .set({ lease: null, nextAttemptAt: sql`${now} + ${delay}` })
        .where(owned);
    }
  }
  return { processed: due.length, sent };
}
