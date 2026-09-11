import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import type { z } from "zod";

/** SQLite JSON projections arrive as text; validate them at the query boundary. */
export function jsonDecoder<T>(schema: z.ZodType<T>) {
  return (value: string | null): T => schema.parse(value === null ? null : JSON.parse(value));
}

/** Bind a text ID set once, including an empty set, within D1's parameter limit. */
export function textIn(column: AnyColumn<{ data: string }>, values: readonly string[]) {
  return sql`${column} in (select value from json_each(${JSON.stringify(values)}))`;
}

/**
 * The single execution point for hand-written SQL.
 *
 * Drizzle's `sql` tagged template compiles every interpolated value to a bind
 * parameter, so a fragment executed through here is parameterized by
 * construction — `sql.raw` is the library's only raw-text escape hatch and
 * nothing routed through this helper may use it. Routing every raw statement
 * through one named function keeps that surface greppable and reads as what
 * it is (a parameterized fragment runner) rather than a bare `execute` that
 * string-concatenating scanners cannot tell apart from built SQL.
 *
 * This module has no ambient connection. The caller
 * supplies its D1 database and Drizzle binds the fragment's parameters.
 */
export function runSql<T = unknown>(executor: Pick<Database, "all">, fragment: SQL): Promise<T[]> {
  return executor.all<T>(fragment);
}
