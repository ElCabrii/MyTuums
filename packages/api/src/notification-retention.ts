import { sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { notification } from "@my-tuums/db/schema";
import { NOTIFICATION_RETENTION_DAYS } from "./constants.js";

const retentionMs = NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const horizon = sql`(cast(unixepoch('subsec') * 1000 as integer) - ${retentionMs})`;

/** The list and badge share the pruning boundary; moderation never expires. */
export function withinNotificationRetention() {
  return sql`(${notification.type} = 'moderation' or ${notification.createdAt} > ${horizon})`;
}

/**
 * One bounded, restartable pruning step. A scheduler repeats while a full
 * batch was removed. Read cursors and moderation audit notices stay intact.
 */
export async function pruneExpiredNotifications(db: Database) {
  const batchSize = 250;
  const deleted = await db
    .delete(notification)
    .where(
      sql`${notification.id} in (
      select ${notification.id} from ${notification}
      where not ${withinNotificationRetention()}
      order by ${notification.createdAt}, ${notification.id}
      limit ${batchSize}
    )`,
    )
    .returning({ id: notification.id });
  return { deletedCount: deleted.length, hasMore: deleted.length === batchSize };
}
