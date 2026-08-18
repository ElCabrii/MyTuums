/**
 * Promoting a user to a moderation role, as a library function.
 *
 * This is the bootstrap path of the moderation system (issue #38): the first
 * moderators must be appointed before anyone can moderate, and better-auth's
 * own admin endpoints are unreachable (404'd in apps/server/src/request-handler.ts).
 * So the first promotion happens from the command line against the database,
 * once per deployment; everything after that goes through the /rpc procedures
 * (`moderation.setRole`), which enforce the hierarchy and write the audit log.
 *
 * Lives in `packages/db` rather than in `apps/server` because this package is
 * the one that owns `postgres` (its production dependency) and the `user`
 * table. `apps/server` does not declare `postgres` at all, so importing it
 * there only appears to work through hoisting — under pnpm's strict layout it
 * does not resolve. The same reasoning that keeps `runMigrations` here
 * (see ./migrate.ts).
 *
 * Uses `postgres` directly (a single connection, `max: 1`) rather than the
 * process-wide pool in ./index.ts: a promote script is a one-shot process, and
 * importing the root subpath would evaluate the module-scope `DATABASE_URL`
 * check and spin up a 10-connection pool for a single UPDATE. `DATABASE_URL`
 * is read from the environment here, exactly as the pool does.
 */
import postgres from "postgres";

// The promotable roles are `USER_ROLES` minus `user` from
// packages/api/src/roles.ts, duplicated here because this package cannot
// import from @my-tuums/api (the dependency would point the wrong way).
// Keep in step with that file.
const PROMOTABLE_ROLES = ["moderator", "staff", "admin"];

interface UserRow {
  id: string;
  username: string;
  name: string;
}

/**
 * Promotes the user with `username` to `role`, returning a human-readable
 * confirmation. Throws when the role is unknown, `DATABASE_URL` is unset, or
 * no user matches the username — the caller decides how to surface each.
 */
export async function promoteUser(username: string, role: string): Promise<string> {
  if (!PROMOTABLE_ROLES.includes(role)) {
    throw new Error(`Unknown role "${role}" — expected one of ${PROMOTABLE_ROLES.join(", ")}.`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — copy .env.example → .env first.");
  }

  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    // The username is a parameterised value, never spliced into SQL.
    const [target] = await sql<UserRow[]>`
      select id, username, name from "user" where username = ${username}
    `;

    if (!target) {
      throw new Error(`No user with username "${username}".`);
    }

    await sql`update "user" set role = ${role} where id = ${target.id}`;
    return `${target.username}${target.name ? ` (${target.name})` : ""} is now ${role}`;
  } finally {
    await sql.end();
  }
}
