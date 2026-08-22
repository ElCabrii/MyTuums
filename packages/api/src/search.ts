import { and, desc, eq, ilike, isNull, like, not, or, type SQL, sql } from "drizzle-orm";
import { post, user } from "@my-tuums/db/schema";
import { z } from "zod";
import { SEARCH_PAGE_SIZE, SEARCH_PAGE_SIZE_MAX, SEARCH_QUERY_MAX_LENGTH } from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { keysetPage } from "./pagination.js";
import { postSelection } from "./posts.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { publicUserColumns, viewerIsFollowing } from "./users.js";
import { invisibleAuthor, visibleUser } from "./visibility.js";

/**
 * Search over users and posts.
 *
 * Matching is deliberately cheap rather than clever: a left-anchored `like`
 * on the already-normalised `username` (which can use its unique btree index
 * under C collation), or an `ilike` substring scan on name, displayUsername
 * and post content — a seq scan, fine at this scale. User input is escaped
 * (`escapeLikePattern`) so `%`, `_` and `\` are treated as literals, never as
 * pattern wildcards. Replies are excluded everywhere, mirroring the global
 * feed. pg_trgm GIN indexes are the documented future upgrade; none of this
 * changes if they land.
 *
 * All three procedures require a session, like every procedure in this app
 * (issue #36).
 */

/**
 * Escapes the LIKE metacharacters in a search query so the caller's `%`, `_`
 * and `\` match literally instead of acting as pattern wildcards.
 *
 * `\` is escaped FIRST because it is LIKE's own escape character: replacing
 * it first means the backslashes this function adds for `%`/`_` are not
 * themselves escaped again, and a user-supplied backslash that preceded a
 * wildcard stays a single literal backslash ahead of the now-literal wildcard.
 * Everything else — including multi-byte text — passes through untouched.
 */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Keyset cursor for `search.users`. The id half is `z.string()`, not a uuid,
 * for the same reason as `followCursor` in ./users.ts: users tie-break on
 * `user.id`, which is BetterAuth's text format.
 */
const searchUserCursor = createCursorCodec(z.string().min(1));

/**
 * Keyset cursor for `search.posts` — `post.id` is a uuid, so a cursor minted
 * here won't validate anywhere else, exactly like `postCursor` in ./posts.ts.
 */
const searchPostCursor = createCursorCodec(z.uuid());

/**
 * The projection search results read users through: `publicUserColumns` plus
 * the viewer's follow flag, so the results page can render a follow button
 * without a second round trip per row. Spreads the same privacy boundary the
 * profile procedures use, so no search result can leak `email` or the
 * auth-reconnaissance columns.
 */
const searchUserSelection = (viewerId: string) => ({
  ...publicUserColumns,
  viewerIsFollowing: viewerIsFollowing(viewerId),
});

/**
 * LIKE pattern for a left-anchored username match. `username` is already
 * normalised to lowercase by the BetterAuth plugin, so the pattern is
 * lowercased here and matched with case-sensitive `like` — never wrapped in
 * `lower()` in SQL, which would guarantee the unique index can't be used.
 */
const prefixPattern = (pattern: string) => `${escapeLikePattern(pattern).toLowerCase()}%`;

/** LIKE pattern for a case-insensitive substring match on name, displayUsername and content. */
const containsPattern = (pattern: string) => `%${escapeLikePattern(pattern)}%`;

/**
 * Whether a user row matches a free-text query — the app's one definition of
 * "this account is the one you typed": a left-anchored match on the
 * normalised `username`, or a case-insensitive substring of either display
 * field. The typeahead, the results page and the moderation team's account
 * lookup all match on exactly this, so widening what counts as a match (a
 * third column, trigram similarity) lands on all three at once instead of
 * drifting between them.
 */
export function matchesUserQuery(q: string): SQL | undefined {
  return or(
    like(user.username, prefixPattern(q)),
    ilike(user.name, containsPattern(q)),
    ilike(user.displayUsername, containsPattern(q)),
  );
}

/**
 * Ranks a matched user row: 0 for an exact handle, 1 for any other handle
 * prefix, 2 for a substring-only match — the leading `orderBy` term on the
 * two bounded lookup surfaces that use relevance ordering.
 *
 * This is what makes "al" offer the person actually called al ahead of
 * everyone whose display name merely contains it. It is a rank, not a total
 * order: each caller adds its own tie-breakers behind it.
 */
