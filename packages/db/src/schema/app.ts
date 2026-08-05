// Application-specific tables live here, kept separate from ./auth.ts so
// that regenerating the BetterAuth schema (`db:generate:auth`, see the header
// of ./auth.ts) never clobbers app-owned tables.
import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  timestamp,
  index,
  primaryKey,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";

// Table names are singular to match the BetterAuth-generated tables in
// ./auth.ts (`user`, `session`, ...) rather than mixing conventions.
/**
 * A single status update — a top-level post, or a reply threaded under
 * `parentId`. Read and written by the `post` procedures in packages/api.
 */
export const post = pgTable(
  "post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // `user.id` is text (BetterAuth's own id format), so the FK must be too.
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    // Null for a top-level post, set for a reply. A self-reference needs the
    // explicit `AnyPgColumn` return type: without it the callback's inferred
    // type refers to `post` while `post` is still being defined, and tsc gives
    // up with "implicitly has type 'any' because it does not have a type
    // annotation and is referenced directly or indirectly in its own
    // initializer".
    //
    // `onDelete: "cascade"` is correct *because* there is no delete-post
    // procedure yet, so the only way a parent disappears today is its author
    // being deleted — which is already cascading the whole subtree away. Once
    // posts can be deleted individually this has to become a tombstone
    // instead, or deleting one post silently takes an unrelated conversation
    // with it.
    parentId: uuid("parent_id").references((): AnyPgColumn => post.id, { onDelete: "cascade" }),
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
    // All three indexes are ordered to match the keyset pagination in
    // packages/api/src/posts.ts: newest first, with `id` breaking ties
    // between posts sharing a timestamp so the cursor is a total order.
    //
    // Partial, because the home timelines (global and Following) are
    // top-level only — `post.list` filters `parent_id is null` unless it was
    // asked for replies. Excluding replies from the index keeps it the size
    // of the thing it actually serves, and lets Postgres use it for exactly
    // the queries whose predicate implies the same restriction.
    index("post_created_idx")
      .on(t.createdAt.desc(), t.id.desc())
      .where(sql`${t.parentId} is null`),
    // Deliberately NOT partial, unlike the one above: a profile feed passes
    // `includeReplies`, so this index has to cover replies too.
    index("post_author_created_idx").on(t.authorId, t.createdAt.desc(), t.id.desc()),
    // The reply list under a single post.
    index("post_parent_created_idx").on(t.parentId, t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * A like — one row per (post, user) pair; the composite primary key *is* the
 * "one like per user per post" rule (see the inline note below).
 */
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

/**
 * A directed follow edge from `followerId` to `followingId` — the rows the
 * Following feed and the follow lists are built from.
 */
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

/** Drizzle relations for `post` — the joins `with` queries can reach: author, likes, parent, and replies. */
export const postRelations = relations(post, ({ one, many }) => ({
  author: one(user, { fields: [post.authorId], references: [user.id] }),
  likes: many(postLike),
  // Named for the direction they point, like followRelations below: `parent`
  // is the post being replied to, `replies` the posts replying to this one.
  // Both sides need the same `relationName` for Drizzle to pair them up as
  // one self-relation rather than two unrelated ones.
  parent: one(post, {
    fields: [post.parentId],
    references: [post.id],
    relationName: "replies",
  }),
  replies: many(post, { relationName: "replies" }),
}));

/** Drizzle relations for `postLike` — the `post` and `user` a like references. */
export const postLikeRelations = relations(postLike, ({ one }) => ({
  post: one(post, { fields: [postLike.postId], references: [post.id] }),
  user: one(user, { fields: [postLike.userId], references: [user.id] }),
}));

/** Drizzle relations for `follow` — the `user` rows on both sides of the edge. */
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
