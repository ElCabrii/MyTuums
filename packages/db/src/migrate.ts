/**
 * Applying the generated migrations, as a library function.
 *
 * Lives in `packages/db` rather than in `apps/server` because this package is
 * the one that owns both halves: `drizzle-orm` is its dependency, and the SQL
 * in `packages/db/drizzle` is its output. `apps/server` does not declare
 * `drizzle-orm` at all, so importing the migrator there only appears to work
 * through hoisting — under pnpm's strict layout it does not resolve.
 *
 * `drizzle-orm`'s migrator, not `drizzle-kit`: the two apply the same files and
 * share the same `drizzle.__drizzle_migrations` bookkeeping, but drizzle-kit is
 * a dev dependency and shipping it (plus its tree) in a runtime image to spend
 * a few seconds per deploy is a poor trade.
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./index.js";

/**
 * Applies every migration the target database has not recorded yet.
 *
 * Idempotent: already-applied migrations are skipped by hash, so running it on
 * a deploy that changed no schema is a no-op.
 *
 * `migrationsFolder` is passed in rather than resolved from this module's own
 * location on purpose — the server bundles this file with tsup, so at runtime
 * `import.meta.url` points at `apps/server/dist`, nowhere near the SQL.
 */
export async function runMigrations(migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
