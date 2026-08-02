import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { follow, user } from "@my-tuums/db/schema";
import { z } from "zod";
import { FOLLOW_PAGE_SIZE, FOLLOW_PAGE_SIZE_MAX } from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { protectedProcedure, publicProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The public shape of a user — deliberately not `select()`-all.
 *
 * `email` is the reason this is an explicit list: `appRouter.me` returns the
 * caller's own session user and can include it, but this procedure is public
 * and serves *anyone's* profile, so returning the whole row would hand out
 * every user's email address to any unauthenticated caller. Same for
 * `emailVerified` and `updatedAt`, which are nobody else's business.
 *
 * The auth hardening pass added two more columns that must stay out for a
 * sharper reason than privacy: `twoFactorEnabled` and `lastLoginMethod` are
 * reconnaissance. The first tells an attacker which accounts a stolen password
 * would be enough for on its own; the second tells them which provider to
 * phish. Neither is profile data, and a `select()`-all here would publish both.
 *
 * The follower lists below spread this too, so they inherit the same property
 * rather than growing their own projection that could drift from it.
 */
const publicUserColumns = {
  id: user.id,
  name: user.name,
  username: user.username,
  displayUsername: user.displayUsername,
  image: user.image,
  createdAt: user.createdAt,
};

/**
 * Follow counts are derived on read rather than denormalised onto
 * `user.follower_count` columns, for the same reason `likeCount` is in
 * ./posts.ts: a correlated count over an index is cheap at this scale, and it
 * can't drift out of sync the way a counter maintained by the application
 * can. `follow_following_created_idx` and the primary key are what make each
 * of these an index scan rather than a table scan.
 */
const followerCount = sql<number>`(
  select count(*)::int from ${follow} where ${follow.followingId} = ${user.id}
)`;

const followingCount = sql<number>`(
  select count(*)::int from ${follow} where ${follow.followerId} = ${user.id}
)`;

function viewerIsFollowing(viewerId: string | undefined) {
  return viewerId
    ? sql<boolean>`exists (
        select 1 from ${follow}
        where ${follow.followingId} = ${user.id} and ${follow.followerId} = ${viewerId}
      )`
    : sql<boolean>`false`;
}

/**
 * Keyset cursor for the follower lists. Unlike ./posts.ts this is
 * `z.string()`, not `z.uuid()` — a `follow` row has no id of its own, so ties
 * break on the listed user's `user.id`, which is BetterAuth's text format.
 */
const followCursor = createCursorCodec(z.string().min(1));

/**
 * Bounds shared by every handle input here, matching the BetterAuth username
 * plugin's own rules (see packages/auth/src/index.ts) so an obviously-invalid
 * handle is rejected at the edge instead of costing a query.
 */
const usernameInput = z.string().trim().min(3).max(20);

async function countFollowers(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(follow)
    .where(eq(follow.followingId, userId));

  return row?.count ?? 0;
}

/**
 * Resolves a handle to a user id, or throws `NOT_FOUND`.
 *
 * The username plugin stores a normalised (lower-cased) `username` alongside
 * the `displayUsername` the person actually typed, so `/@AlexMercer` and
 * `/@alexmercer` have to resolve to the same profile. Matching on the
 * normalised column is what makes that work — and it keeps the lookup on the
 * unique index rather than forcing a sequential scan the way
 * `lower(username) = ...` would.
 */
async function requireUserIdByUsername(db: Database, username: string): Promise<string> {
  const [found] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, username.toLowerCase()))
    .limit(1);

  if (!found) {
    throw new ORPCError("NOT_FOUND", { message: "No such user." });
  }

  return found.id;
}

