/**
 * Test-database resolution, shared by the Vitest configs in `packages/api`
 * and `apps/server` and by the Playwright setup in `e2e`.
 *
 * Deliberately its own module rather than part of the package root: importing
 * `@my-tuums/db` evaluates `DATABASE_URL` at module scope and throws when it
 * is unset. A Vitest config has to *compute* the connection string before the
 * worker imports the database, so it needs a way in that doesn't drag the
 * client along with it. Nothing here connects to anything.
 */

/**
 * Swaps the database name in a Postgres connection string.
 *
 * Parsed with `URL` rather than a regex: a password containing `/` or `@` —
 * which `openssl rand -base64` produces routinely — breaks naive splitting,
 * and the failure mode is a connection string that silently points somewhere
 * else rather than an error.
 */
function withDatabaseName(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The database name a connection string points at, or `""` for none. */
export function databaseNameOf(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

/**
 * Where the test suites connect.
 *
 * `DATABASE_URL_TEST` wins when set. Otherwise it is *derived* from
 * `DATABASE_URL` by suffixing the database name with `_test` — so a fresh
 * clone runs the suite with no extra environment variable, and the derived
 * value can never accidentally be the dev database because the suffix is
 * unconditional.
 */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DATABASE_URL_TEST;
  if (explicit) return explicit;

  const base = env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Set DATABASE_URL (or DATABASE_URL_TEST) before running the database-backed tests. " +
        "See .env.example.",
    );
  }

  return withDatabaseName(base, `${databaseNameOf(base)}_test`);
}

/** The maintenance connection used to `CREATE DATABASE` the test database. */
export function maintenanceUrlFor(connectionString: string): string {
  return withDatabaseName(connectionString, "postgres");
}

/**
 * The guard that stands between a `TRUNCATE` and the dev database.
 *
 * `packages/db/src/index.ts` reads `DATABASE_URL` once at module load and
 * hands out a process-wide singleton, so by the time a test helper holds a
 * `db` there is nothing left to inspect but the environment that produced it.
 * Every destructive helper calls this first; a mis-set variable then fails
 * loudly instead of emptying someone's development data.
 */
export function assertTestDatabase(env: NodeJS.ProcessEnv = process.env): void {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("Refusing to run a destructive test helper: DATABASE_URL is not set.");
  }

  const name = databaseNameOf(url);
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run a destructive test helper against the "${name}" database — ` +
        "the test database name must end in `_test`. Check DATABASE_URL_TEST.",
    );
  }
}
