import { sql } from "drizzle-orm";
import { follow, post, user, userBlock } from "@my-tuums/db/schema";

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
 * it must not.
 *
 * `viewerId` may be `null` — the anonymous post-permalink reader (0.4.0). A
 * NULL viewer id compares equal to no block row, so an anonymous reader is
 * hidden from exactly the same banned authors a fresh signed-in reader is,
 * and from no blocks at all (blocks are relationships between two accounts).
 */
export function invisibleAuthor(viewerId: string | null) {
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
 * profile still resolves to its stub. `viewerId` may be `null` for the
 * anonymous reader, who has no block relationships by definition.
 */
export function invisibleUser(viewerId: string | null) {
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
 * typeahead, follower lists). `viewerId` may be `null` — see
 * `invisibleUser` for what that means.
 */
export function visibleUser(viewerId: string | null) {
  return sql<boolean>`(not ${effectivelyBanned} and not ${invisibleUser(viewerId)})`;
}

/**
 * True when the `post` row an outer query is over is private to the viewer
 * (issue #328) and must be hidden: the post itself is followers-only, or its
 * author has a private account — and the viewer is neither the author nor an
 * approved follower.
 *
 * Null `user.is_private` (pre-privacy rows) reads as public: `is true` is
 * false for null, so no backfill can lock anyone out. A null viewer (the
 * anonymous permalink reader) sees every private row as hidden — there is no
 * anonymous follower.
 *
 * Bound to the un-aliased `post`/`user` tables like `invisibleAuthor`; the
 * authored feed arm joins both, so this composes as one more entry in its
 * filter array. Moderators get no bypass here — moderation surfaces read
 * through their own case/appeal procedures, and feeds stay viewer-shaped.
 */
export function privatePostHidden(viewerId: string | null) {
  if (viewerId === null) {
    return sql<boolean>`(
      ${user.isPrivate} is true or ${post.isPrivate} is true
    )`;
  }
  return sql<boolean>`(
    (${user.isPrivate} is true or ${post.isPrivate} is true)
    and ${post.authorId} <> ${viewerId}
    and not exists (
      select 1 from ${follow}
      where ${follow.followerId} = ${viewerId} and ${follow.followingId} = ${post.authorId}
    )
  )`;
}

/**
 * True when the `user` row an outer query is over is a private account the
 * viewer may not enumerate (issue #328): `isPrivate` set, viewer neither the
 * account nor an approved follower. Null reads as public, like above.
 *
 * User lists (search, typeahead, followers/following) AND this with
 * `visibleUser`; profile and post surfaces use `privatePostHidden` instead,
 * which also covers the per-post flag.
 */
export function privateUserHidden(viewerId: string | null) {
  if (viewerId === null) {
    return sql<boolean>`${user.isPrivate} is true`;
  }
  return sql<boolean>`(
    ${user.isPrivate} is true
    and ${user.id} <> ${viewerId}
    and not exists (
      select 1 from ${follow}
      where ${follow.followerId} = ${viewerId} and ${follow.followingId} = ${user.id}
    )
  )`;
}
