import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMigrations } from "../src/migrate.js";
import { openPocDatabase } from "./poc-database.js";

async function run() {
  const { values } = parseArgs({ options: { remote: { type: "boolean", default: false } } });
  const database = await openPocDatabase(values.remote);
  try {
    console.log(
      `Applying committed D1 migrations to mytuums-poc (${values.remote ? "remote" : "local"}).`,
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
    "D1 migration failed. Usage: pnpm --filter @my-tuums/db db:migrate [--remote]. Check Wrangler authentication, the PoC configuration and migration state before retrying.",
  );
  process.exitCode = 1;
}
