/**
 * Applies pending database migrations, then exits.
 *
 * Run as Railway's **pre-deploy command**, so a deploy that changes the schema
 * migrates before the new version starts taking traffic. Without it, autodeploy
 * from `main` ships code that expects columns the database does not have yet,
 * and the failure surfaces as runtime 500s rather than a failed deploy.
 *
 * The actual work is `runMigrations` in `@my-tuums/db/migrate` — that package
 * owns both `drizzle-orm` and the SQL, and this app declares neither.
 *
 * A separate entry point rather than something `index.ts` does at boot: running
 * migrations on every start means N replicas racing the same DDL, and it
 * couples "the server is up" to "the schema changed". Pre-deploy runs once.
 */
import { closeDb } from "@my-tuums/db";
import { runMigrations } from "@my-tuums/db/migrate";

/**
 * Where the generated SQL lives, relative to the image's working directory
 * (`/app`). The Dockerfile copies `packages/db/drizzle` in for exactly this;
 * overridable so the script stays runnable from a checkout too.
 */
const migrationsFolder = process.env.MIGRATIONS_DIR ?? "packages/db/drizzle";

async function main(): Promise<void> {
  console.log(`Applying migrations from ${migrationsFolder} ...`);
  await runMigrations(migrationsFolder);
  console.log("Migrations up to date.");
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // Exiting non-zero is the point: Railway aborts the deploy, the previous
    // version keeps serving, and nothing ends up running against a schema it
    // does not match.
    console.error("Migration failed:", error);
    void closeDb().finally(() => process.exit(1));
  });
