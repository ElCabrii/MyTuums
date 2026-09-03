// Application-specific tables live here, kept separate from ./auth.ts so
// that regenerating the BetterAuth schema (`db:generate:auth`, see the header
// of ./auth.ts) never clobbers app-owned tables.
import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  uuid,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  check,
  jsonb,
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
    // `onDelete: "cascade"` stays correct now that posts can be deleted
    // individually (issue #148) *because* `post.delete` is a tombstone, not a
    // row delete: the row survives, so a self-delete never fires this
    // cascade. The only hard delete left is the author's account going away,
    // which is already cascading the whole subtree with it. Turning
    // `post.delete` into a real DELETE would have to change this first, or
    // one author's delete silently takes an unrelated conversation with it.
    parentId: uuid("parent_id").references((): AnyPgColumn => post.id, { onDelete: "cascade" }),
    // The post a quote references (issue #261). Unlike `parentId` — a
    // structural thread edge — a quote is a *reference*: the quoted post is
    // rendered embedded inside the quoting post, and neither belongs to the
    // other's reply tree. Null for ordinary posts and replies.
    //
    // Deliberately NO foreign key, the same evidence-retention reasoning as
    // `report.targetId` and `moderation_action.target_*`: a hard row delete
    // (today only the author's account going away) must not cascade the
    // QUOTER's post away with the quoted one — a quote is the quoter's words
    // about their own post, not part of the quoted author's subtree. The
    // projection in packages/api resolves the id at read time and renders a
    // null (unavailable) embedded card once the row no longer exists.
    quotedPostId: uuid("quoted_post_id"),
    // The removal tombstone (issue #38): a removed post is never deleted —
    // it stays in feeds as a stub (see `postSelection` in packages/api) so
    // threads, likes and replies keep their shape. `removedBy` is set null
    // when the moderator's account goes away, the same policy as
    // moderation_action.actor_id below; `removedReason` is the moderator's
    // stated reason, shown to the author and the moderation queue.
    removedAt: timestamp("removed_at", { withTimezone: true, precision: 3 }),
    removedBy: text("removed_by").references(() => user.id, { onDelete: "set null" }),
    removedReason: text("removed_reason"),
    // The author's own delete (issue #148) — a second tombstone, independent
    // of the removal one above and, like it, never a row delete.
    //
    // A separate column rather than reusing `removedAt` because the two are
    // different events with different consequences: a self-delete writes no
    // `moderation_action` row, is not appealable, cannot be restored, and its
    // stub says something else entirely. Sharing one column would make every
    // reader of the tombstone guess which of the two it was looking at.
    //
    // No `deletedBy`: the only account that can set this is `authorId`, which
    // the row already carries. No reason either — nobody is owed one.
    deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }),
    // The author's own edit (issue #264): stamped the first time `post.edit`
    // rewrites the text and restamped on every later edit, so it carries the
    // LAST edit time. Null means never edited. `createdAt` deliberately never
    // moves — an edit must not re-rank feeds — so this column is the marker's
    // only source. The superseded texts live in `post_edit`: editing stays
    // open even under moderation review, and the moderation case view shows
    // the recorded history so a moderator judges what was written, not only
    // what currently stands.
    editedAt: timestamp("edited_at", { withTimezone: true, precision: 3 }),
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
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
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
 * One superseded version of a post's text (issue #264). Each row stores the
 * content as it stood BEFORE the edit that replaced it, stamped with that
 * edit's instant — the same instant `post.edited_at` carries for the latest
 * one — so a post's full timeline is its `post_edit` rows plus the live
 * `post.content`.
 *
 * Editing stays open even while the post is under moderation review; this
 * table is what keeps that safe. The moderation case view reads it, so a
 * moderator judges everything the author wrote, not only what currently
 * stands — and a rewrite after a dismissal cannot hide what was judged the
 * first time. Moderator-gated reads only: no public surface exposes history.
 *
 * No author column — the only writer is the post's own author, which the
 * parent row already carries. Rows are never rewritten; the only delete is
 * the cascade when the post row itself goes (the author's account being
 * hard-deleted — `post.delete` is a tombstone and keeps the row).
 */
