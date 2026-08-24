import { eq } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, user } from "@my-tuums/db/schema";

/** The target row a moderation state transition governs. */
export type ModerationTarget = {
  targetType: "post" | "user";
  targetId: string;
};

/**
 * Locks one moderation target for the surrounding transaction.
 *
 * Every workflow that scans moderation actions and then changes this target
 * takes this row lock first. That makes the scan and the state transition one
 * serialization point: a concurrent action cannot be inserted between them
 * and escape the supersession update.
 *
 * A missing target is deliberately not an error here. The caller's existing
 * target-specific guard remains the source of its public NOT_FOUND response;
 * this helper only establishes ordering when a row exists.
 */
export async function lockModerationTarget(
  executor: Pick<Database, "select">,
  target: ModerationTarget,
): Promise<void> {
  if (target.targetType === "post") {
    await executor
      .select({ id: post.id })
      .from(post)
      .where(eq(post.id, target.targetId))
      .for("update")
      .limit(1);
    return;
  }

  await executor
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, target.targetId))
    .for("update")
    .limit(1);
}
