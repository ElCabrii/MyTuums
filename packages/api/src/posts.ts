import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { follow, post, postLike, user } from "@my-tuums/db/schema";
import { z } from "zod";
import {
  POST_MAX_LENGTH,
  POST_PAGE_SIZE,
  POST_PAGE_SIZE_MAX,
  THREAD_ANCESTOR_MAX,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { invisibleAuthor } from "./visibility.js";

/**
 * Feeds are keyset-paginated on `(post.created_at, post.id) DESC`; see
 * ./cursor.ts for why, and for the encoding. `post.id` is a uuid, so a cursor
 * minted here won't validate anywhere else.
 */
const postCursor = createCursorCodec(z.uuid());

/**
 * Like counts are derived on read rather than denormalised onto a
 * `post.like_count` column. A correlated count over the `post_like` primary
 * key is cheap at this scale, and it can't drift out of sync the way a
 * counter maintained by the application can. If it ever shows up in a slow
 * query log, a stored counter can replace this without changing the shape
 * the API returns.
 */
const likeCount = sql<number>`(
  select count(*)::int from ${postLike} where ${postLike.postId} = ${post.id}
)`;

/**
 * Derived the same way — and for the same reasons — as `likeCount` above.
 *
 * The subquery needs its own alias for the table it is already inside, hence
 * `as reply`: without it `parent_id = id` would compare the outer row to
 * itself and count every post whose parent is its own id, i.e. nothing.
 */
const replyCount = sql<number>`(
  select count(*)::int from ${post} as reply where reply.parent_id = ${post.id}
)`;

/** Whether the viewer has liked this post — an EXISTS subquery. */
function viewerHasLiked(viewerId: string) {
  return sql<boolean>`exists (
    select 1 from ${postLike}
    where ${postLike.postId} = ${post.id} and ${postLike.userId} = ${viewerId}
  )`;
}

/**
 * The one projection every feed and thread reads posts through, so no view of
 * a post can drift from another's (an int test asserts the equality).
 */
export const postSelection = (viewerId: string) => ({
  id: post.id,
  // The tombstone projection (issue #38, widened by #148): a post that was
  // removed by a moderator OR deleted by its author keeps its row — neither
  // is a hard delete — but reads as null content here, which is what renders
  // the stub. `removedReason` is null for everyone but the author, so a
  // removed post can say why to the person it happened to and nothing to
  // anyone else. The moderation case view reads a separate raw-content
  // projection (moderator-gated), never this one.
  content: sql<
    string | null
  >`case when ${post.removedAt} is not null or ${post.deletedAt} is not null then null else ${post.content} end`,
  removed: sql<boolean>`${post.removedAt} is not null`,
  // Two flags rather than one, because the two tombstones mean different
  // things to the reader: a removal is a moderation action the author can
  // appeal, a deletion is the author's own doing and has nothing to appeal.
  // The stub copy differs accordingly (see `post-card.tsx`).
  deleted: sql<boolean>`${post.deletedAt} is not null`,
  removedReason: sql<
    string | null
  >`case when ${post.removedAt} is not null and ${post.authorId} = ${viewerId} then ${post.removedReason} else null end`,
  createdAt: post.createdAt,
  // Null for a top-level post. The web app reads it to decide whether a card
  // needs a "Replying to" line, so it belongs in the shared selection rather
  // than only in the thread payload.
  parentId: post.parentId,
  author: {
    id: user.id,
    name: user.name,
    username: user.username,
    displayUsername: user.displayUsername,
    image: user.image,
  },
  likeCount,
  replyCount,
  viewerHasLiked: viewerHasLiked(viewerId),
});

async function countLikes(db: Database, postId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postLike)
    .where(eq(postLike.postId, postId));

  return row?.count ?? 0;
}

/**
 * The `post` procedure group: create, delete, list, thread, like, unlike.
 */
