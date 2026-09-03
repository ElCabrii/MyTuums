/**
 * Granting the Founder badge, as a library function (issue #308).
 *
 * The Founder badge is one manually-granted badge on exactly one account —
 * Gabriel's. There is deliberately no API and no UI for it: like the first
 * admin promotion (see ./promote.ts), the grant happens out of band, from the
 * command line against the database, and the mechanism is committed so the
 * deployment story is reproducible. Once per deployment; there is nothing
 * after that.
 *
 * The one-account contract is enforced here, not just documented:
 * `grantFounderBadge` refuses to run once ANY account carries the founder
 * badge. That is what keeps this a one-off rather than an unrestricted
 * production badge setter no audit log watches. The composite
 * `(user_id, badge)` primary key backs it up with `on conflict do nothing`.
 *
 * Lives in `packages/db` for the same reason ./promote.ts does: this package
 * owns `postgres` (its production dependency) and the `user`/`user_badge`
 * tables, and `apps/server` does not declare `postgres` at all. Uses a single
 * `max: 1` connection rather than the process-wide pool, reads `DATABASE_URL`
 * from the environment, and applies the same TLS policy as the pool
 * (see ./connection.ts).
 */
import postgres from "postgres";
import { sslFor } from "./connection.js";

// "founder" is BADGE_IDS's member from packages/api/src/badges.ts,
// duplicated here because this package cannot import from @my-tuums/api (the
// dependency would point the wrong way). The user_badge check constraint
// carries the same list. Keep the three in step.
const FOUNDER_BADGE = "founder";

/**
 * Grants the Founder badge to the user with `username`, returning a
 * human-readable confirmation. Throws when `DATABASE_URL` is unset, no user
 * matches the username, or the badge has already been granted to any account
 * (including that one) — the caller decides how to surface each.
 */
export async function grantFounderBadge(username: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — copy .env.example → .env first.");
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {}, ssl: sslFor(databaseUrl) });

  try {
    // One badge, one account, ever. Refusing here is what keeps this a
    // one-off committed mechanism rather than a silent, unaudited way to
    // hand out a "Founder" distinction on any database it runs against.
    const [holder] =
      await sql`select user_id from "user_badge" where badge = ${FOUNDER_BADGE} limit 1`;
    if (holder) {
      throw new Error(
        "The Founder badge has already been granted — it exists on exactly one account and is never re-granted.",
      );
    }

    // The username is a parameterised value, never spliced into SQL.
    const [target] = await sql<{ id: string; username: string; name: string | null }[]>`
      select id, username, name from "user" where username = ${username}
    `;

    if (!target) {
      throw new Error(`No user with username "${username}".`);
    }

    const granted = await sql`
      insert into "user_badge" (user_id, badge)
      values (${target.id}, ${FOUNDER_BADGE})
      on conflict do nothing
      returning user_id
    `;

    if (granted.length === 0) {
      throw new Error(
        `"${username}" already carries the Founder badge — it is granted exactly once per account.`,
      );
    }

    return `${target.username}${target.name ? ` (${target.name})` : ""} is the Founder`;
  } finally {
    await sql.end();
  }
}
