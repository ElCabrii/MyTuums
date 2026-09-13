import { parseArgs } from "node:util";
import { FounderGrantError, grantFounderBadge } from "../src/grant-founder-badge.js";
import { PromotionError, promoteUser } from "../src/promote.js";
import {
  maintenanceResourceNames,
  openMaintenanceDatabase,
  resolveMaintenanceEnvironment,
} from "./maintenance-environment.js";

const usage =
  "Usage: pnpm db:promote <username> <moderator|staff|admin> [--remote --environment=preview|production]\n       pnpm db:grant:founder <username> [--remote --environment=preview|production]";

function options() {
  try {
    return parseArgs({
      options: {
        remote: { type: "boolean", default: false },
        environment: { type: "string", default: "local" },
      },
      allowPositionals: true,
    });
  } catch {
    throw new PromotionError(usage);
  }
}

async function run() {
  const args = options();
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
  const environment = resolveMaintenanceEnvironment(args.values.environment, remote);
  console.log(
    `Database: ${maintenanceResourceNames(environment).database} (${remote ? "remote" : "local"})`,
  );
  const database = await openMaintenanceDatabase(environment, remote);
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
      : "Database command failed. Check Wrangler authentication, the selected environment and applied D1 migrations.",
  );
  process.exitCode = 1;
}
