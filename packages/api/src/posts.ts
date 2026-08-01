import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { follow, post, postLike, user } from "@my-tuums/db/schema";
import { z } from "zod";
import { POST_MAX_LENGTH, POST_PAGE_SIZE, POST_PAGE_SIZE_MAX } from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { protectedProcedure, publicProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

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

function viewerHasLiked(viewerId: string | undefined) {
  return viewerId
    ? sql<boolean>`exists (
        select 1 from ${postLike}
        where ${postLike.postId} = ${post.id} and ${postLike.userId} = ${viewerId}
      )`
    : sql<boolean>`false`;
}

const postSelection = (viewerId: string | undefined) => ({
  id: post.id,
  content: post.content,
  createdAt: post.createdAt,
  author: {
    id: user.id,
    name: user.name,
    username: user.username,
    displayUsername: user.displayUsername,
    image: user.image,
  },
  likeCount,
  viewerHasLiked: viewerHasLiked(viewerId),
});

async function countLikes(db: Database, postId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postLike)
    .where(eq(postLike.postId, postId));

  return row?.count ?? 0;
}

export const postRouter = {
  create: protectedProcedure
    .use(rateLimit(RATE_LIMITS.write))
    .input(
      z.object({
        // Trim first so a body of only whitespace fails `min(1)` rather than
        // being stored as an empty-looking post.
        content: z.string().trim().min(1, "Post cannot be empty.").max(POST_MAX_LENGTH),
      }),
    )
    .handler(async ({ input, context }) => {
      const [created] = await context.db
        .insert(post)
        .values({ authorId: context.user.id, content: input.content })
        .returning({ id: post.id, content: post.content, createdAt: post.createdAt });

      if (!created) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to create post." });
      }

      return {
        ...created,
        author: {
          id: context.user.id,
          name: context.user.name,
          username: context.user.username ?? null,
          displayUsername: context.user.displayUsername ?? null,
          image: context.user.image ?? null,
        },
        likeCount: 0,
        viewerHasLiked: false,
      };
    }),

  list: publicProcedure
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
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.session?.user.id;

      // This stays a `publicProcedure` because the global feed *is* the
      // signed-out home page; promoting the whole procedure would break it.
      if (input.feed === "following" && !viewerId) {
        throw new ORPCError("UNAUTHORIZED", { message: "Sign in to see your Following feed." });
      }

      const cursor = input.cursor ? postCursor.decode(input.cursor) : undefined;

      const filters = [
        input.authorId ? eq(post.authorId, input.authorId) : undefined,
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
        input.feed === "following" && viewerId
          ? sql`(${post.authorId} = ${viewerId} or exists (
              select 1 from ${follow}
              where ${follow.followingId} = ${post.authorId} and ${follow.followerId} = ${viewerId}
            ))`
          : undefined,
        // Row-value comparison: strictly "older than the cursor" under the
        // same (created_at DESC, id DESC) ordering `post_created_idx`
        // provides, so Postgres can seek straight to the cursor position.
        //
        // The bound values must go through `sql.param` with their column as
        // the encoder. Interpolating them directly hands postgres.js a raw
        // JS `Date`, which it cannot serialise — `mapToDriverValue` on the
        // column is what turns it into the ISO string Postgres expects.
        cursor
          ? sql`(${post.createdAt}, ${post.id}) < (${sql.param(cursor.createdAt, post.createdAt)}, ${sql.param(cursor.id, post.id)})`
          : undefined,
      ].filter((f) => f !== undefined);

      // One row beyond the page, purely to learn whether another page exists
      // without a second COUNT query. It's dropped before returning.
      const rows = await context.db
        .select(postSelection(viewerId))
        .from(post)
        .innerJoin(user, eq(user.id, post.authorId))
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(post.createdAt), desc(post.id))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);

      return {
        items,
        nextCursor: hasMore && last ? postCursor.encode(last.createdAt, last.id) : null,
      };
    }),

  // `like` and `unlike` are separate, idempotent procedures rather than one
  // `toggle`. A toggle's result depends on the order two in-flight requests
  // happen to arrive in — a double-click can leave the post unliked — and it
  // can't be safely retried. These two state the intended end state, so
  // repeating either is a no-op and matches the optimistic UI update.
  like: protectedProcedure
    .use(rateLimit(RATE_LIMITS.like))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .where(eq(post.id, input.postId))
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

  unlike: protectedProcedure
    .use(rateLimit(RATE_LIMITS.like))
    .input(z.object({ postId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: post.id })
        .from(post)
        .where(eq(post.id, input.postId))
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
