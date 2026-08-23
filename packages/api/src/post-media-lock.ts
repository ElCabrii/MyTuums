import { sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";

/**
 * One database-wide lock coordinates post attachment writes with the media
 * reconciler. The lock is transaction-scoped, so PostgreSQL releases it on
 * commit or rollback even if a storage provider fails while the transaction
 * is open.
 *
 * Keep this value stable: the API process and the maintenance command must
 * use the same advisory-lock namespace without needing a schema row.
 */
export const POST_MEDIA_LIFECYCLE_LOCK_KEY = 173_173;

/** Acquires the shared transaction-scoped post-media lifecycle lock. */
export async function acquirePostMediaLifecycleLock(
  executor: Pick<Database, "execute">,
): Promise<void> {
  await executor.execute(
    sql`select pg_advisory_xact_lock(${POST_MEDIA_LIFECYCLE_LOCK_KEY}::bigint)`,
  );
}

/** Runs a maintenance pass while holding the shared lifecycle lock. */
export async function withPostMediaLifecycleLock<T>(
  db: Database,
  work: (tx: Pick<Database, "execute" | "select">) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await acquirePostMediaLifecycleLock(tx);
    return work(tx);
  });
}
