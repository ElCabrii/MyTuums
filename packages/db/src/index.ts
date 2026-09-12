import type { D1Database } from "@cloudflare/workers-types";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema/index.js";

// D1 cannot execute Drizzle's interactive transaction callbacks. Exclude that
// method so callers must express atomic changes as a batch or guarded SQL.
export type Database = Omit<DrizzleD1Database<typeof schema>, "transaction"> & {
  $client: D1Database;
};

/** A request's configured database; importing this module never opens a connection. */
export function createDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema });
}

export async function pingDb(db: Database): Promise<void> {
  await db.$client.prepare("select 1").first();
}
