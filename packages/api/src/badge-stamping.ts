import type { Database } from "@my-tuums/db";
import { userBadge } from "@my-tuums/db/schema";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { BadgeTier } from "./badges.js";

/**
 * Compose these statements with the event that earns a tier in one D1 batch.
 * Thresholds come from the badge catalog. Inserting the candidate then removing
 * every lower held tier preserves the highest achievement and its original
 * timestamp even after counts recede or another post earns a lower tier.
 */
export function badgeTierStatements(
  db: Database,
  args: { userId: string; tiers: readonly BadgeTier[]; count: SQL<number>; when?: SQL },
) {
  const tiers = JSON.stringify(args.tiers);
  const when = args.when ?? sql`true`;
  return [
    db
      .insert(userBadge)
      .select(
        sql`
      select ${args.userId}, json_extract(tier.value, '$.id'),
        cast(unixepoch('subsec') * 1000 as integer)
      from json_each(${tiers}) as tier
      where ${when} and json_extract(tier.value, '$.threshold') < (${args.count})
      order by json_extract(tier.value, '$.threshold') desc
      limit 1
    `,
      )
      .onConflictDoNothing(),
    db.delete(userBadge).where(
      and(
        eq(userBadge.userId, args.userId),
        when,
        sql`
      ${userBadge.badge} in (
        select json_extract(tier.value, '$.id') from json_each(${tiers}) as tier
        where json_extract(tier.value, '$.threshold') < (
          select max(json_extract(held_tier.value, '$.threshold'))
          from ${userBadge} as held
          join json_each(${tiers}) as held_tier on json_extract(held_tier.value, '$.id') = held.badge
          where held.user_id = ${args.userId}
        )
      )
    `,
      ),
    ),
  ] as const;
}
