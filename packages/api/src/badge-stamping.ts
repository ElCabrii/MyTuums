/**
 * The single mint point for tiered badge stamps (issue #308): like tiers in
 * ./posts.ts and follower tiers in ./users.ts both write through here, so
 * the upgrade rule cannot drift between the two families.
 *
 * Tiered badges upgrade, they never combine: an account holds at most one
 * row per family, the highest tier it has earned. Crossing a higher
 * threshold replaces the family's lower tier — "noticed" becomes "trendy",
 * it does not stack beside it — and `earned_at` records the moment the
 * displayed tier was crossed, because that is when it was earned. A tier
 * re-crossed after a recede keeps its original stamp: the insert conflicts
 * on the (user, badge) primary key and nothing is deleted. A receded count
 * that later crosses a LOWER tier stamps nothing — the family's higher tier
 * was already earned, and an earned badge is never withdrawn, so there is
 * nothing below it to say. (Two upgrades racing can still leave a
 * superseded row beside its replacement; the display set takes the
 * family's highest stamped tier regardless — ./badges.ts.)
 *
 * Called inside the transaction that writes the cause (the like, the
 * follow), the same contract {@link insertNotification} in ./notifications.ts
 * has — so a rollback leaves neither the cause nor the badge.
 */
import type { Database } from "@my-tuums/db";
import { userBadge } from "@my-tuums/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { BadgeId, BadgeTier } from "./badges.js";

/**
 * Stamps `earned` for `userId`, deleting the same family's lower tiers so
 * the row upgrades rather than accumulates — unless a higher tier is
 * already stamped, in which case there is nothing to do. `tiers` is the
 * family's ascending list; `earned` is always the highest tier the
 * measured count reached, so every member after it is strictly above it
 * and every member before it strictly below.
 */
export async function stampBadgeTier(
  db: Pick<Database, "select" | "insert" | "delete">,
  userId: string,
  tiers: readonly BadgeTier[],
  earned: BadgeId,
): Promise<void> {
  const earnedIndex = tiers.findIndex((tier) => tier.id === earned);
  const higher = tiers.slice(earnedIndex + 1).map((tier) => tier.id);
  const superseded = tiers.slice(0, earnedIndex).map((tier) => tier.id);

  if (higher.length > 0) {
    const [held] = await db
      .select({ badge: userBadge.badge })
      .from(userBadge)
      .where(and(eq(userBadge.userId, userId), inArray(userBadge.badge, higher)))
      .limit(1);
    if (held) return;
  }

  if (superseded.length > 0) {
    await db
      .delete(userBadge)
      .where(and(eq(userBadge.userId, userId), inArray(userBadge.badge, superseded)));
  }

  await db.insert(userBadge).values({ userId, badge: earned }).onConflictDoNothing();
}
