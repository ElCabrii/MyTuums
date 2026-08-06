/**
 * Promotes a user to a moderation role — the bootstrap path of the
 * moderation system (issue #38).
 *
 * There is deliberately no in-app "appoint a moderator" procedure: the very
 * first moderators must be appointed before anyone can moderate, and
 * better-auth's own admin endpoints are unreachable (404'd in
 * apps/server/src/request-handler.ts, because they gate on membership in a
 * flat `adminRoles` list, not on the app's staff-vs-admin hierarchy). So the
 * first promotion happens from the command line against the database, once
 * per deployment; everything after that goes through the /rpc procedures
 * (`moderation.setRole`), which enforce the hierarchy and write the audit
 * log.
 *
 * Usage: pnpm db:promote <username> <role>   (role: moderator | staff | admin)
 *
 * Mirrors setup-test-db.mjs's shape: one process, `postgres` directly (a
 * promote script must not pull in the connection pool), and `DATABASE_URL`
 * from the environment, which the `dotenv` wrapper in package.json loads
 * from the root .env.
 */
import postgres from "postgres";

// The promotable roles are `USER_ROLES` minus `user` from
// packages/api/src/roles.ts, duplicated here because this package cannot
// import from @my-tuums/api (the dependency would point the wrong way).
// Keep in step with that file.
const PROMOTABLE_ROLES = ["moderator", "staff", "admin"];

const [username, role] = process.argv.slice(2);

if (!username || !role) {
  console.error("Usage: pnpm db:promote <username> <role>");
  process.exit(1);
}

if (!PROMOTABLE_ROLES.includes(role)) {
  console.error(`Unknown role "${role}" — expected one of ${PROMOTABLE_ROLES.join(", ")}.`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set — copy .env.example → .env first.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  // The username is a parameterised value, never spliced into SQL.
  const [target] = await sql`
    select id, username, name from "user" where username = ${username}
  `;

  if (!target) {
    console.error(`No user with username "${username}".`);
    process.exit(1);
  }

  await sql`update "user" set role = ${role} where id = ${target.id}`;
  console.log(`✓ ${target.username}${target.name ? ` (${target.name})` : ""} is now ${role}`);
} finally {
  await sql.end();
}
