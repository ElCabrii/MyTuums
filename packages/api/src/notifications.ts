import { ORPCError } from "@orpc/server";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import {
  moderationAction,
  notification,
  notificationLastSeen,
  post,
  user,
} from "@my-tuums/db/schema";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_PAGE_SIZE_MAX,
  NOTIFICATION_RETENTION_DAYS,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";
import { postAttachmentsSelection, type PostAttachment } from "./post-media.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { effectivelyBanned, invisibleUser, privatePostHidden } from "./visibility.js";

/**
 * The notification surface (issue #259): the one place a like, reply,
 * repost, quote, follow or moderation action leaves an in-app trace for its
 * recipient, and the procedures that read it back.
 *
 * Writes never happen here — they ride the cause's own transaction at each
 * call site (`post.like`, `post.repost`, `post.create`, `user.follow`,
 * `logAction`), through
 * {@link insertNotification}. This module owns the read side: the
 * newest-first keyset list, the damped unread count, and the mark-read
 * cursor stamp.
 */

/**
 * The seven notification type codes — the `notification.type` check
 * constraint's list (packages/db/src/schema/app.ts).
 *
 * Server-side only, unlike the moderation action codes in `./constants.ts`:
 * the web app receives `type` as a string in the response payload and its
 * type flows from the inferred router contract, so the browser never needs
 * the list at runtime.
 */
export const NOTIFICATION_TYPES = [
  "like",
  "reply",
  "repost",
  "quote",
  "follow",
  "follow_request",
  "moderation",
] as const;

/** One of the seven notification type codes. */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * How long a same-type burst from one actor stays badge-silent, in seconds.
 * `unreadCount` collapses user-caused rows to one tick per actor, type and
 * minute bucket, so like → unlike → like cycling cannot pump the badge faster
 * than one tick per actor-minute. Different types from one actor are different
 * signals and each ticks — a like, a reply and a follow are three things, not
 * one. Moderation rows are never damped: null-actor system notices, each
 * individually meaningful, arriving rarely enough that throttling them would
 * only ever hide real news.
 *
 * The damper counts ticks; it never rewrites read state. Every row lands
 * unread and renders unread on the page — the page is the truth of what the
 * recipient has seen, the badge is a summary. Bucketing by clock minute (not
 * a trailing window from each row) is the same best-effort deal: two same-type
 * likes straddling a bucket boundary can tick twice.
 */
const BURST_WINDOW_SECONDS = 60;

/**
 * Mints one notification row — the single writer-side entry point.
 *
 * Called inside the transaction that writes the cause, so the pair commits or
 * rolls back together. The caller owns exactly-once: it calls this only when
 * the cause row was newly inserted (like, follow) or on the guarded path that
 * already guarantees one audit row (moderation, via `logAction`).
 *
 * Self-caused events are skipped here rather than left to each caller: the
 * `notification_not_self` check constraint would reject the insert and take
 * the whole cause transaction down with it, so the guard has to sit in front
 * of the write, and having it in one place is what keeps a new call site from
 * forgetting it.
 *
 * The mint itself is unconditional — no damper here. Read state is the
 * recipient's `notification_last_seen` cursor, and a row nobody has seen is
 * never anything but unread; `notification.unreadCount` is where a burst
 * collapses, so damping can never make history lie about what was shown.
 */
export async function insertNotification(
  db: Pick<Database, "insert">,
  args: {
    recipientId: string;
    /** Null for moderation rows — the notice is from MyTuums, like the email. */
    actorId: string | null;
    type: NotificationType;
    /**
     * The like's or repost's post, or the reply/quote itself. Required for
     * `like`/`reply`/`repost`/`quote`.
     */
    postId?: string;
    /** The mirrored audit action. Required for `moderation`. */
    actionId?: string;
  },
): Promise<void> {
  if (args.actorId !== null && args.actorId === args.recipientId) return;
  await db.insert(notification).values({
    recipientId: args.recipientId,
    actorId: args.actorId,
    type: args.type,
    postId: args.postId ?? null,
    actionId: args.actionId ?? null,
  });
}

