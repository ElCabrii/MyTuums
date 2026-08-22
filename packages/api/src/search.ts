import { and, desc, eq, ilike, isNull, like, not, or, sql } from "drizzle-orm";
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
 * The `search` procedure group: typeahead, users, posts.
 */
export const searchRouter = {
  /**
   * The header dropdown: up to 5 matching profiles for a query, no cursor.
   *
   * Users rank username prefix matches ahead of substring-only matches, which
   * is what makes "al" suggest the person actually called al over everyone
   * whose name merely contains "al". The full results page goes through
   * `users` and `posts` below; typing only suggests profiles.
   */
  typeahead: protectedProcedure
    .use(rateLimit(RATE_LIMITS.search))
    .input(z.object({ q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH) }))
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;
      const prefix = prefixPattern(input.q);
      const contains = containsPattern(input.q);

      const users = await context.db
        .select(searchUserSelection(viewerId))
        .from(user)
        .where(
          // Same visibility filter as the full results page: a banned or
          // blocked account never suggests itself in the dropdown.
          and(
            visibleUser(viewerId),
            or(
              like(user.username, prefix),
              ilike(user.name, contains),
              ilike(user.displayUsername, contains),
            ),
          ),
        )
        .orderBy(
          // The CASE expression is the whole ranking rule: a prefix match on
          // the normalised username ranks above any substring-only match, no
          // matter how new the latter is. The timestamp + id tie-breakers are
          // what the dropdown sees within each rank.
          sql`case when ${user.username} like ${prefix} then 0 else 1 end`,
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
        or(
          like(user.username, prefixPattern(input.q)),
          ilike(user.name, containsPattern(input.q)),
          ilike(user.displayUsername, containsPattern(input.q)),
        ),
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
