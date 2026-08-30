import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { moderationAction, notification, post, user } from "@my-tuums/db/schema";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_PAGE_SIZE_MAX,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { effectivelyBanned, invisibleUser } from "./visibility.js";

/**
 * The notification surface (issue #259): the one place a like, reply, follow
 * or moderation action leaves an in-app trace for its recipient, and the
 * procedures that read it back.
 *
 * Writes never happen here — they ride the cause's own transaction at each
 * call site (`post.like`, `post.create`, `user.follow`, `logAction`), through
 * {@link insertNotification}. This module owns the read side: the
 * newest-first keyset list, the unread count, and the mark-all-read stamp.
 */

/**
 * The four notification type codes — the `notification.type` check
 * constraint's list (packages/db/src/schema/app.ts).
 *
 * Server-side only, unlike the moderation action codes in `./constants.ts`:
 * the web app receives `type` as a string in the response payload and its
 * type flows from the inferred router contract, so the browser never needs
 * the list at runtime.
 */
export const NOTIFICATION_TYPES = ["like", "reply", "follow", "moderation"] as const;

/** One of the four notification type codes. */
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

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
 */
export async function insertNotification(
  db: Pick<Database, "insert">,
  args: {
    recipientId: string;
    /** Null for moderation rows — the notice is from MyTuums, like the email. */
    actorId: string | null;
    type: NotificationType;
    /** The like's post, or the reply itself. Required for `like`/`reply`. */
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

/** The `notification` procedure group: list, unreadCount, markRead. */
export const notificationRouter = {
  /**
   * Pages the caller's notifications, newest first. Requires a session.
   *
   * No grouping, ranking or "while you were away" — newest first is the whole
   * order, keyset-paginated on the same skeleton as the feeds. Each row
   * carries its actor's public summary (null for moderation), the post it is
   * about when it is a like or reply, and the mirrored moderation action when
   * it is one, so the page renders without a second round trip per row.
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
      const selection = {
        id: notification.id,
        type: notification.type,
        read: sql<boolean>`${notification.readAt} is not null`,
        createdAt: notification.createdAt,
        postId: notification.postId,
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
        query: (cursorFilter) =>
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
            .where(
              and(
                eq(notification.recipientId, context.user.id),
                visibleNotification(context.user.id),
                cursorFilter,
              ),
            )
            .orderBy(desc(notification.createdAt), desc(notification.id))
            .limit(input.limit + 1),
      });
    }),

  /**
   * How many notifications the caller has not read — the header badge.
   *
   * Counts through the same visibility predicate as `list`, deliberately: a
   * badge number the page behind it cannot reconcile (an actor the recipient
   * blocked after the event, a post the author deleted) would click through
   * to a list that never clears it.
   */
  unreadCount: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({}))
    .handler(async ({ context }) => {
      const [row] = await context.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notification)
        .leftJoin(user, eq(user.id, notification.actorId))
        .leftJoin(post, eq(post.id, notification.postId))
        .where(
          and(
            eq(notification.recipientId, context.user.id),
            isNull(notification.readAt),
            visibleNotification(context.user.id),
          ),
        );

      return { unreadCount: row?.count ?? 0 };
    }),

  /**
   * Marks every one of the caller's unread notifications read. Requires a
   * session; idempotent — repeating it states the same end state.
   *
   * All-of-them rather than per-row on purpose: the unread state is "things
   * the page has shown you", and the page shows a list, not a single row.
   * Invisible rows are stamped too — read state is bookkeeping, not display,
   * and leaving an unread row the list refuses to render would pin the badge
   * at a number nothing can clear.
   */
  markRead: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(z.object({}))
    .handler(async ({ context }) => {
      const rows = await context.db
        .update(notification)
        .set({ readAt: new Date() })
        .where(and(eq(notification.recipientId, context.user.id), isNull(notification.readAt)))
        .returning({ id: notification.id });

      return { read: rows.length };
    }),
};
