import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./index.js";
import { user, userBadge } from "./schema/index.js";

// Keep this badge ID aligned with the schema and packages/api's badge catalog.
const FOUNDER_BADGE = "founder";
const FOUNDER_GRANT_LIMIT = 3;

/** Expected refusals are safe for an operator; database errors are not. */
export class FounderGrantError extends Error {}

/** Grant out of band, once per account, while at most three accounts hold the badge. */
export async function grantFounderBadge(db: Database, username: string): Promise<string> {
  // The lookup and guarded insertion share a D1 batch. Concurrent invocations
  // cannot observe the same free slot and both consume it; no interactive lock
  // or PostgreSQL connection is required. The PK also refuses duplicate grants.
  const [targets, granted] = await db.batch([
    db
      .select({ id: user.id, name: user.name, badge: userBadge.badge })
      .from(user)
      .leftJoin(userBadge, and(eq(userBadge.userId, user.id), eq(userBadge.badge, FOUNDER_BADGE)))
      .where(eq(user.username, username)),
    db
      .insert(userBadge)
      .select(
        sql`
      select id, ${FOUNDER_BADGE}, cast(unixepoch('subsec') * 1000 as integer)
      from "user" where username = ${username}
        and (select count(*) from user_badge where badge = ${FOUNDER_BADGE}) < ${FOUNDER_GRANT_LIMIT}
      `,
      )
      .onConflictDoNothing()
      .returning({ userId: userBadge.userId }),
  ]);
  const target = targets[0];
  if (!target) throw new FounderGrantError(`No user with username "${username}".`);
  if (target.badge !== null)
    throw new FounderGrantError(
      `"${username}" already carries the Founder badge — it is granted exactly once per account.`,
    );
  if (!granted.length)
    throw new FounderGrantError(
      `All ${FOUNDER_GRANT_LIMIT} Founder grants are spent — the badge exists on at most three accounts.`,
    );
  return `${username}${target.name ? ` (${target.name})` : ""} is a Founder`;
}
