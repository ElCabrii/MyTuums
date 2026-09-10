import { and, asc, desc, eq, ilike, isNull, like, not, or, type SQL, sql } from "drizzle-orm";
import { game, post, user } from "@my-tuums/db/schema";
import { z } from "zod";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  SEARCH_PAGE_SIZE,
  SEARCH_PAGE_SIZE_MAX,
  SEARCH_QUERY_MAX_LENGTH,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { gameMentionsFor, matchesGameQuery } from "./games.js";
import { keysetPage } from "./pagination.js";
import { postSelection } from "./posts.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { publicUserColumns, viewerHasRequested, viewerIsFollowing } from "./users.js";
import { invisibleAuthor, privatePostHidden, visibleUser } from "./visibility.js";

/**
 * Search over users and posts, plus the games half of the typeahead (the
 * full games listing lives in `game.list`, public — issue #314).
 *
 * Matching is deliberately cheap rather than clever: a left-anchored `like`
 * on the already-normalised `username` (which can use its unique btree index
 * under C collation), or an `ilike` substring scan on name, displayUsername
 * and post content — a seq scan, fine at this scale. User input is escaped
 * (`escapeLikePattern`) so `%`, `_` and `\` are treated as literals, never as
 * pattern wildcards. Replies are excluded everywhere, mirroring the global
 * feed. Games match on name or hashtag key (issue #314, Q24 — the catalog
 * is ~1000 rows, the cheapest scan in the app). pg_trgm GIN indexes are the
 * documented future upgrade; none of this changes if they land.
 *
 * All procedures require a session, like every procedure in this app except
 * the reviewed public-read set (issue #36).
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
 * the viewer's follow and request flags, so the results page can render a
 * follow button without a second round trip per row. Spreads the same privacy
 * boundary the profile procedures use, so no search result can leak `email`
 * or the auth-reconnaissance columns.
 */
const searchUserSelection = (viewerId: string) => ({
  ...publicUserColumns,
  viewerIsFollowing: viewerIsFollowing(viewerId),
  hasRequested: viewerHasRequested(viewerId),
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
 * Whether a game row matches a free-text query — see `matchesGameQuery` in
 * ./games.ts, the one definition (imported there from here would be a
 * cycle; the typeahead below and `game.list`'s `q` both read it).
 */

/**
 * The `search` procedure group: typeahead, users, posts.
 */
export const searchRouter = {
  /**
   * The header dropdown: up to 5 matching profiles and 3 matching games for
   * a query, no cursor.
   *
   * Users rank an exact username first, then other username prefixes, then
   * substring-only matches. Games rank by the catalog's popularity order.
   * The full results page goes through `users` and `posts` below, and its
   * Games section through the public `game.list`; typing only suggests.
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
          // blocked account never suggests itself in the dropdown. Private
          // accounts stay discoverable — the profile resolves to its locked
          // notice, only their posts stay hidden.
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

      // The catalog is public content with no viewer-relative field, so the
      // games half needs no visibility filter — just the matcher. A tighter
      // cap than users: covers are louder than handles in a dropdown.
      const games = await context.db
        .select({
          slug: game.slug,
          // The composer's tag popover completes `#hashtagKey` (Q4) — the
          // suggestion must carry the key it will write, not just its page.
          hashtagKey: game.hashtagKey,
          name: game.name,
          coverMediaPath: game.coverMediaPath,
          firstReleaseYear: game.firstReleaseYear,
        })
        .from(game)
        .where(matchesGameQuery(input.q))
        .orderBy(sql`coalesce(${game.popularityRank}, 2147483647) asc`, asc(game.igdbId))
        .limit(3);

      // Keep the legacy field until older, already-open SPAs can no longer be
      // served by a rolling deployment. Those clients still read and map
      // `posts`; an empty collection preserves that response contract without
      // putting posts back into the profile-only dropdown.
      return { users, games, posts: [] };
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
        cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
        limit: z.number().int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const filters = [
        matchesUserQuery(input.q),
        // The visibility filter (issue #38): banned and blocked accounts are
        // not search results, same as the typeahead above. Private accounts
        // stay discoverable — only their posts are hidden from non-followers.
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
        fetchPage: (cursorFilter) =>
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
        cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
        limit: z.number().int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE),
      }),
    )
    .handler(async ({ input, context }) => {
      const viewerId = context.user.id;

      const filters = [
        ilike(post.content, containsPattern(input.q)),
        isNull(post.parentId),
        // Neither tombstone is a search result — the one visibility rule
        // search does NOT share with `post.list` (issue #48, extended to
        // author deletions by #148). The feed keeps both as stubs because
        // `postSelection` nulls their content by projection; the WHERE clause
        // here matches the raw `content` column, which no projection touches,
        // so a removed or deleted post's text would stay probeable by anyone
        // who can guess it. The rows themselves must be unreachable: search is
        // the one surface where matching on text the viewer may not read
        // leaks it.
        isNull(post.removedAt),
        isNull(post.deletedAt),
        // The visibility filter (issue #38), same as `post.list`: a banned or
        // blocked author's posts are not search results. Private posts and
        // private-account posts (issue #328) hide the same way.
        not(invisibleAuthor(viewerId)),
        not(privatePostHidden(viewerId)),
      ];

      const selection = postSelection(viewerId);
      const page = await keysetPage({
        codec: searchPostCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: post.createdAt,
        createdAtField: "createdAt",
        id: post.id,
        idField: "id",
        fetchPage: (cursorFilter) =>
          context.db
            .select(selection)
            .from(post)
            .innerJoin(user, eq(user.id, post.authorId))
            .where(and(...filters, cursorFilter))
            .orderBy(desc(post.createdAt), desc(post.id))
            .limit(input.limit + 1),
      });

      // Same per-batch map as the feeds (issue #314, Q16: tags render
      // everywhere, search included).
      const texts = page.items.flatMap((item) => [item.content, item.quoted?.content ?? null]);
      return { ...page, gameMentions: await gameMentionsFor(context.db, texts) };
    }),
};
