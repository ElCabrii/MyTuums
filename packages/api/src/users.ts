import { ORPCError } from "@orpc/server";
import { and, desc, eq, not, or, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { follow, user, userBadge, userBlock } from "@my-tuums/db/schema";
import { normalizeUsername, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "@my-tuums/auth/rules";
import { z } from "zod";
import { displayProfileBadges, followerBadgeTierFor } from "./badges.js";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  FOLLOW_PAGE_SIZE,
  FOLLOW_PAGE_SIZE_MAX,
  IMAGE_KINDS,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { insertNotification } from "./notifications.js";
import { keysetPage } from "./pagination.js";
import { acceptImage, type ImageRejection } from "./image.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { acquireRelationshipLock } from "./relationship-lock.js";
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

/**
 * The stamped badges an account carries — its `user_badge` rows, every family
 * included (see packages/api/src/badges.ts for who stamps what). The composite
 * primary key makes this an index scan; an account has at most a handful of
 * rows.
 */
const stampedBadges = sql<string[]>`coalesce((
  select array_agg(${userBadge.badge}) from ${userBadge} where ${userBadge.userId} = ${user.id}
), '{}'::text[])`;

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

async function countFollowers(db: Pick<Database, "select">, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(follow)
    .where(eq(follow.followingId, userId));

  return row?.count ?? 0;
}

/**
 * Resolves a handle to the owner of a follower/following graph, or throws
 * `NOT_FOUND`.
 *
 * The username plugin stores both handle columns in canonical lowercase, so
 * `/@AlexMercer` and `/@alexmercer` have to resolve to the same profile.
 * Matching a normalised input against the stored column keeps the lookup on
 * the unique index rather than forcing a sequential scan with
 * `lower(username) = ...`.
 *
 * The visibility half is the point (finding 4): a block in either direction
 * reads as a missing handle — the same NOT_FOUND `byUsername` gives — so a
 * blocking account's graph cannot be traversed by the very person it hides
 * from. Without this filter the lookup returned the id and the caller's query
 * confirmed the account exists and enumerated its visible members, leaking
 * exactly what the block is supposed to hide. A banned target is returned
 * rather than hidden, flagged by the same `effectivelyBanned` predicate the
 * profile stub reads, so the caller can redact the graph to match the stub's
 * zeroed counts instead of the 404 a blocked target gets.
 */
async function resolveGraphTarget(
  db: Database,
  username: string,
  viewerId: string,
): Promise<{ id: string; suspended: boolean }> {
  const [found] = await db
    .select({ id: user.id, suspended: effectivelyBanned })
    .from(user)
    .where(and(eq(user.username, normalizeUsername(username)), not(invisibleUser(viewerId))))
    .limit(1);

  if (!found) {
    throw new ORPCError("NOT_FOUND", { message: "No such user." });
  }

  return found;
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
  type: "That image format isn't supported. Use a PNG, JPEG, WebP or GIF.",
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
   * shape is `publicUserColumns` plus computed fields, never the whole row.
   *
   * `badges` (issue #308) crosses the `publicUserColumns` privacy boundary
   * deliberately: badges are public profile data, like follower counts — an
   * earned distinction displayed to every visitor. It is selected at read
   * time from the stamped `user_badge` rows (see ./badges.ts for who stamps
   * what), never a stored profile column, so widening that boundary by a
   * column still fails the shape pin in users.int.test.ts.
   */
  byUsername: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ username: usernameInput }))
    .handler(async ({ input, context }) => {
      // A profile blocked in either direction reads as nonexistent — the
      // same "no such user" as a missing handle, so the block doesn't leak
      // that the profile exists. A banned profile still resolves so the page
      // can render a stub, but authored fields and relationship state are
      // redacted before they cross the procedure boundary.
      const [found] = await context.db
        .select({
          ...publicUserColumns,
          followerCount,
          followingCount,
          viewerIsFollowing: viewerIsFollowing(context.user.id),
          suspended: effectivelyBanned,
          stampedBadges,
        })
        .from(user)
        .where(
          and(
            eq(user.username, normalizeUsername(input.username)),
            not(invisibleUser(context.user.id)),
          ),
        )
        .limit(1);

      if (!found) {
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      // The raw rows never cross the boundary — `badges` is the public
      // shape: the display set in canonical order (follower tier, like
      // tier, founder, super-early, early), computed by the one catalog
      // definition the browser shares (./badges.ts).
      const { stampedBadges: stamped, ...profile } = found;

      if (profile.suspended) {
        return {
          ...profile,
          name: profile.username ?? "",
          image: null,
          bio: null,
          bannerImage: null,
          followerCount: 0,
          followingCount: 0,
          viewerIsFollowing: false,
          // Authored-field redaction applies to badges like everything else
          // (issue #308): a suspended profile displays none of them.
          badges: [],
        };
      }

      return {
        ...profile,
        badges: displayProfileBadges({ stampedBadgeIds: stamped }),
      };
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

      // The block check and the insert run under the pair's relationship lock,
      // in one transaction. Unlocked, they are a TOCTOU: a `block` committing
      // between them severs the existing follows and then this insert puts a
      // new edge back, leaving a prohibited follow standing behind the block
      // that reappears the moment the block is lifted. `block` and `unblock`
      // take the same lock, so the two operations are serialized per pair
      // rather than per table — which is the only place the invariant can be
      // enforced, since the edges live in two tables no constraint spans.
      await context.db.transaction(async (tx) => {
        await acquireRelationshipLock(tx, context.user.id, input.userId);

        // A block in either direction makes the follow a bad request, not a
        // silent no-op: the block severing follows is the P4 `block`
        // procedure, and a follow that quietly did nothing would read as
        // broken UI. A blocked account's profile is already invisible, so this
        // guard is what stops a direct follow attempt after the block.
        const [block] = await tx
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
        // impossible; this just declines to error on it. `.returning()` is
        // empty exactly when it swallowed a duplicate, so the notification
        // below mints only on the follow that actually landed — a retried
        // follow never double-notifies, and follow → unfollow → follow again
        // is honestly three events, not one collapsed.
        const inserted = await tx
          .insert(follow)
          .values({ followerId: context.user.id, followingId: input.userId })
          .onConflictDoNothing()
          .returning({ followerId: follow.followerId });

        if (inserted.length > 0) {
          await insertNotification(tx, {
            recipientId: input.userId,
            actorId: context.user.id,
            type: "follow",
          });

          // Follower-tier badge stamping (issue #308), the exact shape of
          // the like-tier stamping in ./posts.ts. A follow that actually
          // landed is the only moment a threshold can first be passed, so
          // the cost is one index-only count per new follow and nothing
          // anywhere else — a retried follow never reaches this branch. The
          // count read and the stamp ride the follow's own transaction, so
          // a rollback leaves neither half; `onConflictDoNothing` against
          // the (user, badge) primary key keeps a threshold re-crossed
          // after a recede (followers unfollowing and the count climbing
          // back) at exactly one row. `unfollow` never unstamps: the tier
          // was genuinely reached.
          const badge = followerBadgeTierFor(await countFollowers(tx, input.userId));
          if (badge) {
            await tx
              .insert(userBadge)
              .values({ userId: input.userId, badge })
              .onConflictDoNothing();
          }
        }
      });

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
        cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
        limit: z.number().int().min(1).max(FOLLOW_PAGE_SIZE_MAX).default(FOLLOW_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const target = await resolveGraphTarget(context.db, input.username, context.user.id);

      // A banned target's graph is redacted to an empty page — the same
      // answer `byUsername`'s stub gives when it zeros the counts, so the
      // list cannot disagree with the profile that opened it about how many
      // members exist. The `visibleUser` filter below then has no target
      // rows to run over, which is the point: nothing about a suspended
      // account's graph crosses the boundary.
      if (target.suspended) {
        return { items: [], nextCursor: null };
      }

      const filters = [
        eq(follow.followingId, target.id),
        // A user you can't see (or who can't see you) is not a follower to
        // list — the member-side half of visibility; the target-side half is
        // `resolveGraphTarget` above.
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
        fetchPage: (cursorFilter) =>
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
        cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
        limit: z.number().int().min(1).max(FOLLOW_PAGE_SIZE_MAX).default(FOLLOW_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const target = await resolveGraphTarget(context.db, input.username, context.user.id);

      // Same redaction as `followers`: a banned target's graph is an empty
      // page, matching the stub its profile renders.
      if (target.suspended) {
        return { items: [], nextCursor: null };
      }

      const filters = [
        eq(follow.followerId, target.id),
        // Same member-side filter as `followers`, which is what keeps the
        // two lists symmetric.
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
        fetchPage: (cursorFilter) =>
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
