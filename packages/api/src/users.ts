import { ORPCError } from "@orpc/server";
import { and, desc, eq, not, or, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { follow, user, userBlock } from "@my-tuums/db/schema";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@my-tuums/auth/rules";
import { z } from "zod";
import { FOLLOW_PAGE_SIZE, FOLLOW_PAGE_SIZE_MAX, IMAGE_KINDS } from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";
import { acceptImage, type ImageRejection } from "./image.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { replaceProfileMedia, removeProfileMedia, requireStorage } from "./profile-media.js";
import { effectivelyBanned, invisibleUser, visibleUser } from "./visibility.js";

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
 * `themePreference` and `localePreference` stay out on the same principle,
 * one step milder: they are settings, not profile. Nobody visiting a profile
 * needs to know which theme its owner prefers, and publishing them would make
 * the list mean "every column we happened to add" rather than "what a profile
 * page renders".
 *
 * `bio` and `bannerImage` ARE in, because they are exactly that — the things a
 * profile page renders for a visitor.
 *
 * The follower lists below spread this too, so they inherit the same property
 * rather than growing their own projection that could drift from it.
 */
export const publicUserColumns = {
  id: user.id,
  name: user.name,
  username: user.username,
  displayUsername: user.displayUsername,
  image: user.image,
  bio: user.bio,
  bannerImage: user.bannerImage,
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

export function viewerIsFollowing(viewerId: string) {
  return sql<boolean>`exists (
    select 1 from ${follow}
    where ${follow.followingId} = ${user.id} and ${follow.followerId} = ${viewerId}
  )`;
}

/**
 * Keyset cursor for the follower lists. Unlike ./posts.ts this is
 * `z.string()`, not `z.uuid()` — a `follow` row has no id of its own, so ties
 * break on the listed user's `user.id`, which is BetterAuth's text format.
 */
const followCursor = createCursorCodec(z.string().min(1));

/**
 * Bounds shared by every handle input here, read from the one account-rule
 * module (`@my-tuums/auth/rules`) that the BetterAuth username plugin and both
 * handle forms also read — so an obviously-invalid handle is rejected at the
 * edge instead of costing a query, and the edge cannot come to disagree with
 * what the plugin will accept.
 */
const usernameInput = z.string().trim().min(USERNAME_MIN_LENGTH).max(USERNAME_MAX_LENGTH);

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

/**
 * The messages an upload can be refused with.
 *
 * English literals, matching the arrangement `packages/auth/src/dob.ts`
 * established: the web app's `localizeAuthError` maps the ones it recognises to
 * translated copy at the render boundary and passes anything else through, so
 * these must stay byte-identical with the entries in
 * `apps/web/src/lib/auth-error-message.ts`.
 *
 * "content" deliberately does not explain *how* the bytes disagreed with the
 * declared type. A caller probing what the sniffer accepts learns nothing from
 * it, and a legitimate user is served by the same advice either way.
 */
const IMAGE_REJECTIONS = {
  type: "That image format isn't supported. Use a PNG, JPEG or WebP.",
  size: "That image is too large.",
  content: "That file doesn't look like an image.",
} satisfies Record<ImageRejection, string>;

/**
 * The `user` procedure group: byUsername, uploadImage, removeImage, follow,
 * unfollow, followers, following.
 */
export const userRouter = {
  /**
   * Returns one user's public profile by handle. Requires a session; the
   * shape is `publicUserColumns`, never the whole row.
   */
  byUsername: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ username: usernameInput }))
    .handler(async ({ input, context }) => {
      // A profile blocked in either direction reads as nonexistent — the
      // same "no such user" as a missing handle, so the block doesn't leak
      // that the profile exists. A banned profile DOES resolve, carrying
      // `suspended: true` (additive — `publicUserColumns` is untouched): the
      // profile page renders a stub instead of an existence leak.
      const [found] = await context.db
        .select({
          ...publicUserColumns,
          followerCount,
          followingCount,
          viewerIsFollowing: viewerIsFollowing(context.user.id),
          suspended: effectivelyBanned,
        })
        .from(user)
        .where(
          and(eq(user.username, input.username.toLowerCase()), not(invisibleUser(context.user.id))),
        )
        .limit(1);

      if (!found) {
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      return found;
    }),

  /**
   * Replaces the caller's avatar or banner.
   *
   * One upload carries TWO objects: the untouched original and the small
   * display object feeds render (see ./image.ts for why the two exist and how
   * they are bounded). Both bytes come through oRPC as real `File`s — its RPC
   * protocol serialises them as multipart automatically, so this needs no
   * base64 hop and no hand-rolled body parsing on the server.
   *
   * The row is written with Drizzle rather than through `auth.api.updateUser`,
   * and that is deliberate: `packages/auth/src/profile.ts` refuses any
   * hook-visible write of a `/media/` path precisely so that a client cannot
   * set one directly. Drizzle bypasses Better Auth's hooks, which makes this
   * procedure the single writer of these columns — and the session, not the
   * key, is what decides whose row is touched.
   *
   * The lifecycle itself — key minting, the locked row swap, the best-effort
   * cleanup of the replaced pair — lives in `./profile-media.ts`, shared with
   * `removeImage` so the ordering cannot drift between the two.
   */
  uploadImage: protectedProcedure
    .use(rateLimit(RATE_LIMITS.upload))
    .input(z.object({ kind: z.enum(IMAGE_KINDS), original: z.file(), display: z.file() }))
    .handler(async ({ input, context }) => {
      const storage = requireStorage(context);

      // Neither file is trusted to be what the client says it is, and the two
      // are checked against different rules: the display object must fit the
      // slot's display bounds because it is what every feed renders, while the
      // original is bounded by megapixels because it is served from a public
      // path. See ./image.ts. The accepted verdict carries the sniffed type —
      // the one that gets stored, never the declared one.
      const originalBytes = new Uint8Array(await input.original.arrayBuffer());
      const originalVerdict = acceptImage(
        originalBytes,
        input.original.type,
        input.kind,
        "original",
      );
      if (!originalVerdict.ok || !originalVerdict.type) {
        throw new ORPCError("BAD_REQUEST", {
          message: IMAGE_REJECTIONS[originalVerdict.reason ?? "type"],
        });
      }

      const displayBytes = new Uint8Array(await input.display.arrayBuffer());
      const displayVerdict = acceptImage(displayBytes, input.display.type, input.kind, "display");
      if (!displayVerdict.ok || !displayVerdict.type) {
        throw new ORPCError("BAD_REQUEST", {
          message: IMAGE_REJECTIONS[displayVerdict.reason ?? "type"],
        });
      }

      return replaceProfileMedia(context.db, storage, context.user.id, {
        kind: input.kind,
        displayBytes,
        displayType: displayVerdict.type,
        originalBytes,
        originalType: originalVerdict.type,
      });
    }),

  /** Clears one image slot and deletes both objects behind it, if they were ours. */
  removeImage: protectedProcedure
    .use(rateLimit(RATE_LIMITS.upload))
    .input(z.object({ kind: z.enum(IMAGE_KINDS) }))
    .handler(async ({ input, context }) => {
      const storage = requireStorage(context);

      return removeProfileMedia(context.db, storage, context.user.id, input.kind);
    }),

  /**
   * Follows a user. Requires a session.
   *
   * `follow` and `unfollow` are separate, idempotent procedures rather than
   * one `toggle`, for the same reason `post.like`/`unlike` are: a toggle's
   * result depends on the order two in-flight requests happen to arrive in —
   * a double-click can leave you unfollowed — and it can't be safely retried.
   */
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

      // A block in either direction makes the follow a bad request, not a
      // silent no-op: the block severing follows is the P4 `block` procedure,
      // and a follow that quietly did nothing would read as broken UI. A
      // blocked account's profile is already invisible, so this guard is
      // what stops a direct follow attempt after the block.
      const [block] = await context.db
        .select({ id: userBlock.blockerId })
        .from(userBlock)
        .where(
          or(
            and(eq(userBlock.blockerId, context.user.id), eq(userBlock.blockedId, input.userId)),
            and(eq(userBlock.blockerId, input.userId), eq(userBlock.blockedId, context.user.id)),
          ),
        )
        .limit(1);

      if (block) {
        throw new ORPCError("BAD_REQUEST", { message: "You can't follow this user." });
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

  /**
   * Unfollows a user. Requires a session.
   *
   * Deliberately *not* symmetric with `follow`'s self-check: "I do not follow
   * myself" is an end state that is already true, so unfollowing yourself is a
   * legitimate no-op. Following yourself is an end state the schema forbids,
   * which is a genuine bad request.
   */
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
        .where(and(eq(follow.followerId, context.user.id), eq(follow.followingId, input.userId)));

      return {
        userId: input.userId,
        followerCount: await countFollowers(context.db, input.userId),
        viewerIsFollowing: false,
      };
    }),

  /**
   * Pages a user's followers, newest first. Requires a session.
   *
   * Both lists take a `username` rather than a user id so a list page can fire
   * its two queries — the profile header and the list itself — in parallel,
   * instead of waiting on `byUsername` to learn an id it would then pass here.
   */
  followers: protectedProcedure
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

      const filters = [
        eq(follow.followingId, targetId),
        // Banned and blocked accounts drop out of the list — a follower you
        // can't see (or who can't see you) is not a follower to list.
        visibleUser(context.user.id),
      ];

      const selection = {
        ...publicUserColumns,
        followedAt: follow.createdAt,
        viewerIsFollowing: viewerIsFollowing(context.user.id),
      };
      return keysetPage({
        codec: followCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: follow.createdAt,
        createdAtField: "followedAt",
        id: follow.followerId,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(follow)
            // The join is on follower_id: these are the people following the
            // target. `following` below joins the other column — that one line
            // is the whole difference between the two procedures.
            .innerJoin(user, eq(user.id, follow.followerId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(follow.createdAt), desc(follow.followerId))
            .limit(input.limit + 1),
      });
    }),

  /** Pages the users a person follows, newest first. Requires a session. Same `username`-keyed contract as `followers`. */
  following: protectedProcedure
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

      const filters = [
        eq(follow.followerId, targetId),
        // Banned and blocked accounts drop out of the list — same filter as
        // `followers`, which is what keeps the two lists symmetric.
        visibleUser(context.user.id),
      ];

      const selection = {
        ...publicUserColumns,
        followedAt: follow.createdAt,
        viewerIsFollowing: viewerIsFollowing(context.user.id),
      };
      return keysetPage({
        codec: followCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: follow.createdAt,
        createdAtField: "followedAt",
        // The tie-breaker is `following_id` here, matching both the ORDER BY
        // below and `follow_follower_created_idx`. Copying the `followers`
        // call without swapping this column yields a cursor that only
        // misbehaves when two rows share a timestamp.
        id: follow.followingId,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(follow)
            .innerJoin(user, eq(user.id, follow.followingId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(follow.createdAt), desc(follow.followingId))
            .limit(input.limit + 1),
      });
    }),
};
