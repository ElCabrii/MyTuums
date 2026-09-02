import { sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { runSql } from "./sql.js";

/**
 * The advisory-lock class that serializes writes to the relationship between
 * a pair of users — the `follow` and `user_block` edges.
 *
 * PostgreSQL keeps the two-argument advisory lock space entirely separate from
 * the one-argument (bigint) space, so this namespace cannot collide with
 * `POST_MEDIA_LIFECYCLE_LOCK_KEY`, which uses the bigint form. Keep the value
 * stable: it is the shared namespace every relationship writer must agree on,
 * and it needs no schema row to coordinate.
 */
export const RELATIONSHIP_LOCK_CLASS = 7311;

/**
 * The lock key for an *unordered* pair of user ids: the pair {a, b} and the
 * pair {b, a} are the same relationship, so both must hash to one key, or
 * `follow` (which writes a directed edge) and `block` (which severs both
 * directions) could hold different locks and never see each other.
 *
 * FNV-1a over the sorted, delimited pair rather than PostgreSQL's `hashtext`:
 * the derivation is then ours, pure, and unit-testable without a database.
 * The 32-bit width is what `pg_advisory_xact_lock(int4, int4)` takes; a
 * collision between two unrelated pairs costs a little needless serialization
 * and nothing else, which is why a non-cryptographic hash is the right tool
 * here. The separator is a character no BetterAuth user id contains, so no
 * two distinct pairs can produce the same input string.
 */
export function relationshipLockKey(a: string, b: string): number {
  const pair = a < b ? `${a} ${b}` : `${b} ${a}`;

  let hash = 0x811c9dc5;
  for (let i = 0; i < pair.length; i += 1) {
    hash ^= pair.charCodeAt(i);
    // The FNV prime (16777619) as shifts, so the arithmetic stays in 32 bits
    // instead of losing precision through a float multiply.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  // `pg_advisory_xact_lock`'s int4 arguments are signed.
  return hash | 0;
}

/**
 * Serializes every write to the relationship between two users, for the life
 * of the calling transaction.
 *
 * `follow` and `block` write different tables, so the database cannot enforce
 * "a blocked pair has no follow edge" with a constraint. Without this lock, a
 * follow whose block check ran before a block committed can insert its edge
 * after that block severed the existing ones, leaving a prohibited follow
 * standing behind the block — invisible to both parties while it stands, and
 * back in view the moment the block is lifted. Holding this lock across the
 * check AND the write is what makes that interleaving impossible.
 *
 * Transaction-scoped, so PostgreSQL releases it on commit or rollback and
 * there is no unlock path to forget.
 */
export async function acquireRelationshipLock(
  executor: Pick<Database, "execute">,
  a: string,
  b: string,
): Promise<void> {
  await runSql(
    executor,
    sql`select pg_advisory_xact_lock(${RELATIONSHIP_LOCK_CLASS}::int4, ${relationshipLockKey(a, b)}::int4)`,
  );
}
