/**
 * Creates the test database and brings it up to the current migration.
 *
 * Everything happens inside one Node process on purpose. The obvious shell
 * spelling — `DATABASE_URL=$DATABASE_URL_TEST drizzle-kit migrate` — is a
 * bash-ism that PowerShell parses as a command name, and this repo's scripts
 * have to run on Windows. Passing the override through `execFileSync`'s `env`
 * is the portable equivalent.
 *
 * Migrations rather than `db:push`: `packages/db/drizzle` already holds
 * 0000-0005, and running them is what makes the test schema the same artefact
 * production gets rather than a parallel one drizzle-kit inferred.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { databaseNameOf, maintenanceUrlFor, resolveTestDatabaseUrl } from "../src/testing.ts";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const testUrl = resolveTestDatabaseUrl();
const testDbName = databaseNameOf(testUrl);

if (!testDbName.endsWith("_test")) {
  console.error(
    `Refusing to set up "${testDbName}": the test database name must end in \`_test\`.\n` +
      "Check DATABASE_URL_TEST in your .env.",
  );
  process.exit(1);
}

// `CREATE DATABASE` cannot run inside a transaction and cannot target the
// database you are connected to, so this goes through the `postgres`
// maintenance database. `max: 1` because we issue exactly one statement.
const admin = postgres(maintenanceUrlFor(testUrl), { max: 1, onnotice: () => {} });

try {
  const [existing] = await admin`
    select 1 from pg_database where datname = ${testDbName}
  `;

  if (existing) {
    console.log(`• database "${testDbName}" already exists`);
  } else {
    // Identifiers can't be parameterised; `testDbName` comes from our own
    // connection string and is suffix-checked above, and `sql()` quotes it.
    await admin`create database ${admin(testDbName)}`;
    console.log(`✓ created database "${testDbName}"`);
  }
} finally {
  await admin.end();
}

console.log(`• migrating "${testDbName}"…`);

execFileSync("npx", ["drizzle-kit", "migrate"], {
  cwd: packageRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DATABASE_URL: testUrl },
});

console.log(`✓ "${testDbName}" is ready`);
