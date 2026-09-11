import { parseArgs } from "node:util";
import { FounderGrantError, grantFounderBadge } from "../src/grant-founder-badge.js";
import { PromotionError, promoteUser } from "../src/promote.js";
import { openPocDatabase } from "./poc-database.js";

const usage =
  "Usage: pnpm db:promote <username> <moderator|staff|admin> [--remote]\n       pnpm db:grant:founder <username> [--remote]";

async function run() {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({
      options: { remote: { type: "boolean", default: false } },
      allowPositionals: true,
    });
  } catch {
    throw new PromotionError(usage);
  }
  const [command, username, role] = args.positionals;
  if (
    !username ||
    !(
      (command === "promote" && args.positionals.length === 3 && role) ||
      (command === "founder" && args.positionals.length === 2)
    )
  )
    throw new PromotionError(usage);

  const remote = args.values.remote === true;
  console.log(`Database: mytuums-poc (${remote ? "remote" : "local"})`);
  const database = await openPocDatabase(remote);
  try {
    const message =
      command === "promote" && role
        ? await promoteUser(database.db, username, role)
        : await grantFounderBadge(database.db, username);
    console.log(`✓ ${message}`);
  } finally {
    await database.dispose();
  }
}

try {
  await run();
} catch (error) {
  console.error(
    error instanceof FounderGrantError || error instanceof PromotionError
      ? error.message
      : "PoC database command failed. Check Wrangler authentication, the PoC configuration and applied D1 migrations.",
  );
  process.exitCode = 1;
}
