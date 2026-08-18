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
 * A thin wrapper over `promoteUser` in `@my-tuums/db/promote`, which owns the
 * actual work. This script only parses argv and maps the library's errors to
 * exit codes, so the local `pnpm db:promote` flow and the production
 * `node apps/server/dist/promote.js` entry point (see apps/server/src/promote.ts)
 * cannot drift apart.
 */
import { promoteUser } from "../src/promote.ts";

const [username, role] = process.argv.slice(2);

if (!username || !role) {
  console.error("Usage: pnpm db:promote <username> <role>");
  process.exit(1);
}

promoteUser(username, role)
  .then((message) => {
    console.log(`✓ ${message}`);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