export const postEdit = pgTable(
  "post_edit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    // The text this edit replaced, not the text it wrote: the live
    // `post.content` is always the newest version, so the original wording
    // exists nowhere else and this is the only place it can survive.
    content: text("content").notNull(),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // The case view's read: one post's history, newest first. `id` breaks
    // ties between edits landing in the same millisecond the same way the
    // post keyset indexes do.
    index("post_edit_post_created_idx").on(t.postId, t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * A raster image attached to a post or reply. The object itself lives in the
 * private media bucket; this relation is the authoritative projection used by
 * every post reader and by the media authorization gate.
 *
 * Positions are explicit so the composer can preserve a user's ordering. A
 * moderation-tombstoned post keeps its attachment rows so restore is lossless;
 * the author's non-restorable deletion removes its rows after the post
 * tombstone commits. The API projection and media gate hide moderation rows
 * until the post is visible again, so neither tombstone exposes a copied URL.
 */
export const postAttachment = pgTable(
  "post_attachment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    mediaPath: text("media_path").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("post_attachment_position_idx").on(t.postId, t.position),
    check("post_attachment_position", sql`${t.position} >= 0`),
    check("post_attachment_byte_size", sql`${t.byteSize} > 0`),
    check("post_attachment_dimensions", sql`${t.width} > 0 and ${t.height} > 0`),
    check(
      "post_attachment_content_type",
      sql`${t.contentType} in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    ),
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
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
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
 * A repost (issue #261) — one row per (post, user) pair, mirroring `post_like`
 * in every structural respect so `repost`/`unrepost` can be the same
 * idempotent pair `like`/`unlike` is.
 *
 * A repost is an *event*, not a post: it carries no text and no images of its
 * own, so it has no `post` row. The home feeds therefore read a merged
 * timeline — post rows at their own `created_at`, repost rows amplifying the
 * original at the repost's `created_at` (see `post.list` in packages/api).
 */
export const postRepost = pgTable(
  "post_repost",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `timestamptz` with `precision: 3` for the same reasons as
    // post.created_at above — and, like every feed cursor column here, the
    // precision is load-bearing: the merged home-feed cursor orders on this
    // timestamp, and a cursor that cannot round-trip it would silently skip
    // repost events.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // This composite primary key *is* the "one repost per user per post" rule,
    // exactly as in `post_like`: the insert can say `onConflictDoNothing`, so a
    // double-clicked repost is a no-op rather than a read-then-write race.
    // Reposting your own post is allowed (no `not_self` check): unlike a
    // follow, a self-repost has a meaning — amplifying your own post to your
    // followers. "Reposting a repost" has no row shape at all: a repost has no
    // id of its own, so the only thing any repost action can target is an
    // original post.
    primaryKey({ columns: [t.postId, t.userId] }),
    // The PK already covers (post_id, user_id) lookups — the derived repost
    // count and the viewer's has-reposted check. `post_repost_created_idx`
    // covers the merged home-feed walk: every repost event, newest first,
    // ordered on exactly the (created_at, post_id, user_id) comparison the
    // event cursor makes. This one covers the per-profile walk (issue #277):
    // one author's repost events, newest first — once `user_id` is bound by
    // the profile feed's author filter, (created_at, post_id) is the rest of
    // the same event-cursor comparison. A created_at-leading index cannot
    // serve it: every entry would be read and filtered on user_id.
    index("post_repost_created_idx").on(t.createdAt.desc(), t.postId.desc(), t.userId.desc()),
    index("post_repost_user_created_idx").on(t.userId, t.createdAt.desc(), t.postId.desc()),
  ],
);

/**
 * A bookmark — one row per (post, user) pair; the caller's private saved list
 * (issue #262).
 *
 * The shape deliberately mirrors `post_like`, but the two are different
 * things and no surface may read one as the other: a like is public state (a
 * count on the post), a bookmark is private state (an ordering of the saver's
 * own page). There is deliberately no count column and no reader besides the
 * saver — `viewerHasBookmarked` in packages/api is an EXISTS probe for the
 * caller alone, and the bookmarks page is the only list ever built from this
 * table.
 */
export const postBookmark = pgTable(
  "post_bookmark",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above — and because the bookmarks page keyset-paginates
    // on (created_at, post_id), the precision is load-bearing here too.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // This composite primary key *is* the "one bookmark per user per post"
    // rule, exactly as for post_like: `bookmark` inserts with
    // `onConflictDoNothing` instead of read-then-write racing, so a retry or a
    // double-click can neither duplicate nor error.
    primaryKey({ columns: [t.postId, t.userId] }),
    // The bookmarks page: the caller's saved posts newest-first, `post_id`
    // breaking ties between bookmarks sharing a timestamp. The primary key
    // already covers the other direction — "has the viewer bookmarked this
    // post".
    index("post_bookmark_user_created_idx").on(t.userId, t.createdAt.desc(), t.postId.desc()),
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
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
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
    index("follow_follower_created_idx").on(t.followerId, t.createdAt.desc(), t.followingId.desc()),
  ],
);

/**
 * A report of a post or user (issue #38) — the raw material of the
 * moderation queue.
 *
 * The composite primary key *is* the "one report per (reporter, target)
 * pair" rule, and it is what makes `report` idempotent: the procedure
 * upserts with `onConflictDoUpdate`, so re-reporting the same target does
 * not pile up rows. Reopening is a stamp clearing, never a new row.
 *
 * `targetId` is deliberately a plain `text` with NO foreign key. Reports
 * are evidence: they must survive their target's deletion (a removed post
 * is a tombstone, but a post's *author* can still be hard-deleted through
 * better-auth), and a cascading FK would take the evidence with it. Whether
 * the target exists is enforced by the procedure, which resolves the id
 * against the target table before inserting.
 */
export const report = pgTable(
  "report",
  {
    // `user.id` is text (BetterAuth's own id format), so the FK must be too.
    reporterId: text("reporter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `'post'` or `'user'` (checked below). The pair (targetType, targetId)
    // names the reported thing; `targetId` is a post uuid or a user id.
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    // One of the stable reason codes from the design (issue #38), checked
    // below against the union of both targets' sets. The per-target subsets
    // (posts: spam/harassment/hate_speech/misinformation/self_harm/
    // illegal_content/nsfw; users: spam/harassment/impersonation/underage)
    // are enforced at input by the procedure's discriminated union.
    reason: text("reason").notNull(),
    // The post's content at the moment it was reported (issue #264). Null on
    // user-target reports and on rows reported before the column existed.
    // A report row otherwise carries only a reason code; this snapshot is
    // the exact evidence — what the reporter actually saw — independent of
    // whether the author has since edited the post. `post_edit` keeps every
    // version, but correlating versions to reports by timestamp is
    // reconstruction; this is the quote itself. Refreshed on a repeat
    // report alongside `createdAt`, since the reporter is re-reporting what
    // they now see.
    snapshotContent: text("snapshot_content"),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    // A null `resolvedAt` means the case is open. Resolution is a stamp
    // (`resolvedBy`/`resolvedOutcome`/`resolutionNote` land together), never
    // a delete — the rows stay as the case's history.
    resolvedAt: timestamp("resolved_at", { withTimezone: true, precision: 3 }),
    resolvedBy: text("resolved_by").references(() => user.id, { onDelete: "set null" }),
    resolvedOutcome: text("resolved_outcome"),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    // This composite primary key *is* the "one report per (reporter, target)
    // pair" rule — see the table comment.
    primaryKey({ columns: [t.reporterId, t.targetType, t.targetId] }),
    check("report_target_type", sql`${t.targetType} in ('post', 'user')`),
    // The union of both reason-code sets; the per-target split is input-
    // enforced by the procedure's discriminated union. One union check (not
    // two conditional ones) because the DB's job is to keep garbage out —
    // which set a code belongs to is a contract decision the procedure owns.
    check(
      "report_reason",
      sql`${t.reason} in ('spam', 'harassment', 'hate_speech', 'misinformation', 'self_harm', 'illegal_content', 'nsfw', 'impersonation', 'underage')`,
    ),
    // Reporting yourself is meaningless, and for a user-target report it
    // would let a reporter adjudicate their own case. Vacuous for posts
    // (a uuid can never equal a user id) and harmless there.
    check("report_not_self", sql`${t.reporterId} <> ${t.targetId}`),
    // The queue is built from unresolved reports, newest first. Partial to
    // match the queue query's predicate, the same reasoning as
    // post_created_idx above.
    index("report_open_idx")
      .on(t.createdAt.desc(), t.targetType, t.targetId)
      .where(sql`${t.resolvedAt} is null`),
    // "Everything reported against X" — the case view's full report history
    // (resolved rows included) and the queue's GROUP BY both lead with the
    // target key. Non-partial on purpose: the case view reads all history.
    index("report_target_idx").on(t.targetType, t.targetId, t.createdAt.desc()),
  ],
);

/**
 * A stamped profile badge (issue #308) — one row per (user, badge), written
 * the moment the badge is earned. Every badge is an achievement: once the
 * row exists it is never withdrawn, so an earned distinction survives the
 * count that earned it receding (followers unfollowing, likes unliking).
 *
 * The writers, one per family: the post-like tiers stamp inside
 * `post.like`'s transaction when a post's like count first passes a
 * threshold; the follower tiers stamp inside `user.follow`'s transaction
 * the same way; the join badges stamp at account creation
 * (packages/db/src/stamp-join-badges.ts, called by the auth instance's
 * create hook, with migration 0028's backfill covering accounts that
 * predate it); and `founder` is granted once, out of band, by the
 * committed bootstrap script (packages/db/src/grant-founder-badge.ts).
 *
 * The `badge` check constraint's list is BADGE_IDS from
 * `@my-tuums/api/badges` (packages/api/src/badges.ts), duplicated here as a
 * SQL literal because this package cannot import from the API (the dependency
 * points the other way). Keep the two in step — badges.ts's unit test pins
 * its half.
 */
export const userBadge = pgTable(
  "user_badge",
  {
    // `user.id` is text (BetterAuth's own id format), so the FK must be too.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    badge: text("badge").notNull(),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above.
    earnedAt: timestamp("earned_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // This composite primary key *is* the "a badge is stamped at most once per
    // account" rule, the same idempotency mechanism post_like uses: the
    // stamping insert says `onConflictDoNothing`, so a threshold re-crossed
    // after a recede (likes falling below a tier and climbing back over it)
    // mints no second row and no writer can race one.
    primaryKey({ columns: [t.userId, t.badge] }),
    check(
      "user_badge_badge",
      sql`${t.badge} in ('popular', 'rising_star', 'star', 'superstar', 'supernova', 'noticed', 'trendy', 'big', 'exploding', 'giant', 'founder', 'super_early_access', 'early_access')`,
    ),
  ],
);

/**
 * A directed block edge from `blockerId` to `blockedId` (issue #38).
 *
 * Blocking is mutual in the design: a blocked user cannot see the blocker
 * (posts, profile, search) and the blocker cannot see the blocked user
 * either — `invisibleAuthor` in packages/api/src/visibility.ts checks both
 * directions. The block procedure also severs follows in both directions
 * before inserting.
 *
 * Deliberately does NOT touch `post_like`: a block is silent and revocable,
 * and rewriting like state on every block/unblock is both noisy (email
 * churn, audit rows) and wrong (a like is not a relationship).
 */
export const userBlock = pgTable(
  "user_block",
  {
    // Both sides are `text` for the same reason post.author_id is: `user.id`
    // is BetterAuth's own id format, not a uuid.
    blockerId: text("blocker_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // This composite primary key *is* the "block someone at most once" rule;
    // `block` is idempotent via `onConflictDoNothing`, like follow.
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    check("user_block_not_self", sql`${t.blockerId} <> ${t.blockedId}`),
  ],
);

/**
 * The audit log (issue #38) — one row per moderation action, append-only.
 *
 * This is the hand-rolled replacement for the admin plugin's `auditLog`
 * option, which does not exist in better-auth 1.6.25 — and even if it did,
 * it would not know our post removals, suspensions, role changes and case
 * resolutions. Every `/rpc` moderation procedure writes exactly one row
 * here, with `details` carrying the action-specific extras (old/new role,
 * suspension duration, appeal outcome...).
 *
 * `actorId` is set null (not cascade) when the actor's account goes away:
 * the action stays in the audit trail, the link just breaks. `reason` is
 * the moderator's stated reason — what the emails quote; `note` is an
 * optional internal note for the next moderator.
 *
 * The two target columns deliberately have NO foreign keys, the same
 * evidence-retention reasoning as `report.targetId` above: an audit row
 * must survive its target's deletion. A FK with `ON DELETE SET NULL` would
 * also contradict the `one_target`/`target_match` checks below — setting
 * one target column null while the other is already null violates them, so
 * the DELETE would abort wholesale. Whether the target exists is enforced
 * by the procedures, which resolve the id before acting.
 */
export const moderationAction = pgTable(
  "moderation_action",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One of the action codes checked below — the design's stable set.
    action: text("action").notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    // `'post'` or `'user'` — decides which target column below is set
    // (checked below).
    targetType: text("target_type").notNull(),
    targetPostId: uuid("target_post_id"),
    targetUserId: text("target_user_id"),
    reason: text("reason"),
    note: text("note"),
    // Action-specific extras: `{oldRole, newRole}` for role_changed,
    // `{durationSeconds}` for user_suspended, `{outcome}` for
    // appeal_resolved, `{reporterCount, outcome}` for case_resolved.
    details: jsonb("details").default({}).notNull(),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above — and because the audit log is keyset-paginated
    // on (created_at, id), the precision is load-bearing here too.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "moderation_action_action",
      sql`${t.action} in ('post_removed', 'post_restored', 'user_suspended', 'user_unsuspended', 'user_banned', 'user_unbanned', 'role_changed', 'case_resolved', 'appeal_resolved')`,
    ),
    check("moderation_action_target_type", sql`${t.targetType} in ('post', 'user')`),
    // Exactly one of the two target columns is set — an audit row always
    // names one thing it happened to.
    check(
      "moderation_action_one_target",
      sql`(${t.targetPostId} is null) <> (${t.targetUserId} is null)`,
    ),
    // ...and the type column agrees with which one that is.
    check(
      "moderation_action_target_match",
      sql`(${t.targetType} = 'post') = (${t.targetPostId} is not null)`,
    ),
    // The audit log's keyset order: newest first, `id` breaking ties.
    index("moderation_action_created_idx").on(t.createdAt.desc(), t.id.desc()),
    // "What was the last action on X" — the removed-post appeal stub path
    // and the queue's latest-action lookups. Deliberately not partial: the
    // audit log is queried by target across all of history, not just open
    // cases.
    index("moderation_action_target_idx").on(
      t.targetType,
      t.targetPostId,
      t.targetUserId,
      t.createdAt.desc(),
    ),
  ],
);

/**
 * An appeal against a moderation action (issue #38) — opened either from the
 * email link (signed-out, capability token) or from a removed-post stub
 * (signed-in).
 *
 * `tokenNonce` is the replay-protection half of the appeal token: the token
 * in the email is `payload.sig` where the payload carries this nonce, so a
 * second submission with the same nonce violates the unique constraint and
 * is refused as "already used" rather than silently reopening.
 *
 * One open appeal per action is enforced by the partial unique index below
 * — re-appealing an upheld action must go through a moderator, not the
 * form. A newer action of the same kind against the same target closes the
 * older appeal as `superseded` (see `supersedeOpenAppeals` in
 * packages/api/src/moderation-actions.ts), so at most one appeal per target
 * per control family is ever open: an appeal against a sanction that no
 * longer governs anything cannot be reviewed as if it did.
 */
export const appeal = pgTable(
  "appeal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Cascades with the action: an appeal is evidence attached to the
    // action it contests, and the audit log never hides actions.
    actionId: uuid("action_id")
      .notNull()
      .references(() => moderationAction.id, { onDelete: "cascade" }),
    // Always set — the token's payload carries the userId even when the
    // appellant submits signed-out.
    appellantId: text("appellant_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenNonce: text("token_nonce").notNull().unique(),
    // The appellant's own words; 10..2000 characters enforced at input.
    reason: text("reason").notNull(),
    // `'open'`, `'upheld'`, `'overturned'`, `'reversed'`, `'superseded'` or
    // `'withdrawn'` (checked below). The last three are the terminal states
    // reached without a review, so their nullable review fields deliberately
    // remain empty: `reversed` means the contested action was undone outside
    // appeal review, `superseded` means a newer action of the same kind
    // replaced it, and `withdrawn` means the appellant ended the grievance by
    // deleting the contested post — the author of a removed post is its only
    // possible appellant. The difference matters to the record: reversed is
    // the remedy the appellant asked for, superseded and withdrawn are not.
    status: text("status").default("open").notNull(),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewNote: text("review_note"),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    check(
      "appeal_status",
      sql`${t.status} in ('open', 'upheld', 'overturned', 'reversed', 'superseded', 'withdrawn')`,
    ),
    // The queue scans open appeals, newest first — the sort column is in
    // the index so the partial scan never needs a heap sort.
    index("appeal_open_idx")
      .on(t.status, t.createdAt.desc())
      .where(sql`${t.status} = 'open'`),
    // The "one open appeal per action" rule, as a partial unique index —
    // resolved appeals are history and may accumulate.
    uniqueIndex("appeal_open_action_idx")
      .on(t.actionId)
      .where(sql`${t.status} = 'open'`),
  ],
);

/**
 * An in-app notification (issue #259) — one row per event its recipient can
 * later discover on the notifications page: a like on their post, a reply to
 * their post, a repost of their post, a quote of their post, a follow, or a
 * moderation action on their content or account.
 *
 * Written only inside the same transaction as its cause (the like/repost/follow
 * insert, the reply or quote insert, the `moderation_action` row), so a
 * rollback leaves neither half. Exactly-once comes from the same shape that
 * makes like/follow idempotent: the notification is minted only when the cause
 * row was newly inserted, or — for moderation — by the same locked, guarded
 * path that mints the append-only audit row.
 *
 * `actorId` is set null (not cascade) when the actor's account goes away:
 * moderation notifications are system rows (null actor by construction) that
 * must survive their moderator's deletion exactly like the audit rows they
 * reference. Like/reply/repost/quote/follow rows whose actor was hard-deleted
 * read as null here, and the list projection drops them — a like
 * notification with no liker has nothing left to say. One column cannot have
 * two FK behaviours, so `set null` plus that read-time filter is what gives
 * user-caused rows their cascade-equivalent semantics without losing the
 * moderation ones.
 */
export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The notification's owner — the only person the list ever serves. Their
    // account going away takes their notifications with them.
    recipientId: text("recipient_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Who caused it. Null for moderation rows (the notice is from MyTuums,
    // matching the branded email that never names the moderator); set null on
    // actor deletion, see the table comment.
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    // `'like'`, `'reply'`, `'repost'`, `'quote'`, `'follow'` or
    // `'moderation'` (checked below). The `$type` union mirrors that check
    // constraint so selects carry the six codes to TypeScript consumers —
    // the same mirroring `MODERATION_ACTION_CODES` in packages/api does for
    // `moderation_action`.
    type: text("type")
      .$type<"like" | "reply" | "repost" | "quote" | "follow" | "moderation">()
      .notNull(),
    // The like's or repost's post / the reply or quote itself (the thing the
    // recipient clicks through to). Null for follow and moderation.
    postId: uuid("post_id").references(() => post.id, { onDelete: "cascade" }),
    // The moderation action the notification mirrors — carries the code,
    // reason and target the page renders. Null for user-caused types.
    actionId: uuid("action_id").references(() => moderationAction.id, { onDelete: "cascade" }),
    // `timestamptz` and `precision: 3` for the same reasons as
    // post.created_at above — and because the list is keyset-paginated on
    // (created_at, id), the precision is load-bearing here too.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "notification_type",
      sql`${t.type} in ('like', 'reply', 'repost', 'quote', 'follow', 'moderation')`,
    ),
    // Like, reply, repost and quote rows name the post they are about; follow
    // and moderation rows carry no post reference. An equality of booleans
    // rather than a bare `is not null`, so neither type can smuggle the
    // other's target.
    check(
      "notification_post_ref",
      sql`(${t.type} in ('like', 'reply', 'repost', 'quote')) = (${t.postId} is not null)`,
    ),
    // Moderation rows mirror one audit action; every other type has none.
    check("notification_action_ref", sql`(${t.type} = 'moderation') = (${t.actionId} is not null)`),
    // Self-caused events never notify — the check behind the handler-side
    // guard, so no other write path can reintroduce it. Null (moderation
    // system rows) stays legal: the check is only about the actor when there
    // is one.
    check("notification_not_self", sql`${t.actorId} is null or ${t.actorId} <> ${t.recipientId}`),
    // The list's keyset order: newest first, `id` breaking ties — mirrored by
    // packages/api/src/notifications.ts. It also carries the unread scans:
    // read state is a per-recipient seen-at cursor
    // (`notification_last_seen`), so "unread" is `created_at > seen_at` —
    // exactly the leading columns here.
    index("notification_recipient_created_idx").on(t.recipientId, t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * The read-state cursor for one recipient's notifications (issue #259): the
 * moment they last opened `/notifications`. A row is read exactly when its
 * `created_at` is at or before `seen_at` — read state lives here rather than
 * as a per-row stamp so the page's "open means read" is one idempotent
 * upsert instead of N row updates, and so no notification is ever *born*
 * read: what the recipient has and has not seen stays truthful even when the
 * badge damps a burst (the damper counts ticks, it never rewrites history —
 * see `notification.unreadCount`).
 *
 * One row per recipient, created by `notification.markRead`. Absent means
 * never opened the page: everything is unread.
 */
export const notificationLastSeen = pgTable("notification_last_seen", {
  recipientId: text("recipient_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  seenAt: timestamp("seen_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
});

/**
 * A resolved link preview card, keyed by the normalized URL it describes
 * (issue #260). One row per URL: the card is a property of the target page,
 * not of any post, so every post carrying the same URL shares it.
 *
 * `title` is the card's existence proof. A row with `title` set is a fetched
 * card; a row with `title` null is a *negative* cache entry — "this URL was
 * fetched within the revalidation window and produced no card" (dead target,
 * refused address, missing Open Graph payload). Without that negative half,
 * a post whose URL has nothing to unfurl would trigger an outbound fetch on
 * every fresh view of every post carrying it, bounded only by the rate
 * limiter.
 *
 * The row caches a *snapshot*, deliberately: a post's stored content is never
 * rewritten, and neither is the card until the revalidation window expires
 * (`fetchedAt` + window ⇒ refetch on the next request). The lead image, when
 * one was provided and stored, lives in the media bucket under
 * `link-cards/<uuid>.<ext>` and is served through `/media/` like every other
 * object — never hot-linked from the target.
 *
 * A purged row (`purgedAt` set) is the moderation record for a hostile
 * unfurl: the card fields are nulled, the URL never unfurls again, and the
 * purge columns carry who removed it and why — the audit trail the
 * `moderation_action` table cannot hold, its targets being post- and
 * user-shaped by schema.
 */
export const linkCard = pgTable(
  "link_card",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The normalized absolute http(s) URL (scheme + host + path + query, the
    // fragment dropped — it never changes what the server returns). The
    // unique index below is the "fetched once per window" rule's anchor.
    url: text("url").notNull(),
    domain: text("domain"),
    title: text("title"),
    description: text("description"),
    imageMediaPath: text("image_media_path"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    purgedAt: timestamp("purged_at", { withTimezone: true, precision: 3 }),
    purgedBy: text("purged_by").references(() => user.id, { onDelete: "set null" }),
    purgedReason: text("purged_reason"),
  },
  (t) => [
    uniqueIndex("link_card_url_key").on(t.url),
    // A negative entry is exactly "no title"; a positive one always carries
    // both a domain and a title. Checked here so no writer can drift.
    check(
      "link_card_title",
      sql`(${t.title} is null and ${t.domain} is null) or (${t.title} is not null and ${t.domain} is not null)`,
    ),
  ],
);

/** Drizzle relations for `post` — the joins `with` queries can reach: author, likes, bookmarks, parent, and replies. */
export const postRelations = relations(post, ({ one, many }) => ({
  author: one(user, { fields: [post.authorId], references: [user.id] }),
  likes: many(postLike),
  bookmarks: many(postBookmark),
  attachments: many(postAttachment),
  reposts: many(postRepost),
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
  edits: many(postEdit),
  // The quote self-relation (issue #261): `quotedPost` is the post this one
  // references, `quotes` the posts referencing this one. A separate
  // `relationName` from "replies" so the two self-relations stay distinct.
  quotedPost: one(post, {
    fields: [post.quotedPostId],
    references: [post.id],
    relationName: "quotes",
  }),
  quotes: many(post, { relationName: "quotes" }),
}));

/** Drizzle relations for `postEdit` — the post whose text this version superseded. */
export const postEditRelations = relations(postEdit, ({ one }) => ({
  post: one(post, { fields: [postEdit.postId], references: [post.id] }),
}));

/** Drizzle relations for post attachments — the owning post. */
export const postAttachmentRelations = relations(postAttachment, ({ one }) => ({
  post: one(post, { fields: [postAttachment.postId], references: [post.id] }),
}));

/** Drizzle relations for `postLike` — the `post` and `user` a like references. */
export const postLikeRelations = relations(postLike, ({ one }) => ({
  post: one(post, { fields: [postLike.postId], references: [post.id] }),
  user: one(user, { fields: [postLike.userId], references: [user.id] }),
}));

/** Drizzle relations for `postRepost` — the amplified `post` and the reposter. */
export const postRepostRelations = relations(postRepost, ({ one }) => ({
  post: one(post, { fields: [postRepost.postId], references: [post.id] }),
  user: one(user, { fields: [postRepost.userId], references: [user.id] }),
}));

/** Drizzle relations for `postBookmark` — the `post` and `user` a bookmark references. */
export const postBookmarkRelations = relations(postBookmark, ({ one }) => ({
  post: one(post, { fields: [postBookmark.postId], references: [post.id] }),
  user: one(user, { fields: [postBookmark.userId], references: [user.id] }),
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

/** Drizzle relations for `report` — the reporter and the resolving moderator. */
export const reportRelations = relations(report, ({ one }) => ({
  reporter: one(user, {
    fields: [report.reporterId],
    references: [user.id],
    relationName: "reporter",
  }),
  resolvedBy: one(user, {
    fields: [report.resolvedBy],
    references: [user.id],
    relationName: "resolvedBy",
  }),
}));

/** Drizzle relations for `userBadge` — the account whose profile displays it. */
export const userBadgeRelations = relations(userBadge, ({ one }) => ({
  user: one(user, { fields: [userBadge.userId], references: [user.id] }),
}));

/** Drizzle relations for `userBlock` — the `user` rows on both sides of the edge. */
export const userBlockRelations = relations(userBlock, ({ one }) => ({
  blocker: one(user, {
    fields: [userBlock.blockerId],
    references: [user.id],
    relationName: "blocker",
  }),
  blocked: one(user, {
    fields: [userBlock.blockedId],
    references: [user.id],
    relationName: "blocked",
  }),
}));

/** Drizzle relations for `moderationAction` — the actor and the thing it acted on. */
export const moderationActionRelations = relations(moderationAction, ({ one }) => ({
  actor: one(user, {
    fields: [moderationAction.actorId],
    references: [user.id],
    relationName: "actor",
  }),
  targetPost: one(post, {
    fields: [moderationAction.targetPostId],
    references: [post.id],
  }),
  targetUser: one(user, {
    fields: [moderationAction.targetUserId],
    references: [user.id],
    relationName: "targetUser",
  }),
}));

/** Drizzle relations for `appeal` — the contested action, the appellant, and the reviewer. */
export const appealRelations = relations(appeal, ({ one }) => ({
  action: one(moderationAction, {
    fields: [appeal.actionId],
    references: [moderationAction.id],
  }),
  appellant: one(user, {
    fields: [appeal.appellantId],
    references: [user.id],
    relationName: "appellant",
  }),
  reviewedBy: one(user, {
    fields: [appeal.reviewedBy],
    references: [user.id],
    relationName: "reviewedBy",
  }),
}));

/** Drizzle relations for `notification` — the recipient, the actor, the post and the mirrored action. */
export const notificationRelations = relations(notification, ({ one }) => ({
  recipient: one(user, {
    fields: [notification.recipientId],
    references: [user.id],
    relationName: "recipient",
  }),
  actor: one(user, {
    fields: [notification.actorId],
    references: [user.id],
    relationName: "actor",
  }),
  post: one(post, {
    fields: [notification.postId],
    references: [post.id],
  }),
  action: one(moderationAction, {
    fields: [notification.actionId],
    references: [moderationAction.id],
  }),
}));
