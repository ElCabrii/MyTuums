import { and, asc, desc, ilike, or, sql, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Database } from "@my-tuums/db";
import { game, gameFavorite } from "@my-tuums/db/schema";
import { z } from "zod";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  GAME_SLUG_MAX_LENGTH,
  GAMES_PAGE_SIZE,
  GAMES_PAGE_SIZE_MAX,
  SEARCH_QUERY_MAX_LENGTH,
} from "./constants.js";
import { createGameCursorCodec, type GameSort } from "./cursor.js";
import { publicRateLimit, publicReadProcedure } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The public game directory (issue #314, stage 2): the catalog reads behind
 * `/games` and `/games/{slug}`.
 *
 * Both procedures build from `publicReadProcedure` — the session-optional
 * surface the anonymous post permalink opened (0.4.0), and deliberately the
 * same reviewed boundary: `/games` is the app's second public page family
 * (issue Q6), so the crawler shell, the anonymous reader and the signed-in
 * one all land here. `viewerHasFavoritedGame` treats a missing viewer the
 * way every viewer probe does — a NULL user id matches no favorite row.
 *
 * The favorites themselves are written by the stage-3 procedures; until
 * then `favoriteCount` counts the table directly (the count is public by
 * design, issue Q26 — the deliberate divergence from bookmarks' no-count
 * rule) and the probe answers `false` for everyone.
 */

/**
 * Whether the viewer has favorited this game — the favorite pair's viewer
 * probe, the exact shape of `viewerHasBookmarked` in ./posts.ts. Public
 * unlike it: the showcase, not the private shelf (issue Q26).
 */
function viewerHasFavoritedGame(viewerId: string | null) {
  return sql<boolean>`exists (
    select 1 from ${gameFavorite}
    where ${gameFavorite.gameId} = ${game.igdbId} and ${gameFavorite.userId} = ${viewerId}
  )`;
}

/** The game page's whole read: the catalog row plus the favorite state. */
const gamePageSelection = (viewerId: string | null) => ({
  slug: game.slug,
  name: game.name,
  summary: game.summary,
  coverMediaPath: game.coverMediaPath,
  firstReleaseYear: game.firstReleaseYear,
  genres: game.genres,
  platforms: game.platforms,
  favoriteCount: sql<number>`(
    select count(*)::int from ${gameFavorite} where ${gameFavorite.gameId} = ${game.igdbId}
  )`,
  viewerHasFavoritedGame: viewerHasFavoritedGame(viewerId),
});

/** The grid row: what a cover card renders, plus the cursor's id half. */
const gameCardSelection = {
  igdbId: game.igdbId,
  slug: game.slug,
  name: game.name,
  coverMediaPath: game.coverMediaPath,
  firstReleaseYear: game.firstReleaseYear,
  popularityRank: game.popularityRank,
};

const gameCursor = createGameCursorCodec();

/**
 * Each sort's total order and cursor filter. One entry per sort, spelled
 * out rather than derived from a direction flag — the three keysets have
 * different key columns, nullability and comparison directions, and three
 * explicit fragments read truer than one engine.
 *
 * NULLS: `coalesce` puts nulls at the deterministic end of each order
 * (unranked games last by popularity, unknown-year games last by year) in
 * BOTH the ORDER BY and the cursor comparison. The plain row-value
 * comparison cannot carry a NULL key — `(NULL, id) < (NULL, id)` is NULL,
 * and every row after a null-keyed cursor row would silently vanish — so
 * the coalesce is load-bearing, not cosmetic. The indexes in
 * `packages/db/src/schema/app.ts` mirror these exact expressions.
 */
/** One sort's keyset definition — the `GAME_SORTS` entry contract. */
interface GameSortEntry {
  orderBy: SQL[];
  cursorFilter: (cursor: { key: number | string | null; igdbId: number }) => SQL;
  /** The row-side value of this sort's key, for the next cursor. */
  keyOf: (row: {
    popularityRank: number | null;
    name: string;
    firstReleaseYear: number | null;
  }) => number | string | null;
}

const GAME_SORTS = {
  popularity: {
    orderBy: [sql`coalesce(${game.popularityRank}, 2147483647) asc`, asc(game.igdbId)],
    cursorFilter: ({ key, igdbId }) =>
      sql`(coalesce(${game.popularityRank}, 2147483647), ${game.igdbId}) > (${coalesceRankParam(key)}, ${igdbId})`,
    keyOf: (row) => row.popularityRank,
  },
  name: {
    orderBy: [asc(game.name), asc(game.igdbId)],
    cursorFilter: ({ key, igdbId }) => sql`(${game.name}, ${game.igdbId}) > (${key}, ${igdbId})`,
    keyOf: (row) => row.name,
  },
  year: {
    orderBy: [sql`coalesce(${game.firstReleaseYear}, 0) desc`, desc(game.igdbId)],
    cursorFilter: ({ key, igdbId }) =>
      sql`(coalesce(${game.firstReleaseYear}, 0), ${game.igdbId}) < (${coalesceYearParam(key)}, ${igdbId})`,
    keyOf: (row) => row.firstReleaseYear,
  },
} satisfies Record<GameSort, GameSortEntry>;

/**
 * Binds a cursor's key through its column's own encoder and re-applies the
 * order's null placement, so a null-keyed cursor compares as "past every
 * ranked row" exactly like the rows themselves do.
 */
function coalesceRankParam(key: number | string | null): SQL {
  return sql`coalesce(${sql.param(key, game.popularityRank)}, 2147483647)`;
}

function coalesceYearParam(key: number | string | null): SQL {
  return sql`coalesce(${sql.param(key, game.firstReleaseYear)}, 0)`;
}

/** The `Database` slice the walker selects through — `db` and any `tx` satisfy it. */
type GameReader = Pick<Database, "select">;

/**
 * Escapes the LIKE metacharacters so a caller's `%`, `_` and `\` match
 * literally — the same rule `escapeLikePattern` applies on the users/posts
 * half (search.ts); restated here because games.ts cannot import it without
 * a cycle, and one escaped pattern helper per module boundary beats a shared
 * escape module for three lines of mechanical code.
 */
function escapeLikePattern(pattern: string): string {
  return pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Whether a game row matches a free-text query — the game half of "this is
 * the thing you typed" (issue #314, Q24): a case-insensitive substring of
 * the display name or of the hashtag key, so both `world of` and
 * `worldofwarcraft` find World of Warcraft. Defined here, beside the game
 * reads that share it; `search.typeahead` imports it so the dropdown and
 * the directory pages match on exactly one predicate.
 */
export function matchesGameQuery(q: string): SQL | undefined {
  const contains = `%${escapeLikePattern(q)}%`;
  return or(ilike(game.name, contains), ilike(game.hashtagKey, contains));
}

/** A grid row `gameKeysetPage` returns. */
export type GameCardRow = {
  igdbId: number;
  slug: string;
  name: string;
  coverMediaPath: string | null;
  firstReleaseYear: number | null;
  popularityRank: number | null;
};

/**
 * The games list's keyset walker — the shared skeleton's discipline (+1
 * lookahead, extra row dropped, last-returned-row anchor) over the games'
 * own (sortKey, igdb_id) keysets. It bypasses `keysetPage` in
 * ./pagination.ts on purpose, the third such bypass in this package: that
 * skeleton is typed to `(created_at, id) DESC` over Date and string columns,
 * and these keysets are (rank|name|year, igdb_id) over integers and a
 * nullable key with per-sort directions. The exactly-once keyset-walk tests
 * in games.int.test.ts pin the invariants the skeleton can no longer enforce.
 *
 * `filters` is how `search.games` joins the party: same keyset, same order,
 * one extra predicate — one definition of the games' popularity order, not
 * two that could drift.
 */
export async function gameKeysetPage(args: {
  db: GameReader;
  sort: GameSort;
  cursor: string | undefined;
  limit: number;
  filters?: SQL | undefined;
}): Promise<{ items: GameCardRow[]; nextCursor: string | null }> {
  const { orderBy, cursorFilter, keyOf } = GAME_SORTS[args.sort];
  const decoded = args.cursor ? gameCursor.decode(args.cursor, args.sort) : undefined;
  const where = decoded ? and(cursorFilter(decoded), args.filters) : args.filters;

  const rows: GameCardRow[] = await args.db
    .select(gameCardSelection)
    .from(game)
    .where(where)
    .orderBy(...orderBy)
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  const last = items.at(-1);

  if (!hasMore || !last) return { items, nextCursor: null };
  return { items, nextCursor: gameCursor.encode(args.sort, keyOf(last), last.igdbId) };
}

/**
 * The `game` procedure group: the public directory's two reads.
 */
export const gameRouter = {
  /**
   * One game's public page data, resolved by URL slug. NOT_FOUND for an
   * unknown slug — indistinguishable from a delisted one, because the
   * catalog never delists (Q29): a slug that once resolved always resolves.
   */
  bySlug: publicReadProcedure
    .use(publicRateLimit(RATE_LIMITS.read))
    .input(z.object({ slug: z.string().trim().min(1).max(GAME_SLUG_MAX_LENGTH) }))
    .handler(async ({ input, context }) => {
      const [row] = await context.db
        .select(gamePageSelection(context.user?.id ?? null))
        .from(game)
        .where(sql`${game.slug} = ${input.slug}`)
        .limit(1);

      if (!row) throw new ORPCError("NOT_FOUND", { message: "No such game." });
      return row;
    }),

  /**
   * The public `/games` index: every game the catalog has ever tracked
   * (Q29 — dropouts included, by last-known rank), 20 per page (Q23),
   * keyset-paginated per sort through the walker above. An optional `q`
   * narrows it with the same matcher the typeahead uses — the page's search
   * bar and the `/search` results' Games section are this one procedure,
   * which is why it stays public rather than riding the session-gated
   * search group: an anonymous visitor's directory search must work (Q6).
   */
  list: publicReadProcedure
    .use(publicRateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        sort: z.enum(["popularity", "name", "year"]).default("popularity"),
        q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).optional(),
        cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
        limit: z.number().int().min(1).max(GAMES_PAGE_SIZE_MAX).default(GAMES_PAGE_SIZE),
      }),
    )
    .handler(({ input, context }) =>
      gameKeysetPage({
        db: context.db,
        sort: input.sort,
        cursor: input.cursor,
        limit: input.limit,
        filters: input.q ? matchesGameQuery(input.q) : undefined,
      }),
    ),
};