export function userQueryRank(q: string): SQL<number> {
  const prefix = prefixPattern(q);
  return sql`case
    when ${user.username} = ${q.toLowerCase()} then 0
    when ${user.username} like ${prefix} then 1
    else 2
  end`;
}

/**
 * The `search` procedure group: typeahead, users, posts.
 */
export const searchRouter = {
  /**
   * The header dropdown: up to 5 matching profiles for a query, no cursor.
   *
   * Users rank an exact username first, then other username prefixes, then
   * substring-only matches. The full results page goes through `users` and
   * `posts` below; typing only suggests profiles.
   */
  typeahead: protectedProcedure
    .use(rateLimit(RATE_LIMITS.search))
    .input(z.object({ q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH) }))
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const users = await context.db
        .select(searchUserSelection(viewerId))
        .from(user)
        .where(
          // Same visibility filter as the full results page: a banned or
          // blocked account never suggests itself in the dropdown.
          and(visibleUser(viewerId), matchesUserQuery(input.q)),
        )
        .orderBy(
          // An exact normalised username ranks above longer prefixes, and
          // both rank above substring-only matches. The timestamp + id
          // tie-breakers are what the dropdown sees within each rank.
          userQueryRank(input.q),
          desc(user.createdAt),
          desc(user.id),
        )
        .limit(5);

      // Keep the legacy field until older, already-open SPAs can no longer be
      // served by a rolling deployment. Those clients still read and map
      // `posts`; an empty collection preserves that response contract without
      // putting posts back into the profile-only dropdown.
      return { users, posts: [] };
    }),

  /**
   * Pages users matching a query, newest first, keyset-paginated like every
   * other list in this package.
   *
   * The cursor is `(created_at, id) DESC` — the house total order, not
   * relevance: keyset pagination requires a total order, and relevance-ranked
   * cursors are out of scope. This is what lets the results page walk the
   * matches without dupes or skips.
   */
  users: protectedProcedure
    .use(rateLimit(RATE_LIMITS.search))
    .input(
      z.object({
        q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const filters = [
        matchesUserQuery(input.q),
        // The visibility filter (issue #38): banned and blocked accounts are
        // not search results, same as the typeahead above.
        visibleUser(viewerId),
      ];

      const selection = searchUserSelection(viewerId);
      return keysetPage({
        codec: searchUserCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: user.createdAt,
        createdAtField: "createdAt",
        id: user.id,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(user)
            .where(and(...filters, cursorFilter))
            .orderBy(desc(user.createdAt), desc(user.id))
            .limit(input.limit + 1),
      });
    }),

  /**
   * Pages posts matching a query, newest first, keyset-paginated — the same
   * +1 lookahead skeleton as `post.list`. Replies are excluded, mirroring the
   * global feed.
   */
  posts: protectedProcedure
    .use(rateLimit(RATE_LIMITS.search))
    .input(
      z.object({
        q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const filters = [
        ilike(post.content, containsPattern(input.q)),
        isNull(post.parentId),
        // Removed posts are not search results — the one visibility rule
        // search does NOT share with `post.list` (issue #48). The feed keeps
        // a removed post as a stub because `postSelection` nulls its content
        // by projection; the WHERE clause here matches the raw `content`
        // column, which no projection touches, so a removed post's text
        // would stay probeable by anyone who can guess it. The row itself
        // must be unreachable: search is the one surface where matching on
        // text the viewer may not read leaks it.
        isNull(post.removedAt),
        // The visibility filter (issue #38), same as `post.list`: a banned or
        // blocked author's posts are not search results.
        not(invisibleAuthor(viewerId)),
      ];

      const selection = postSelection(viewerId);
      return keysetPage({
        codec: searchPostCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: post.createdAt,
        createdAtField: "createdAt",
        id: post.id,
        idField: "id",
        query: (cursorFilter) =>
          context.db
            .select(selection)
            .from(post)
            .innerJoin(user, eq(user.id, post.authorId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(post.createdAt), desc(post.id))
            .limit(input.limit + 1),
      });
    }),
};
