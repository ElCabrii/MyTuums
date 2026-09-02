import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sslFor } from "./connection.js";
import * as schema from "./schema/index.js";

// Read at module scope on purpose: every import of @my-tuums/db shares one
// process-wide client, and importing without DATABASE_URL throws immediately.
// That is also why ./testing.ts is a separate entry point — a Vitest config
// must resolve the test URL *before* this module is ever evaluated.
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Define it in your environment (see .env.example) before starting the process.",
  );
}

// One pool for the whole process (10 connections, 10s connect timeout): the
// API procedures, the migration runner, and the test helpers all go through
// this same client. The TLS rule lives in ./connection.ts so the one-shot
// maintenance scripts apply the same policy.
const client = postgres(connectionString, {
  max: 10,
  connect_timeout: 10,
  ssl: sslFor(connectionString),
});

/**
 * The drizzle database handle over the full schema (app + auth tables).
 * Passing `schema` is what makes relational queries (`with`) type-check.
 */
export const db = drizzle(client, { schema });

/** The concrete type of the `db` handle — how contexts and helpers type their database parameter. */
export type Database = typeof db;

/**
 * Drains the underlying postgres.js connection pool. Intended for graceful
 * shutdown (SIGTERM/SIGINT) — call once, after the HTTP server has stopped
 * accepting new requests, so in-flight queries get a chance to finish.
 *
 * `timeout` (seconds) bounds how long postgres.js waits for in-flight
 * queries before forcibly closing sockets; 0 (the postgres.js default) would
 * wait forever.
 */
export async function closeDb(timeout = 5): Promise<void> {
  await client.end({ timeout });
}

/**
 * Cheap liveness probe for the database connection. Resolves if Postgres is
 * reachable, rejects otherwise. Used by GET /health so orchestrators get a
 * real readiness signal instead of a hardcoded 200.
 */
export async function pingDb(): Promise<void> {
  // Straight through the postgres.js client rather than the Drizzle handle: a
  // liveness probe only needs the pool, not the query builder.
  await client`select 1`;
}
