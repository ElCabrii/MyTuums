import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postLike, user } from "@my-tuums/db/schema";
import { z } from "zod";
import { POST_MAX_LENGTH, POST_PAGE_SIZE, POST_PAGE_SIZE_MAX } from "./constants.js";
import { protectedProcedure, publicProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * Opaque pagination cursor. Feeds are keyset-paginated on
 * `(created_at, id) DESC` rather than OFFSET: with OFFSET, a post created
 * while someone is scrolling shifts every later row down by one and the
 * reader sees a duplicate. `id` is in the key only to break ties between
 * posts sharing a timestamp, so the ordering is total and no row can be
 * skipped or repeated.
 *
 * It's encoded rather than exposed as `{ createdAt, id }` so callers treat it
 * as opaque and we stay free to change the key later.
 */
const cursorPayloadSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    "base64url",
  );
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
  }

  return { createdAt: new Date(result.data.createdAt), id: result.data.id };
}

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
        /** Omit for the global feed; set to scope the feed to one author. */
        authorId: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.session?.user.id;
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;

      const filters = [
        input.authorId ? eq(post.authorId, input.authorId) : undefined,
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
        nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
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
