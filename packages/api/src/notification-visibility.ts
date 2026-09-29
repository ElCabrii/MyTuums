import { sql } from "drizzle-orm";
import { notification, post } from "@my-tuums/db/schema";
import { effectivelyBanned, invisibleUser } from "./visibility.js";

/**
 * What the recipient is allowed to see of their own list — one predicate,
 * applied identically by the list and the unread count so the badge can never
 * disagree with the page it opens. Background push shares this predicate;
 * callers must join the actor and post tables.
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
export function visibleNotification(viewerId: string) {
  return sql`(
    ${notification.type} in ('moderation', 'video_failed')
    or (not ${effectivelyBanned} and not ${invisibleUser(viewerId)})
  ) and (${notification.postId} is null or ${post.deletedAt} is null)`;
}
