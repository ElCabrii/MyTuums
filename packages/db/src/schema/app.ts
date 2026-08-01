// Application-specific tables live here, kept separate from ./auth.ts so
// that regenerating the BetterAuth schema (`db:generate`, see auth.ts header)
// never clobbers app-owned tables.
import { relations, sql } from "drizzle-orm";
import { pgTable, text, uuid, timestamp, index, primaryKey, check } from "drizzle-orm/pg-core";
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
    //
    // `precision: 3` is load-bearing for the keyset pagination below, not a
    // storage optimisation. Postgres defaults to microseconds, but a JS `Date`
    // — which is what Drizzle reads this into, and all a JSON cursor can carry
    // — only holds milliseconds. So a cursor built from `.340448` encodes
    // `.340`, and the row-value comparison `(created_at, id) < ('...340', id)`
    // then excludes the stored `.340448` along with *every other row in that
    // millisecond*: a silent skip. Storing at the precision the consumer can
    // represent makes the cursor round-trip exact.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
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
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
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

export const follow = pgTable(
  "follow",
  {
    // Both sides are `text` for the same reason post.author_id is: `user.id`
    // is BetterAuth's own id format, not a uuid.
    followerId: text("follower_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    followingId: text("following_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above. It matters more here than anywhere else: follow
    // rows are routinely written in batches that share a single `now()`, so
    // the tie-breaker in the cursor is exercised constantly rather than by
    // coincidence.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // As with post_like, this composite primary key *is* the "you can follow
    // someone at most once" rule. Enforcing it here is what lets `follow` be
    // idempotent under a double-click via `onConflictDoNothing`, instead of
    // read-then-write racing.
    primaryKey({ columns: [t.followerId, t.followingId] }),
    // Following yourself is meaningless, and the Following feed already
    // includes your own posts unconditionally, so a self-row would double you
    // into your own timeline. The handler rejects it with a readable message
    // (see packages/api/src/users.ts); this is the invariant behind that check,
    // so no other write path can reintroduce it.
    check("follow_not_self", sql`${t.followerId} <> ${t.followingId}`),
    // Both indexes are ordered to match the keyset pagination in
    // packages/api/src/users.ts: newest first, with the *other* party's id
    // breaking ties between rows sharing a timestamp. The primary key already
    // covers the third access path — "does A follow B", which is both the
    // viewer's follow check and the Following feed's semi-join.
    index("follow_following_created_idx").on(
      t.followingId,
      t.createdAt.desc(),
      t.followerId.desc(),
    ),
    index("follow_follower_created_idx").on(
      t.followerId,
      t.createdAt.desc(),
      t.followingId.desc(),
    ),
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

export const followRelations = relations(follow, ({ one }) => ({
  // Named for the direction they point rather than for the column: `follower`
  // is the person doing the following, `following` the person being followed.
  follower: one(user, {
    fields: [follow.followerId],
    references: [user.id],
    relationName: "follower",
  }),
  following: one(user, {
    fields: [follow.followingId],
    references: [user.id],
    relationName: "following",
  }),
}));
