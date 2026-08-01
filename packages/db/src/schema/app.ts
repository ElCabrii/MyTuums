// Application-specific tables live here, kept separate from ./auth.ts so
// that regenerating the BetterAuth schema (`db:generate`, see auth.ts header)
// never clobbers app-owned tables.
import { relations } from "drizzle-orm";
import { pgTable, text, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

// Table names are singular to match the BetterAuth-generated tables in
// ./auth.ts (`user`, `session`, ...) rather than mixing conventions.
export const post = pgTable(
  "post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // `user.id` is text (BetterAuth's own id format), so the FK must be too.
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    // `withTimezone` is not cosmetic. On a bare `timestamp` (no time zone),
    // Postgres resolves `now()` to the *database session's* local wall clock,
    // while Drizzle's `mapFromDriverValue` reads the column back by appending
    // `+0000` — i.e. as if it were UTC. Those two only agree when the server
    // runs on UTC, so anywhere else every post comes back shifted by the
    // offset and the relative timestamps in the UI read "in 2 hours". With
    // `timestamptz` both sides speak instants and the offset cancels out.
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Both indexes are ordered to match the keyset pagination in
    // packages/api/src/router.ts: newest first, with `id` breaking ties
    // between posts sharing a timestamp so the cursor is a total order.
    index("post_created_idx").on(t.createdAt.desc(), t.id.desc()),
    index("post_author_created_idx").on(t.authorId, t.createdAt.desc(), t.id.desc()),
  ],
);

export const postLike = pgTable(
  "post_like",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `timestamptz` for the same reason as post.created_at above.
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // This composite primary key *is* the "one like per user per post" rule.
    // Enforcing it here rather than in the handler is what makes `like`
    // idempotent under double-clicks and request retries: the insert can
    // simply say `onConflictDoNothing` instead of read-then-write racing.
    primaryKey({ columns: [t.postId, t.userId] }),
    // The PK already covers (post_id, user_id) lookups; this covers the
    // other direction — "has the viewer liked these posts".
    index("post_like_user_idx").on(t.userId),
  ],
);

export const postRelations = relations(post, ({ one, many }) => ({
  author: one(user, { fields: [post.authorId], references: [user.id] }),
  likes: many(postLike),
}));

export const postLikeRelations = relations(postLike, ({ one }) => ({
  post: one(post, { fields: [postLike.postId], references: [post.id] }),
  user: one(user, { fields: [postLike.userId], references: [user.id] }),
}));
