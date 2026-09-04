/**
 * Join-badge stamping for a newly created account (issue #308).
 *
 * Join badges are the one badge family with no in-app event: an account's
 * creation rank is fixed the moment the account exists, and nothing that
 * happens later can change it. So the stamp rides account creation itself —
 * `packages/auth`'s `databaseHooks.user.create.after` hook calls this for
 * every sign-up path (email/password and OAuth alike), and migration 0028
 * backfilled the accounts that predate the hook. There is deliberately no
 * flag and no removal date: once 1,000 accounts exist, the count stops at
 * its cap, finds a rank that earns nothing, and does no further work on
 * every sign-up after that — cheaper than any machinery to switch it off.
 *
 * Lives in `packages/db` for the same reason ./grant-founder-badge.ts does:
 * this package owns the `user`/`user_badge` tables, and `packages/auth`
 * cannot import the badge catalog from `@my-tuums/api` (the dependency
 * points the other way). The rank thresholds and badge ids below are the
 * join family's half of `packages/api/src/badges.ts`'s catalog, duplicated
 * here the same way the `user_badge.badge` check constraint repeats the id
 * list — keep the copies in step.
 */
import { ne, sql } from "drizzle-orm";
import { db } from "./index.js";
import { user, userBadge } from "./schema/index.js";

/** Among the first 50 accounts: `super_early_access`. */
const SUPER_EARLY_ACCESS_RANK = 50;
/** Among the first 1,000 accounts: `early_access`. */
const EARLY_ACCESS_RANK = 1_000;

const SUPER_EARLY_ACCESS_BADGE = "super_early_access";
const EARLY_ACCESS_BADGE = "early_access";

/**
 * Stamps the join badge `userId`'s creation rank earns, if any.
 *
 * The rank is how many accounts already existed when this one was created —
 * at creation time every existing row precedes the new one, so no
 * `created_at` comparison is needed, only a count. The count is capped at
 * `EARLY_ACCESS_RANK` rows: any account created once 1,000 exist earns
 * nothing, so counting past 1,000 can never change the verdict, and the
 * cap is what keeps the check O(1) forever instead of growing with the
 * user table.
 *
 * The two join badges are tiers of one family and never combine: the first
 * 50 accounts carry `super_early_access` alone, the 51st through 999th
 * carry `early_access` alone — an account cannot be "super early" and
 * merely "early" at once, the same upgrade-not-stack rule the tiered
 * families stamp through (packages/api/src/badge-stamping.ts).
 *
 * Rides the shared pool (./index.ts), not a private connection like
 * ./grant-founder-badge.ts: it runs inside a request, beside the adapter
 * the auth instance already uses. Two sign-ups racing at a rank boundary
 * can both count the same predecessors and both earn — the same tie
 * tolerance the derived `created_at` comparison had, cosmetic, and bounded
 * by however many sign-ups share one instant.
 */
export async function stampJoinBadges(userId: string): Promise<void> {
  // The hook runs after the account's own row landed, so the count must
  // exclude it: rank is how many accounts were created strictly before
  // this one, and every OTHER existing row was.
  const preceding = db
    .select({ one: sql`1` })
    .from(user)
    .where(ne(user.id, userId))
    .limit(EARLY_ACCESS_RANK)
    .as("preceding");
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(preceding);

  const badge =
    row.count < SUPER_EARLY_ACCESS_RANK
      ? SUPER_EARLY_ACCESS_BADGE
      : row.count < EARLY_ACCESS_RANK
        ? EARLY_ACCESS_BADGE
        : null;
  if (badge === null) return;

  await db.insert(userBadge).values({ userId, badge }).onConflictDoNothing();
}
