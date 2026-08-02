import { sql } from "drizzle-orm";
import { assertTestDatabase, resolveTestDatabaseUrl } from "@my-tuums/db/testing";

/**
 * Runs once per `playwright test` invocation, before any test — including
 * the `setup` project that signs up alice/bob — executes. (It runs *after*
 * the `webServer` processes in playwright.config.ts have already been
 * started and are pointed at the test database via `stackEnv`; Playwright
 * starts webServer as a "plugin" ahead of globalSetup. That ordering is
 * harmless here: nothing has made a request yet, so emptying the tables a
 * moment after the servers come up is indistinguishable from emptying them
 * a moment before.)
 *
 * `@my-tuums/db` reads `DATABASE_URL` at module scope and throws if it's
 * unset (packages/db/src/index.ts). The `e2e` script runs under
 * `dotenv -e ../.env`, so by the time this file starts, `DATABASE_URL`
 * already holds the *dev* database's connection string — this process never
 * saw the test-only override that playwright.config.ts computes for the
 * child server processes. The dynamic `import()` below is what makes the
 * fix work: the assignment has to land before `@my-tuums/db` is evaluated,
 * and a static top-of-file `import` is hoisted above every other statement
 * in this module, so it would run — and throw against the wrong database —
 * before a plain assignment ever got a chance to.
 */
export default async function globalSetup(): Promise<void> {
  process.env.DATABASE_URL = resolveTestDatabaseUrl();

  // The guard that stands between this file and the dev database: refuses to
  // proceed unless the database name it just computed ends in `_test`.
  assertTestDatabase();

  const [{ db, closeDb }, schema] = await Promise.all([
    import("@my-tuums/db"),
    import("@my-tuums/db/schema"),
  ]);

  try {
    // A single TRUNCATE ... CASCADE rather than per-table deletes in
    // dependency order: cheaper, atomic, and it can't drift out of sync with
    // the schema's FK graph the way a hand-maintained delete order can. CASCADE
    // is a formality here (every FK in the schema is already ON DELETE
    // CASCADE) but makes the statement correct even if that ever changes.
    await db.execute(sql`
      truncate table
        ${schema.postLike}, ${schema.follow}, ${schema.post},
        ${schema.session}, ${schema.account}, ${schema.verification},
        ${schema.rateLimit}, ${schema.user}
      cascade
    `);
  } finally {
    await closeDb();
  }
}
