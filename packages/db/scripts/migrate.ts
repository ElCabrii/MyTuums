import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runMigrations } from "../src/migrate.js";
import { openPocDatabase, openPreviewDatabase, openProductionDatabase } from "./poc-database.js";

async function run() {
  const { values } = parseArgs({
    options: {
      remote: { type: "boolean", default: false },
      environment: { type: "string", default: "poc" },
    },
  });
  if (
    values.environment !== "poc" &&
    values.environment !== "preview" &&
    values.environment !== "production"
  )
    throw new Error("Unknown migration environment.");
  const open =
    values.environment === "production"
      ? openProductionDatabase
      : values.environment === "preview"
        ? openPreviewDatabase
        : openPocDatabase;
  const database = await open(values.remote);
  try {
    console.log(
      `Applying committed D1 migrations to mytuums-${values.environment} (${values.remote ? "remote" : "local"}).`,
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
    "D1 migration failed. Usage: pnpm --filter @my-tuums/db db:migrate [--remote] [--environment=poc|preview|production]. Check Wrangler authentication, the selected configuration and migration state before retrying.",
  );
  process.exitCode = 1;
}
