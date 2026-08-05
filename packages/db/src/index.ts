import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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

/**
 * Whether to require TLS for this connection. Loopback addresses obviously
 * don't need it. Container orchestrators (Docker Compose, Kubernetes, ...)
 * resolve service-to-service hostnames as a single DNS label with no dot
 * (e.g. `postgres`, `postgres.svc`) inside a network that's already private
 * and un-routable from outside — and don't terminate TLS on it. A dotted
 * hostname is treated as a real DNS name (managed cloud DB, VPC endpoint,
 * ...) and requires TLS. This replaces an earlier version that only
 * special-cased `localhost`/`127.0.0.1` literally, which meant Postgres
 * looked "unreachable" from inside Docker Compose — the driver was
 * attempting a TLS handshake against a server that doesn't speak TLS.
 */
function requiresTls(url: string): boolean {
  const { hostname } = new URL(url);
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return false;
  }
  return hostname.includes(".");
}

// One pool for the whole process (10 connections, 10s connect timeout): the
// API procedures, the migration runner, and the test helpers all go through
// this same client.
const client = postgres(connectionString, {
  max: 10,
  connect_timeout: 10,
  ssl: requiresTls(connectionString) ? "require" : false,
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
  await db.execute(sql`select 1`);
}
