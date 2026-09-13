/**
 * Apply the committed D1 migrations through the explicit target binding.
 * Local tests and hosted deployment commands share Drizzle's migration ledger.
 */
import { migrate } from "drizzle-orm/d1/migrator";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "./index.js";

/**
 * Applies every migration the target database has not recorded yet.
 *
 * Idempotent: already-applied migrations are skipped by journal timestamp, so running it on
 * a deploy that changed no schema is a no-op.
 *
 * `migrationsFolder` is passed in rather than resolved from this module's own
 * location so the caller owns the deployment artifact's SQL path.
 */
export async function runMigrations(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(drizzle(db.$client), { migrationsFolder });
}
