/**
 * Promotes a user to a moderation role, then exits — the production
 * equivalent of `pnpm db:promote`.
 *
 * Run from the Railway console against the production database:
 *
 *   node apps/server/dist/promote.js <username> <role>
 *
 * `DATABASE_URL` is already in the process environment in Railway, so there is
 * no `dotenv` wrapper here — and there must not be one: the runner image
 * installs only production dependencies, so `dotenv-cli` and `tsx` do not
 * exist in the container (issue #147). This entry point is bundled by tsup
 * alongside the server (see tsup.config.ts), which inlines `@my-tuums/db` and
 * its `postgres` dependency, so it needs nothing but `node` and `DATABASE_URL`.
 *
 * The actual work is `promoteUser` in `@my-tuums/db/promote` — the same
 * function the local `pnpm db:promote` script calls, so the two paths cannot
 * drift apart.
 */
import { promoteUser } from "@my-tuums/db/promote";

const [username, role] = process.argv.slice(2);

if (!username || !role) {
  console.error("Usage: node apps/server/dist/promote.js <username> <role>");
  process.exit(1);
}

promoteUser(username, role)
  .then((message) => {
    console.log(`✓ ${message}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