export const userRouter = {
  byUsername: publicProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ username: usernameInput }))
    .handler(async ({ input, context }) => {
      const [found] = await context.db
        .select({
          ...publicUserColumns,
          followerCount,
          followingCount,
          viewerIsFollowing: viewerIsFollowing(context.session?.user.id),
        })
        .from(user)
        .where(eq(user.username, input.username.toLowerCase()))
        .limit(1);

      if (!found) {
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      return found;
    }),

  // `follow` and `unfollow` are separate, idempotent procedures rather than
  // one `toggle`, for the same reason `post.like`/`unlike` are: a toggle's
  // result depends on the order two in-flight requests happen to arrive in —
  // a double-click can leave you unfollowed — and it can't be safely retried.
  follow: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(z.object({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      // Checked before the existence query so the caller gets a readable 400.
      // The `follow_not_self` CHECK constraint is still the actual invariant
      // (see packages/db/src/schema/app.ts) — without this guard it would
      // surface as an unexplained INTERNAL_SERVER_ERROR instead.
      if (input.userId === context.user.id) {
        throw new ORPCError("BAD_REQUEST", { message: "You can't follow yourself." });
      }

      const [target] = await context.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      // The (follower_id, following_id) primary key makes the duplicate
      // impossible; this just declines to error on it.
      await context.db
        .insert(follow)
        .values({ followerId: context.user.id, followingId: input.userId })
        .onConflictDoNothing();

      return {
        userId: input.userId,
        followerCount: await countFollowers(context.db, input.userId),
        viewerIsFollowing: true,
      };
    }),

  // Deliberately *not* symmetric with `follow`'s self-check: "I do not follow
  // myself" is an end state that is already true, so unfollowing yourself is a
  // legitimate no-op. Following yourself is an end state the schema forbids,
  // which is a genuine bad request.
  unfollow: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(z.object({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);

      if (!target) {
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      await context.db
        .delete(follow)
        .where(
          and(eq(follow.followerId, context.user.id), eq(follow.followingId, input.userId)),
        );

      return {
        userId: input.userId,
        followerCount: await countFollowers(context.db, input.userId),
        viewerIsFollowing: false,
      };
    }),

  // Both lists take a `username` rather than a user id so a list page can fire
  // its two queries — the profile header and the list itself — in parallel,
  // instead of waiting on `byUsername` to learn an id it would then pass here.
  followers: publicProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        username: usernameInput,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(FOLLOW_PAGE_SIZE_MAX).default(FOLLOW_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const targetId = await requireUserIdByUsername(context.db, input.username);
      const cursor = input.cursor ? followCursor.decode(input.cursor) : undefined;

      const filters = [
        eq(follow.followingId, targetId),
        // Row-value comparison against the same (created_at, follower_id) DESC
        // ordering `follow_following_created_idx` provides, so Postgres seeks
        // straight to the cursor position. The bound values must go through
        // `sql.param` with their column as the encoder — interpolating the
        // Date directly hands postgres.js a value it cannot serialise.
        cursor
          ? sql`(${follow.createdAt}, ${follow.followerId}) < (${sql.param(cursor.createdAt, follow.createdAt)}, ${sql.param(cursor.id, follow.followerId)})`
          : undefined,
      ].filter((f) => f !== undefined);

      const rows = await context.db
        .select({
          ...publicUserColumns,
          followedAt: follow.createdAt,
          viewerIsFollowing: viewerIsFollowing(context.session?.user.id),
        })
        .from(follow)
        // The join is on follower_id: these are the people following the
        // target. `following` below joins the other column — that one line is
        // the whole difference between the two procedures.
        .innerJoin(user, eq(user.id, follow.followerId))
        .where(and(...filters))
        .orderBy(desc(follow.createdAt), desc(follow.followerId))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);

      return {
        items,
        nextCursor: hasMore && last ? followCursor.encode(last.followedAt, last.id) : null,
      };
    }),

  following: publicProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        username: usernameInput,
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(FOLLOW_PAGE_SIZE_MAX).default(FOLLOW_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const targetId = await requireUserIdByUsername(context.db, input.username);
      const cursor = input.cursor ? followCursor.decode(input.cursor) : undefined;

      const filters = [
        eq(follow.followerId, targetId),
        // Note the tie-breaker is `following_id` here, matching both the
        // ORDER BY below and `follow_follower_created_idx`. Copying the
        // `followers` predicate without swapping this column yields a cursor
        // that only misbehaves when two rows share a timestamp.
        cursor
          ? sql`(${follow.createdAt}, ${follow.followingId}) < (${sql.param(cursor.createdAt, follow.createdAt)}, ${sql.param(cursor.id, follow.followingId)})`
          : undefined,
      ].filter((f) => f !== undefined);

      const rows = await context.db
        .select({
          ...publicUserColumns,
          followedAt: follow.createdAt,
          viewerIsFollowing: viewerIsFollowing(context.session?.user.id),
        })
        .from(follow)
        .innerJoin(user, eq(user.id, follow.followingId))
        .where(and(...filters))
        .orderBy(desc(follow.createdAt), desc(follow.followingId))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items.at(-1);

      return {
        items,
        nextCursor: hasMore && last ? followCursor.encode(last.followedAt, last.id) : null,
      };
    }),
};