/**
 * Feeds are keyset-paginated on `(notification.created_at, notification.id)`
 * DESC; see ./cursor.ts for the encoding. A uuid id, so a cursor minted here
 * validates nowhere else.
 */
const notificationCursor = createCursorCodec(z.uuid());

/**
 * The retention horizon shared by the list and the badge: older user-caused
 * rows are not served and not counted, so the two can never disagree about
 * what still exists. The rows themselves are pruned on the same boundary
 * (see `scripts/prune-notifications.ts`). Moderation rows are exempt on both
 * sides — they are rare, individually meaningful, and mirror an audit row
 * that lives forever.
 */
function withinRetention() {
  return sql`(
    ${notification.type} = 'moderation'
    or ${notification.createdAt} > now() - make_interval(days => ${NOTIFICATION_RETENTION_DAYS})
  )`;
}

/**
 * What the recipient is allowed to see of their own list — one predicate,
 * applied identically by the list and the unread count so the badge can never
 * disagree with the page it opens.
 *
 * - Moderation rows always show: they are system notices (null actor), and
 *   the block/ban filters below cannot evaluate an actor that does not exist.
 * - Every other row shows only while its actor is visible to the recipient —
 *   the same `effectivelyBanned` + block-either-direction rule every other
 *   surface applies, so a user blocked by the recipient (or banned) stops
 *   appearing here exactly when they stop appearing everywhere else. A null
 *   actor on a user-caused row (the account was hard-deleted; the FK is
 *   set-null) reads as not-visible, which is this half's equivalent of the
 *   cascade the moderation rows' survival forbids the column to carry.
 * - A row about a post the post's author has since deleted is tombstoned out,
 *   the same way the reply feed and the reply count drop author-deleted rows:
 *   the notification survives, the read does not surface it.
 */
function visibleNotification(viewerId: string) {
  return sql`(
    ${notification.type} = 'moderation'
    or (not ${effectivelyBanned} and not ${invisibleUser(viewerId)})
  ) and (${notification.postId} is null or ${post.deletedAt} is null)`;
}

/**
 * The rows the badge counts: the visible, retained, unread ones — collapsed
 * to one tick per user-caused `(actor, type, minute-bucket)` by the
 * `count(distinct (...))` below. Swapping the first composite slot to the row
 * id for moderation and follow-request rows makes each of them distinct,
 * which is the "never damped" rule expressed in the same expression: a
 * follow request is actionable (issue #328) and must tick even in a burst,
 * like a moderation notice. The distinct row comparison treats nulls as
 * equal, so like/reply/follow rows from one actor collapse exactly as
 * intended.
 */
const BURST_BUCKET_SECONDS = sql`floor(extract(epoch from ${notification.createdAt}) / ${BURST_WINDOW_SECONDS})`;
const badgeTickKey = sql`(
  case when ${notification.type} in ('moderation', 'follow_request') then ${notification.id} end,
  ${notification.actorId},
  ${notification.type},
  ${BURST_BUCKET_SECONDS}
)`;

