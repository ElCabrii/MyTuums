import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { CursorCodec } from "./cursor.js";

type StringKeys<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T];

/**
 * The key of `selection` whose value is exactly the column `C` — what ties
 * `createdAtField` to the `createdAt` column passed alongside it. A column's
 * type carries its table and column name, so `user.createdAt` and
 * `follow.createdAt` are different types: at the followers call site the
 * only key whose value IS `follow.createdAt` is `followedAt`, and passing
 * `"createdAt"` (the listed user's registration date) is a compile error.
 */
type ColumnKey<S, C> = { [K in keyof S]: S[K] extends C ? K : never }[keyof S];

/** A column whose JS value is a Date — what the cursor's timestamp half must be. */
type DateColumn = PgColumn & { _: { data: Date } };

/** A column whose JS value is a string — what the cursor's id half must be. */
type StringColumn = PgColumn & { _: { data: string } };

/**
 * The keyset page skeleton every paginated list in this package is built
 * from — see ./cursor.ts for why keyset rather than OFFSET, and for the
 * encoding.
 *
 * The caller supplies the query — selection, tables, joins, filters, the
 * ORDER BY on the same columns as the cursor comparison, and the +1
 * lookahead — and this owns the parts that must never drift between feeds:
 *
 * - the cursor filter: a row-value comparison strictly "older than the
 *   cursor" under the same (created_at DESC, id DESC) ordering the index
 *   provides, so Postgres can seek straight to the cursor position. The
 *   bound values go through `sql.param` with their column as the encoder —
 *   interpolating them directly hands postgres.js a raw JS `Date`, which it
 *   cannot serialise (`mapToDriverValue` on the column is what turns it into
 *   the ISO string Postgres expects).
 * - the hasMore decision: one row beyond the page, purely to learn whether
 *   another page exists without a second COUNT query. It is dropped before
 *   returning.
 * - the anchor: the next cursor is the LAST row actually returned, with a
 *   strict "<" cursor. Anchoring on the first row past the page instead
 *   would drop exactly that row at every boundary.
 *
 * `selection` is the same object the query selects from — it is how
 * `createdAtField` is tied to `createdAt`: the field must be the key whose
 * selection value IS that column, so the cursor always encodes the row-side
 * of the same pair the SQL compares. The id half cannot be tied the same
 * way — the follow lists select the joined `user.id` while the cursor
 * compares `follow.follower_id` (equal by the join, different columns) — so
 * `idField` is only checked to be a string field. The exactly-once
 * keyset-walk tests are what catch a mismatch there.
 */
export async function keysetPage<S, C extends DateColumn, T>(args: {
  codec: CursorCodec;
  cursor: string | undefined;
  limit: number;
  // Type-only: never read at runtime — it exists solely to tie
  // `createdAtField` to the `createdAt` column (see the module doc).
  selection: S;
  createdAt: C;
  createdAtField: ColumnKey<S, C> & keyof T;
  id: StringColumn;
  idField: StringKeys<T>;
  query: (cursorFilter: SQL | undefined) => Promise<T[]>;
}): Promise<{ items: T[]; nextCursor: string | null }> {
  const decoded = args.cursor ? args.codec.decode(args.cursor) : undefined;
  const cursorFilter = decoded
    ? sql`(${args.createdAt}, ${args.id}) < (${sql.param(decoded.createdAt, args.createdAt)}, ${sql.param(decoded.id, args.id)})`
    : undefined;

  const rows = await args.query(cursorFilter);

  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  const last = items.at(-1);

  if (!hasMore || !last) return { items, nextCursor: null };

  // The ColumnKey tie guarantees the field is the row-side of the createdAt
  // column, so its value is a Date; the casts bridge the gap TS cannot close
  // between the selection type S and the row type T.
  return {
    items,
    nextCursor: args.codec.encode(last[args.createdAtField] as Date, last[args.idField] as string),
  };
}
