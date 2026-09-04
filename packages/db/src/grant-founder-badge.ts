/**
 * Granting the Founder badge, as a library function (issue #308).
 *
 * The Founder badge is one manually-granted badge on the three founder
 * accounts — Gabriel, Nicolas and Thomas. There is deliberately no API and
 * no UI for it: like the first admin promotion (see ./promote.ts), the
 * grants happen out of band, from the command line against the database,
 * and the mechanism is committed so the deployment story is reproducible.
 * Once per account, three accounts; there is nothing after that.
 *
 * The three-account contract is enforced here, not just documented:
 * `grantFounderBadge` refuses once three accounts carry the founder badge.
 * That is what keeps this a bounded one-off rather than an unrestricted
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

/** How many accounts may ever hold the Founder badge: the three partners. */
const FOUNDER_GRANT_LIMIT = 3;

const FOUNDER_BADGE = "founder";

/**
 * Grants the Founder badge to the user with `username`, returning a
 * human-readable confirmation. Throws when `DATABASE_URL` is unset, no user
 * matches the username, that user already carries the badge, or the three
 * grants are already spent — the caller decides how to surface each.
 */
export async function grantFounderBadge(username: string): Promise<string> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — copy .env.example → .env first.");
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {}, ssl: sslFor(databaseUrl) });

  try {
    // The username is a parameterised value, never spliced into SQL.
    const [target] = await sql<{ id: string; username: string; name: string | null }[]>`
      select id, username, name from "user" where username = ${username}
    `;

    if (!target) {
      throw new Error(`No user with username "${username}".`);
    }

    // Three founders, three grants, ever. Refusing here is what keeps this a
    // bounded committed mechanism rather than a silent, unaudited way to
    // hand out a "Founder" distinction on any database it runs against.
    // (The count-then-insert is not atomic against two simultaneous runs —
    // acceptable for a manual one-off script no one runs twice in parallel.)
    const holders = await sql<{ user_id: string }[]>`
      select user_id from "user_badge" where badge = ${FOUNDER_BADGE}
    `;
    if (holders.some((row) => row.user_id === target.id)) {
      throw new Error(
        `"${username}" already carries the Founder badge — it is granted exactly once per account.`,
      );
    }
    if (holders.length >= FOUNDER_GRANT_LIMIT) {
      throw new Error(
        `All ${FOUNDER_GRANT_LIMIT} Founder grants are spent — the badge exists on exactly three accounts and is never extended.`,
      );
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

    return `${target.username}${target.name ? ` (${target.name})` : ""} is a Founder`;
  } finally {
    await sql.end();
  }
}