/** The `notification` procedure group: list, unreadCount, markRead, delete, clearAll. */
export const notificationRouter = {
  /**
   * Pages the caller's notifications, newest first. Requires a session.
   *
   * No grouping, ranking or "while you were away" — newest first is the whole
   * order, keyset-paginated on the same skeleton as the feeds. Each row
   * carries its actor's public summary (null for moderation), the post it is
   * about when it is a like or reply — content and attachments included, so
   * the page can preview it — and the mirrored moderation action when it is
   * one, so the page renders without a second round trip per row.
   */
  list: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(NOTIFICATION_PAGE_SIZE_MAX)
          .default(NOTIFICATION_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      // The moderation action's target post, aliased away from the row's own
      // `post_id` join: a `post_removed` notice links to the removed post
      // only while that post still exists for the recipient to look at.
      const targetPost = alias(post, "target_post");
      const selection = {
        id: notification.id,
        type: notification.type,
        read: sql<boolean>`${notificationLastSeen.seenAt} is not null and ${notification.createdAt} <= ${notificationLastSeen.seenAt}`,
        createdAt: notification.createdAt,
        postId: notification.postId,
        // The post's own words and images, previewed under the row's sentence
        // (issue #281). `postId` already points at the right row per type —
        // the reply itself for a reply, the liked post for a like — so the
        // existing join is all the preview needs. Content follows
        // `postSelection`'s tombstone rule: a moderator-removed post previews
        // nothing (and its attachments fall away with it), while an
        // author-deleted post never reaches the page at all — the visibility
        // predicate above tombstones the row. Null/empty on follow and
        // moderation rows, whose `post_id` is null.
        //
        // A private post (issue #328) previews nothing either: its row still
        // surfaces — the recipient should know someone replied — but the text
        // and images redact. Here `user` is the actor and `post` the
        // notified-about post, and for reply/quote rows the actor IS the post
        // author, so `privatePostHidden` evaluates correctly; like/repost rows
        // name the recipient's own post and correctly do not redact.
        postContent: sql<string | null>`case
          when ${post.removedAt} is not null or ${post.deletedAt} is not null then null
          when ${privatePostHidden(context.user.id)} then null
          else ${post.content}
        end`,
        postAttachments: sql<PostAttachment[]>`case
          when ${privatePostHidden(context.user.id)} then '[]'::jsonb
          else ${postAttachmentsSelection()}
        end`,
        actor: {
          id: user.id,
          name: user.name,
          username: user.username,
          displayUsername: user.displayUsername,
          image: user.image,
        },
        action: {
          code: moderationAction.action,
          reason: moderationAction.reason,
          targetType: moderationAction.targetType,
          targetPostId: moderationAction.targetPostId,
          targetUserId: moderationAction.targetUserId,
        },
        // The moderation action's target post, joined separately from the
        // row's own `post_id`: it stays null on like/reply rows and tells
        // the page whether a `post_removed` notice still has a post to
        // link to. Top-level on purpose — nesting the aliased column inside
        // `action` breaks drizzle's "the joined object is nullable"
        // inference, and a moderation-shaped object that TypeScript cannot
        // deny on a like row is a lie the page would pay for.
        targetPostDeletedAt: targetPost.deletedAt,
      };
      return keysetPage({
        codec: notificationCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: notification.createdAt,
        createdAtField: "createdAt",
        id: notification.id,
        idField: "id",
        fetchPage: (cursorFilter) =>
          context.db
            .select(selection)
            .from(notification)
            // Left joins on purpose: the actor is null on moderation rows,
            // the action null on like/reply/follow rows. A visibility
            // predicate written against the actor columns then excludes
            // exactly the null-actor user-caused rows (see
            // `visibleNotification`) without a separate branch.
            .leftJoin(user, eq(user.id, notification.actorId))
            .leftJoin(moderationAction, eq(moderationAction.id, notification.actionId))
            .leftJoin(post, eq(post.id, notification.postId))
            .leftJoin(targetPost, eq(targetPost.id, moderationAction.targetPostId))
            // The recipient's read cursor: absent means never opened the
            // page, everything unread.
            .leftJoin(
              notificationLastSeen,
              eq(notificationLastSeen.recipientId, notification.recipientId),
            )
            .where(
              and(
                eq(notification.recipientId, context.user.id),
                visibleNotification(context.user.id),
                withinRetention(),
                cursorFilter,
              ),
            )
            .orderBy(desc(notification.createdAt), desc(notification.id))
            .limit(input.limit + 1),
      });
    }),

  /**
   * How many badge ticks the caller owes — the header bell.
   *
   * Counts through the same visibility predicate and retention horizon as
   * `list`, deliberately: a badge number the page behind it cannot reconcile
   * (an actor the recipient blocked after the event, a post the author
   * deleted, a row aged past retention) would click through to a list that
   * never clears it. Within that set the count collapses same-type bursts
   * from one actor to one tick per minute (see `BURST_WINDOW_SECONDS`), so it
   * can read *lower* than the page's unread rows — never higher, and zero
   * exactly when there is nothing unread to show.
   */
  unreadCount: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({}))
    .handler(async ({ context }) => {
      const [row] = await context.db
        .select({
          count: sql<number>`count(distinct ${badgeTickKey})::int`,
        })
        .from(notification)
        .leftJoin(user, eq(user.id, notification.actorId))
        .leftJoin(post, eq(post.id, notification.postId))
        .leftJoin(
          notificationLastSeen,
          eq(notificationLastSeen.recipientId, notification.recipientId),
        )
        .where(
          and(
            eq(notification.recipientId, context.user.id),
            // Unread against the recipient's cursor: no cursor yet means
            // nothing has been seen.
            sql`(${notificationLastSeen.seenAt} is null or ${notification.createdAt} > ${notificationLastSeen.seenAt})`,
            visibleNotification(context.user.id),
            withinRetention(),
          ),
        );

      return { unreadCount: row?.count ?? 0 };
    }),

  /**
   * Advances the caller's read cursor to now — "opening the page is what
   * read means". Requires a session; idempotent, and O(1): one upsert on
   * `notification_last_seen` rather than a stamp per unread row, so a
   * recipient with thousands of unread notifications pays the same as one
   * with none. The cursor only ever moves forward — see the stamp below.
   *
   * Rows that arrive after the stamp are unread by definition — the cursor
   * comparison, not a row rewrite, decides. The returned count is the number
   * of rows the stamp made read (read against the *previous* cursor), all of
   * them, including any the visibility predicate hides: like the old
   * stamp-everything behaviour, read state is bookkeeping, not display.
   */
  markRead: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(z.object({}))
    .handler(async ({ context }) => {
      const stamped = await context.db.transaction(async (tx) => {
        const [previous] = await tx
          .select({ seenAt: notificationLastSeen.seenAt })
          .from(notificationLastSeen)
          .where(eq(notificationLastSeen.recipientId, context.user.id));
        // The DB clock, not `new Date()`: `created_at` is stamped by the
        // database, and a cursor minted from the app clock on a host that
        // drifts ahead of it would silently read rows minted afterwards.
        // The stamp is monotonic on top of that: `now()` reads the
        // transaction's start time, so two concurrent page opens that
        // commit out of order would otherwise leave the older stamp as the
        // cursor and resurrect rows the newer one had already read.
        await tx
          .insert(notificationLastSeen)
          .values({ recipientId: context.user.id, seenAt: sql`now()` })
          .onConflictDoUpdate({
            target: notificationLastSeen.recipientId,
            set: { seenAt: sql`greatest(${notificationLastSeen.seenAt}, now())` },
          });
        return previous?.seenAt ?? null;
      });

      const [row] = await context.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notification)
        .where(
          and(
            eq(notification.recipientId, context.user.id),
            stamped === null ? sql`true` : gt(notification.createdAt, stamped),
          ),
        );

      return { read: row?.count ?? 0 };
    }),

  /**
   * Deletes one of the caller's own notifications (issue #330).
   *
   * The row is the recipient's private inbox entry — deleting it affects no
   * other user and no audit trail, unlike a moderation action row. The
   * `and(id, recipientId)` predicate is the authorization: a row belonging
   * to someone else reads as missing, so no existence oracle leaks across
   * accounts. Deleting an unread row shrinks the badge through the same
   * `unreadCount` query the header already reads — no cursor rewrite needed,
   * the row is simply gone from the counted set.
   */
  delete: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context }) => {
      const deleted = await context.db
        .delete(notification)
        .where(and(eq(notification.id, input.id), eq(notification.recipientId, context.user.id)))
        .returning({ id: notification.id });

      if (deleted.length === 0) throw new ORPCError("NOT_FOUND");
      return { success: true as const, id: input.id };
    }),

  /**
   * Deletes every notification the caller owns (issue #330) — the inbox's
   * "Clear all". One statement, no cursor involved: the read cursor
   * (`notification_last_seen`) is left untouched, since a row that no longer
   * exists needs no read state and a future row must still land unread.
   */
  clearAll: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(z.object({}))
    .handler(async ({ context }) => {
      const deleted = await context.db
        .delete(notification)
        .where(eq(notification.recipientId, context.user.id))
        .returning({ id: notification.id });

      return { deletedCount: deleted.length };
    }),
};
