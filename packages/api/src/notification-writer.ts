import type { Database } from "@my-tuums/db";
import { notification } from "@my-tuums/db/schema";
import { sql, type SQL } from "drizzle-orm";

export type NotificationType = typeof notification.$inferSelect.type;

/** Build the notification alongside its cause in the same atomic batch. */
export function notificationInsert(
  db: Pick<Database, "insert">,
  args: {
    recipientId: string | SQL<string>;
    actorId: string | null;
    type: NotificationType;
    postId?: string;
    actionId?: string;
    videoId?: string;
  },
  when: SQL = sql`true`,
) {
  if (args.actorId !== null && args.actorId === args.recipientId) return;
  // INSERT SELECT follows the notification schema's column order, including
  // nullable slots. Its predicate participates in the cause's atomic batch.
  return db
    .insert(notification)
    .select(
      sql`select ${crypto.randomUUID()}, ${args.recipientId}, ${args.actorId},
      ${args.type}, ${args.postId ?? null}, ${args.actionId ?? null}, ${args.videoId ?? null},
      cast(unixepoch('subsec') * 1000 as integer)
      where ${when} and (${args.actorId} is null or ${args.actorId} <> ${args.recipientId})`,
    )
    .onConflictDoNothing({ target: notification.videoId });
}

export async function insertNotification(
  db: Pick<Database, "insert">,
  args: Parameters<typeof notificationInsert>[1],
): Promise<void> {
  await notificationInsert(db, args);
}
