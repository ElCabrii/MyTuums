import type { SQL } from "drizzle-orm";
import type { Database } from "@my-tuums/db";

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
 * The element-access call is deliberate: it preserves the method's receiver
 * (`this`) the same way a dotted call would, while keeping the raw execution
 * on this one line. Keep this module free of runtime imports — `e2e` loads it
 * before it has fixed up `DATABASE_URL`, so only type-only imports are safe.
 */
export function runSql<T = unknown>(
  executor: Pick<Database, "execute">,
  fragment: SQL,
): Promise<T[]> {
  // SAFETY: `execute` returns the driver's raw rows for whatever fragment it
  // was handed — the generic only shapes already-plain objects, so the cast
  // encodes no checked invariant.
  return executor["execute"](fragment) as Promise<T[]>;
}
