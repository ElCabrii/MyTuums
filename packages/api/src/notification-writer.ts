import type { Database } from "@my-tuums/db";
import { notification } from "@my-tuums/db/schema";

export type NotificationType = typeof notification.$inferSelect.type;

/** The single mint point, called inside the cause's database transaction. */
export async function insertNotification(
  db: Pick<Database, "insert">,
  args: {
    recipientId: string;
    actorId: string | null;
    type: NotificationType;
    postId?: string;
    actionId?: string;
    videoId?: string;
  },
): Promise<void> {
  if (args.actorId !== null && args.actorId === args.recipientId) return;
  await db
    .insert(notification)
    .values({
      recipientId: args.recipientId,
      actorId: args.actorId,
      type: args.type,
      postId: args.postId ?? null,
      actionId: args.actionId ?? null,
      videoId: args.videoId ?? null,
    })
    .onConflictDoNothing({ target: notification.videoId });
}