export const postRouter = {
  /**
   * Creates a post, or a reply when `parentId` is set. Requires a session.
   */
  create: protectedProcedure
    .use(rateLimit(RATE_LIMITS.write))
    .input(
      z.object({
        // Trim first so a body of only whitespace fails `min(1)` rather than
        // being stored as an empty-looking post.
        content: z.string().trim().min(1, "Post cannot be empty.").max(POST_MAX_LENGTH),
        /** Omit for a top-level post; set to reply to an existing one. */
        parentId: z.uuid().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      // The foreign key already rejects a parent that doesn't exist, but it
      // surfaces as an unexplained INTERNAL_SERVER_ERROR. Checking first is
      // the same courtesy `user.follow` pays for its CHECK constraint — the
      // constraint remains the invariant.
      //
      // The visibility filter is part of the same courtesy: a parent hidden
      // from you (banned author, a block either way) reads as nonexistent
      // rather than hinting it exists. A parent that was *removed* stays
      // replyable — removal is not invisibility, and a removed post is still
      // a real post with a thread.
      if (input.parentId) {
        const [parent] = await context.db
          .select({ id: post.id })
          .from(post)
          .innerJoin(user, eq(user.id, post.authorId))
          .where(and(eq(post.id, input.parentId), not(invisibleAuthor(context.user.id))))
          .limit(1);

        if (!parent) {
          throw new ORPCError("NOT_FOUND", {
            message: "The post you replied to no longer exists.",
          });
        }
      }

      const [created] = await context.db
        .insert(post)
        .values({
          authorId: context.user.id,
          content: input.content,
          parentId: input.parentId ?? null,
        })
        .returning({
          id: post.id,
          content: post.content,
          createdAt: post.createdAt,
          parentId: post.parentId,
        });

      if (!created) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create post." });
      }

      return {
        ...created,
        // Matches the additive tombstone fields of `postSelection` — a fresh
        // post is neither removed nor deleted, so these are constants rather
        // than columns.
        removed: false,
        deleted: false,
        removedReason: null,
        author: {
          id: context.user.id,
          name: context.user.name,
          username: context.user.username ?? null,
          displayUsername: context.user.displayUsername ?? null,
          image: context.user.image ?? null,
        },
        likeCount: 0,
        replyCount: 0,
        viewerHasLiked: false,
      };
    }),

  /**
   * Deletes the caller's own post (issue #148). Requires a session.
   *
   * A tombstone, not a row delete: `deleted_at` is stamped and the row stays,
   * so the post's replies, its likes and the conversation above it keep their
   * shape — exactly what a moderator's `removePost` does, and for the same
   * reason. `post.parent_id` still cascades on delete (see the schema
   * comment), so a real DELETE here would silently take the whole reply
   * subtree with it.
   *
   * It is deliberately NOT a moderation action: no `moderation_action` row,
   * no email, nothing to appeal. `postSelection` renders the stub, and
   * `search.posts` excludes the row outright — the one surface where matching
   * on text the viewer can no longer read would leak it back.
   *
   * The read-then-write is not locked. Instead, the update is a compare-and-set
   * against both tombstones. A racing author delete or moderator removal can
   * win the row first; a zero-row update re-reads that winner and returns the
   * original author tombstone or refuses the moderator tombstone. That is why
   * this needs neither the transaction nor the `FOR UPDATE` every moderation
   * effect takes: there is no audit row to double-write and no email to
   * double-send.
   */
  delete: protectedProcedure
    .use(rateLimit(RATE_LIMITS.write))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ authorId: post.authorId, removedAt: post.removedAt, deletedAt: post.deletedAt })
        .from(post)
        .where(eq(post.id, input.postId))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // Ownership is the whole authorisation rule: moderators take posts down
      // through `moderation.removePost`, which is audited, appealable and
      // reversible. FORBIDDEN rather than NOT_FOUND because the post's
      // existence is not a secret — anyone who can see it in a feed already
      // knows — and "not yours" is the answer that explains the refusal.
      if (target.authorId !== context.user.id) {
        throw new ORPCError("FORBIDDEN", { message: "You can only delete your own posts." });
      }

      // A moderator got there first. Deleting on top would strip the stub of
      // the removal reason and the appeal link the author is owed, and gain
      // them nothing: the content is already hidden from everyone.
      if (target.removedAt) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This post was removed by a moderator and can no longer be deleted.",
        });
      }

      // Idempotent, like `like`/`unlike`: repeating states the same end state,
      // so a double-click or a retry is a no-op that keeps the original
      // tombstone rather than restamping it.
      if (target.deletedAt) {
        return { postId: input.postId, deletedAt: target.deletedAt };
      }

      const [updated] = await context.db
        .update(post)
        .set({ deletedAt: new Date() })
        .where(and(eq(post.id, input.postId), isNull(post.removedAt), isNull(post.deletedAt)))
        .returning({ deletedAt: post.deletedAt });

      if (updated?.deletedAt) {
        return { postId: input.postId, deletedAt: updated.deletedAt };
      }

      // Another writer changed a tombstone after the guard read. PostgreSQL
      // re-evaluates this UPDATE's predicate after waiting on that writer, so
      // no returned row means the winner's committed state decides the result.
      const [winner] = await context.db
        .select({ removedAt: post.removedAt, deletedAt: post.deletedAt })
        .from(post)
        .where(eq(post.id, input.postId))
        .limit(1);

      if (winner?.removedAt) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This post was removed by a moderator and can no longer be deleted.",
        });
      }

      if (winner?.deletedAt) {
        return { postId: input.postId, deletedAt: winner.deletedAt };
      }

      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to delete post." });
    }),

  /**
   * Lists posts, keyset-paginated: the global feed, one author's posts, the
   * following feed, or one post's direct replies. Requires a session, like
   * every procedure in this app (issue #36).
   */
  list: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(POST_PAGE_SIZE_MAX).default(POST_PAGE_SIZE),
        /**
         * Omit for the global feed; set to scope the feed to one author.
         * Composes with `feed` as AND — "posts by X, if I follow X" — which is
         * coherent if degenerate. The UI never sends both.
         */
        authorId: z.string().optional(),
        /**
         * An enum rather than a boolean because this axis will grow (a ranked
         * "for you", lists), and each new value should be a widening here
         * rather than another orthogonal flag with undefined interactions.
         */
        feed: z.enum(["global", "following"]).default("global"),
        /**
         * Set to list one post's direct replies. This is deliberately a mode
         * of `list` rather than its own `post.replies` procedure: the web
         * app's optimistic like sweeps every cached `post.list` query by key
         * prefix (see apps/web/src/lib/post-cache.ts), so a separate
         * procedure would sit outside that sweep and likes on replies would
         * silently stop updating. Sharing the procedure means the reply list
         * inherits the cursor, the feed atom family, and the sweep.
         *
         * Composes with `authorId`/`feed` as AND — "replies to X, by someone
         * I follow" — which is coherent if degenerate. The UI never sends
         * both, same as `authorId` and `feed`.
         */
        parentId: z.uuid().optional(),
        /**
         * Replies are excluded by default, which is what keeps the home
         * timelines top-level only. A profile feed opts in, because a
         * person's profile is their whole activity.
         *
         * An explicit flag rather than inferring it from `authorId` keeps the
         * two axes independent — it is what a "Posts / Replies" tab on the
         * profile would toggle without touching the author filter.
         */
        includeReplies: z.boolean().default(false),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const filters = [
        input.authorId ? eq(post.authorId, input.authorId) : undefined,
        // Three-way, in priority order: an explicit `parentId` asks for one
        // post's replies; `includeReplies` widens a feed to carry them; and
        // the default excludes them. The `is null` branch is what
        // `post_created_idx` is a partial index on, so the global and
        // Following timelines match it exactly.
        input.parentId
          ? eq(post.parentId, input.parentId)
          : input.includeReplies
            ? undefined
            : isNull(post.parentId),
        // A semi-join rather than an INNER JOIN on `follow`: EXISTS cannot
        // duplicate a post row, whereas a join relies on the follow primary
        // key to avoid fanning out — true today, but a weaker statement of
        // intent. It also composes as one more entry in this array.
        //
        // Your own posts are included unconditionally. The composer sits
        // directly above this feed on the home page, and a post that appears
        // to vanish on submit reads as a bug.
        //
        // This walks post_created_idx newest-first and probes the follow
        // primary key per candidate. If it ever shows up slow — the bad case
        // is following very few people relative to global post volume — the
        // rewrite is `author_id = any(array(select following_id ...))`, which
        // follow_follower_created_idx already covers.
        input.feed === "following"
          ? sql`(${post.authorId} = ${viewerId} or exists (
              select 1 from ${follow}
              where ${follow.followingId} = ${post.authorId} and ${follow.followerId} = ${viewerId}
            ))`
          : undefined,
        // The visibility filter (issue #38): posts by a banned author or by
        // someone blocked in either direction drop out of every feed. This
        // does NOT drop removed posts — removal is not invisibility.
        not(invisibleAuthor(viewerId)),
      ];

      // The cursor filter, the hasMore decision and the next-cursor anchor
      // live in keysetPage (./pagination.ts) — the house skeleton every feed
      // shares. The ORDER BY and the +1 lookahead stay here, on the same
      // columns as the cursor comparison.
      const selection = postSelection(viewerId);
      return keysetPage({
        codec: postCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: post.createdAt,
        createdAtField: "createdAt",
        id: post.id,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(post)
            .innerJoin(user, eq(user.id, post.authorId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(post.createdAt), desc(post.id))
            .limit(input.limit + 1),
      });
    }),

  /**
   * One post plus the conversation above it — what `/post/$postId` renders.
   *
   * Two queries rather than one join, on purpose. The recursive CTE walks
   * `parent_id` upward collecting *ids only*, and a second ordinary select
   * turns those into rows through `postSelection`. That split is what lets
   * the ancestors reuse the same projection as every feed — `likeCount`,
   * `replyCount` and `viewerHasLiked` come along for free — instead of a
   * hand-mapped column list inside the CTE that would drift from it.
   *
   * The direct replies are deliberately NOT here: they are paginated, and
   * `post.list({ parentId })` already serves them. Returning a first page of
   * replies here too would give the same rows two cache homes with no way to
   * keep them in step.
   */
  thread: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const [focused] = await context.db
        .select(postSelection(viewerId))
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(viewerId))))
        .limit(1);

      if (!focused) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // The common case by a wide margin: most posts are top-level, and
      // there is no chain to walk for those.
      if (!focused.parentId) {
        return { post: focused, ancestors: [], truncated: false };
      }

      const chain = await context.db.execute<{ id: string; depth: number }>(sql`
        with recursive chain as (
          select ${post.id} as id, ${post.parentId} as parent_id, 0 as depth
          from ${post}
          where ${post.id} = ${sql.param(input.postId, post.id)}
          union all
          select ancestor.id, ancestor.parent_id, chain.depth + 1
          from ${post} as ancestor
          join chain on ancestor.id = chain.parent_id
          where chain.depth < ${THREAD_ANCESTOR_MAX}
        )
        -- depth 0 is the focused post itself, already selected above.
        -- Descending depth puts the root of the conversation first, which is
        -- the order it reads in.
        select id, depth from chain where depth > 0 order by depth desc
      `);

      const ancestorIds = chain.map((row) => row.id);

      // Hidden ancestors are dropped rather than 404ing the thread: the
      // focused post's chain is walked through them, so a blocked middle
      // link must leave a gap, not take the whole conversation down.
      const rows = await context.db
        .select(postSelection(viewerId))
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(inArray(post.id, ancestorIds), not(invisibleAuthor(viewerId))));

      // `inArray` has no ordering of its own, so the CTE's depth ordering is
      // reapplied here rather than trusted from the second query.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ancestors = ancestorIds.map((id) => byId.get(id)).filter((row) => row !== undefined);

      return {
        post: focused,
        ancestors,
        // The root-most ancestor still having a parent means the chain was
        // cut off by THREAD_ANCESTOR_MAX, not that we reached the top. Read
        // off the rows we already have rather than costing another query.
        truncated: ancestors[0]?.parentId != null,
      };
    }),

  /**
   * Likes a post for the caller. Requires a session.
   *
   * `like` and `unlike` are separate, idempotent procedures rather than one
   * `toggle`. A toggle's result depends on the order two in-flight requests
   * happen to arrive in — a double-click can leave the post unliked — and it
   * can't be safely retried. These two state the intended end state, so
   * repeating either is a no-op and matches the optimistic UI update.
   */
  like: protectedProcedure
    .use(rateLimit(RATE_LIMITS.like))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      // The (post_id, user_id) primary key makes the duplicate impossible;
      // this just declines to error on it.
      await context.db
        .insert(postLike)
        .values({ postId: input.postId, userId: context.user.id })
        .onConflictDoNothing();

      return {
        postId: input.postId,
        likeCount: await countLikes(context.db, input.postId),
        viewerHasLiked: true,
      };
    }),

  /** Removes the caller's like from a post. Requires a session; a no-op when the like isn't there. */
  unlike: protectedProcedure
    .use(rateLimit(RATE_LIMITS.like))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(and(eq(post.id, input.postId), not(invisibleAuthor(context.user.id))))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "Post not found." });
      }

      await context.db
        .delete(postLike)
        .where(and(eq(postLike.postId, input.postId), eq(postLike.userId, context.user.id)));

      return {
        postId: input.postId,
        likeCount: await countLikes(context.db, input.postId),
        viewerHasLiked: false,
      };
    }),
};
