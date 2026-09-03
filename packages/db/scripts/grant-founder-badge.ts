/**
 * Grants the Founder badge — the one manually-granted badge, on exactly one
 * account (issue #308).
 *
 * There is deliberately no in-app surface for this: the Founder badge is
 * granted out of band, once per deployment, in the same spirit as the first
 * admin promotion (`pnpm db:promote`, issue #38). This is the local wrapper;
 * production runs `node apps/server/dist/grant-founder-badge.js <username>`
 * from the Railway console (see apps/server/src/grant-founder-badge.ts).
 *
 * Usage: pnpm db:grant:founder <username>
 *
 * A thin wrapper over `grantFounderBadge` in `@my-tuums/db/grant-founder-badge`,
 * which owns the actual work and the one-account guard, so the local flow and
 * the production entry point cannot drift apart.
 */
import { grantFounderBadge } from "../src/grant-founder-badge.ts";

const [username] = process.argv.slice(2);

if (!username) {
  console.error("Usage: pnpm db:grant:founder <username>");
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
