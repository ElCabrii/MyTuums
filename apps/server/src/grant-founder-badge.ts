/**
 * Grants the Founder badge to one of the three founder accounts, then exits —
 * the production equivalent of `pnpm db:grant:founder` (issue #308).
 *
 * Run from the Railway console against the production database:
 *
 *   node apps/server/dist/grant-founder-badge.js <username>
 *
 * `DATABASE_URL` is already in the process environment in Railway, so there
 * is no `dotenv` wrapper here — and there must not be one: the runner image
 * installs only production dependencies, so `dotenv-cli` and `tsx` do not
 * exist in the container (issue #147). This entry point is bundled by tsup
 * alongside the server (see tsup.config.ts), which inlines `@my-tuums/db` and
 * its `postgres` dependency, so it needs nothing but `node` and
 * `DATABASE_URL`.
 *
 * The actual work is `grantFounderBadge` in
 * `@my-tuums/db/grant-founder-badge` — the same function the local script
 * calls, so the two paths cannot drift apart. It refuses an account that
 * already carries the badge and refuses once three accounts do: one badge,
 * three accounts, ever.
 */
import { grantFounderBadge } from "@my-tuums/db/grant-founder-badge";

const [username] = process.argv.slice(2);

if (!username) {
  console.error("Usage: node apps/server/dist/grant-founder-badge.js <username>");
  process.exitCode = 1;
} else {
  try {
    const message = await grantFounderBadge(username);
    console.log(`✓ ${message}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
