import { sql } from "drizzle-orm";
import { post, user, userBlock } from "@my-tuums/db/schema";

/**
 * The visibility predicate (issue #38): the one filter every surface applies
 * so no view of a user or their posts can drift from another's.
 *
 * Two ideas compose it. A banned account — `effectivelyBanned` — is hidden
 * everywhere it can appear: feeds, search, follow lists. An expired ban is
 * not effective, because better-auth clears the columns at the next
 * sign-in anyway and the predicate should not outlive the sentence. And a
 * block — either direction, because `user_block` severs follows on both
 * sides at creation — hides the two users from each other entirely.
 *
 * Removed posts are deliberately NOT covered here. Visibility is about
 * *who*, not *what*: a removed post is a real event that stays in feeds as
 * a stub (P4 writes the tombstone; `postSelection` renders the stub), and
 * hiding it would make removals look like deletions.
 */

/**
 * True when the `user` row an outer query is over carries a ban that is
 * currently in force. The one exception to "hidden": `users.byUsername`
 * returns such a user with `suspended: true` instead of 404, so the
 * profile page can render a stub rather than an existence leak.
 *
 * Composed raw rather than through drizzle's `or`/`not` helpers so the
 * fragments here are exactly `SQL<boolean>` — drizzle's combinators return
 * `SQL | undefined`, which nothing downstream accepts.
 */
export const effectivelyBanned = sql<boolean>`(
  ${user.banned} and (${user.banExpires} is null or ${user.banExpires} > now())
)`;

/**
 * True when the author of the `post` row an outer query is over must be
 * hidden from the viewer: banned, blocked by the viewer, or blocking the
 * viewer. Remove this from a query and the row becomes visible to people
 * it must not be.
 */
export function invisibleAuthor(viewerId: string) {
  return sql<boolean>`(
    ${effectivelyBanned}
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${post.authorId} and ${userBlock.blockedId} = ${viewerId}
    )
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${viewerId} and ${userBlock.blockedId} = ${post.authorId}
    )
  )`;
}

/**
 * True when the `user` row an outer query is over is blocked by the viewer
 * or blocks the viewer — the block half of visibility, without the ban.
 * `users.byUsername` filters on this alone so a banned (but not blocked)
 * profile still resolves to its stub.
 */
export function invisibleUser(viewerId: string) {
  return sql<boolean>`(
    exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${user.id} and ${userBlock.blockedId} = ${viewerId}
    )
    or exists (
      select 1 from ${userBlock}
      where ${userBlock.blockerId} = ${viewerId} and ${userBlock.blockedId} = ${user.id}
    )
  )`;
}

/**
 * The full user-list filter: an active ban hides, a block in either
 * direction hides. One entry in every user list's filters array (search,
 * typeahead, follower lists).
 */
export function visibleUser(viewerId: string) {
  return sql<boolean>`(not ${effectivelyBanned} and not ${invisibleUser(viewerId)})`;
}
