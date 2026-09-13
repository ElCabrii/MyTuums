import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMigrations } from "../src/migrate.js";
import {
  openMaintenanceDatabase,
  resolveMaintenanceEnvironment,
} from "./maintenance-environment.js";

async function run() {
  const { values } = parseArgs({
    options: {
      remote: { type: "boolean", default: false },
      environment: { type: "string", default: "local" },
    },
  });
  const remote = values.remote === true;
  const environment = resolveMaintenanceEnvironment(values.environment, remote);
  const database = await openMaintenanceDatabase(environment, remote);
  try {
    console.log(
      `Applying committed D1 migrations to ${environment} (${remote ? "remote" : "local"}).`,
    );
    await runMigrations(database.db, fileURLToPath(new URL("../drizzle-d1", import.meta.url)));
    console.log("D1 migrations up to date.");
  } finally {
    await database.dispose();
  }
}

try {
  await run();
} catch {
  console.error(
    "D1 migration failed. Usage: pnpm --filter @my-tuums/db db:migrate [--remote --environment=preview|production]. Local is the safe default. Check Wrangler authentication, the selected configuration and migration state before retrying.",
  );
  process.exitCode = 1;
}
