import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { follow, user } from "@my-tuums/db/schema";
import { z } from "zod";
import {
  FOLLOW_PAGE_SIZE,
  FOLLOW_PAGE_SIZE_MAX,
  IMAGE_KINDS,
  type ImageKind,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import {
  acceptImage,
  imageObjectKey,
  mediaPathFor,
  objectKeyFromMediaPath,
  type ImageRejection,
} from "./image.js";
import { protectedProcedure, publicProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import type { Storage } from "./storage.js";

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
const publicUserColumns = {
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
const IMAGE_REJECTIONS: Record<ImageRejection, string> = {
  type: "That image format isn't supported. Use a PNG, JPEG or WebP.",
  size: "That image is too large.",
  content: "That file doesn't look like an image.",
};

/**
 * Narrows `context.storage` at the one boundary that needs a bucket.
 *
 * A deployment with no `S3_*` group is a supported configuration (see
 * `context.ts`), so this is a runtime state to report rather than an invariant
 * to assert. `NOT_IMPLEMENTED` rather than `INTERNAL_SERVER_ERROR` because
 * nothing is broken — the feature simply isn't configured here, and saying so
 * is more useful than a 500 that looks like a bug.
 */
function requireStorage(context: { storage: Storage | null }): Storage {
  if (!context.storage) {
    throw new ORPCError("NOT_IMPLEMENTED", {
      message: "Image uploads aren't configured on this server.",
    });
  }
  return context.storage;
}

/**
 * Points one image slot's two columns (display + original) at new values and
 * hands back what they held before.
 *
 * In a transaction with `SELECT ... FOR UPDATE`, which is not ceremony. The
 * previous values cannot come from `RETURNING` — that reports the row *after*
 * the update — so they have to be read first, and two bare statements would
 * race: two uploads landing together could both read the same old keys, both
 * delete them, and leave the objects the loser stored orphaned while the
 * winner's row points at keys that were never removed. The row lock makes the
 * read-then-write one step, which is exactly what "replace" means here.
 */
async function setImageColumns(
  db: Database,
  userId: string,
  kind: ImageKind,
  values: { display: string | null; original: string | null },
): Promise<{ display: string | null; original: string | null }> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        image: user.image,
        bannerImage: user.bannerImage,
        imageOriginal: user.imageOriginal,
        bannerImageOriginal: user.bannerImageOriginal,
      })
      .from(user)
      .where(eq(user.id, userId))
      .for("update")
      .limit(1);

    if (!current) return { display: null, original: null };

    await tx
      .update(user)
      .set(
        kind === "avatar"
          ? { image: values.display, imageOriginal: values.original }
          : { bannerImage: values.display, bannerImageOriginal: values.original },
      )
      .where(eq(user.id, userId));

    return kind === "avatar"
      ? { display: current.image, original: current.imageOriginal }
      : { display: current.bannerImage, original: current.bannerImageOriginal };
  });
}

/**
 * Deletes the objects behind stored paths, when they were ours.
 *
 * An OAuth provider's absolute avatar URL is not ours to delete, and
 * `objectKeyFromMediaPath` returns `null` for it. A failure here is swallowed
 * on purpose: the user's profile is already correct, and turning a successful
 * upload into an error because a stale object could not be reaped would be the
 * wrong trade.
 *
 * The cost of that trade is that objects leak on the paths where the row write
 * fails after the objects are stored, or where this delete errors. Nothing
 * reconciles them on the request path; `packages/api/scripts/reconcile-media.mjs`
 * is the reaper, and its existence is part of why swallowing here is safe.
 */
async function discardPrevious(
  storage: Storage,
  previous: { display: string | null; original: string | null },
): Promise<void> {
  for (const value of [previous.display, previous.original]) {
    const key = objectKeyFromMediaPath(value);
    if (!key) continue;

    try {
      await storage.remove(key);
    } catch (error) {
      console.error("Failed to delete replaced image object", key, error);
    }
  }
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
      // path. See ./image.ts.
      const originalBytes = new Uint8Array(await input.original.arrayBuffer());
      const originalVerdict = acceptImage(originalBytes, input.original.type, input.kind, "original");
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

      // One uuid for both objects, so the pair is obvious in the bucket —
      // `<uuid>.webp` and `<uuid>.orig.jpg` (see imageObjectKey).
      const id = randomUUID();
      const displayKey = imageObjectKey(input.kind, context.user.id, displayVerdict.type, "display", id);
      const originalKey = imageObjectKey(input.kind, context.user.id, originalVerdict.type, "original", id);

      await storage.put(displayKey, displayBytes, displayVerdict.type);
      await storage.put(originalKey, originalBytes, originalVerdict.type);

      const path = mediaPathFor(displayKey);
      const originalPath = mediaPathFor(originalKey);
      const previous = await setImageColumns(context.db, context.user.id, input.kind, {
        display: path,
        original: originalPath,
      });

      // After the row points at the new objects, never before: if this throws,
      // the profile still renders correctly and all that leaks is orphaned
      // objects. Deleting first would risk a blank avatar on a failed update.
      await discardPrevious(storage, previous);

      return { kind: input.kind, url: path, originalUrl: originalPath };
    }),

  /** Clears one image slot and deletes both objects behind it, if they were ours. */
  removeImage: protectedProcedure
    .use(rateLimit(RATE_LIMITS.upload))
    .input(z.object({ kind: z.enum(IMAGE_KINDS) }))
    .handler(async ({ input, context }) => {
      const storage = requireStorage(context);

      const previous = await setImageColumns(context.db, context.user.id, input.kind, {
        display: null,
        original: null,
      });
      await discardPrevious(storage, previous);

      return { kind: input.kind, url: null };
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
