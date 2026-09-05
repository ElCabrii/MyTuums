import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { Database } from "@my-tuums/db";
import { game, gameFavorite, follow, user } from "@my-tuums/db/schema";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, normalizeUsername } from "@my-tuums/auth/rules";
import { z } from "zod";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  GAME_RAIL_LIMIT,
  GAME_SLUG_MAX_LENGTH,
  GAMES_PAGE_SIZE,
  GAMES_PAGE_SIZE_MAX,
  SEARCH_QUERY_MAX_LENGTH,
} from "./constants.js";
import { createGameCursorCodec, type GameSort } from "./cursor.js";
import {
  protectedProcedure,
  publicRateLimit,
  publicReadProcedure,
  rateLimit,
} from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { visibleUser } from "./visibility.js";

/**
 * The public game directory and its favorites (issue #314, stages 2–3): the
 * reads behind `/games` and `/games/{slug}`, and the favorite pair that
 * stamps them.
 *
 * The reads build from `publicReadProcedure` — the session-optional surface
 * the anonymous post permalink opened (0.4.0), and deliberately the same
 * reviewed boundary: `/games` is the app's second public page family (issue
 * Q6), so the crawler shell, the anonymous reader and the signed-in one all
 * land here. `viewerHasFavoritedGame` treats a missing viewer the way every
 * viewer probe does — a NULL user id matches no favorite row.
 *
 * The favorite pair mirrors the bookmark pair exactly (separate idempotent
 * procedures, composite-PK insert with `onConflictDoNothing`, no
 * notification) and diverges on one deliberate point: the count is PUBLIC
 * (Q26's showcase — the rail is visible to every signed-in viewer), so it
 * is denormalized on `game.favorite_count` and maintained in the same
 * transaction as the pair's own write. The rail itself is visible to every
 * signed-in viewer EXCEPT on a private profile, where it redacts to empty
 * for non-followers like the follow graphs do.
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
  firstReleaseDate: game.firstReleaseDate,
  hypeCount: game.hypeCount,
  genres: game.genres,
  platforms: game.platforms,
  favoriteCount: game.favoriteCount,
  viewerHasFavoritedGame: viewerHasFavoritedGame(viewerId),
});

/** The grid row: what a cover card renders, plus the cursor halves. */
const gameCardSelection = {
  igdbId: game.igdbId,
  slug: game.slug,
  name: game.name,
  coverMediaPath: game.coverMediaPath,
  firstReleaseYear: game.firstReleaseYear,
  firstReleaseDate: game.firstReleaseDate,
  hypeCount: game.hypeCount,
  popularityRank: game.popularityRank,
  favoriteCount: game.favoriteCount,
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
    favoriteCount: number;
    hypeCount: number;
  }) => number | string | null;
  /** An inherent WHERE the sort always carries — the upcoming sort's unreleased filter. */
  baseFilter?: SQL | undefined;
}

/**
 * Whether a game row counts as unreleased for the upcoming sort: TBA (null
 * date) or a first-release instant in the future. Compared in SQL against
 * the database clock so the boundary never skews with the app server's.
 */
function unreleasedFilter(): SQL {
  return sql`(${game.firstReleaseDate} is null or to_timestamp(${game.firstReleaseDate}) > now())`;
}

const GAME_SORTS = {
  popularity: {
    orderBy: [sql`coalesce(${game.popularityRank}, 2147483647) asc`, asc(game.igdbId)],
    cursorFilter: ({ key, igdbId }: { key: number | string | null; igdbId: number }) =>
      sql`(coalesce(${game.popularityRank}, 2147483647), ${game.igdbId}) > (${coalesceRankParam(key)}, ${igdbId})`,
    keyOf: (row: { popularityRank: number | null }) => row.popularityRank,
  },
  name: {
    orderBy: [asc(game.name), asc(game.igdbId)],
    cursorFilter: ({ key, igdbId }: { key: number | string | null; igdbId: number }) =>
      sql`(${game.name}, ${game.igdbId}) > (${key}, ${igdbId})`,
    keyOf: (row: { name: string }) => row.name,
  },
  year: {
    orderBy: [sql`coalesce(${game.firstReleaseYear}, 0) desc`, desc(game.igdbId)],
    cursorFilter: ({ key, igdbId }: { key: number | string | null; igdbId: number }) =>
      sql`(coalesce(${game.firstReleaseYear}, 0), ${game.igdbId}) < (${coalesceYearParam(key)}, ${igdbId})`,
    keyOf: (row: { firstReleaseYear: number | null }) => row.firstReleaseYear,
  },
  favorites: {
    // (count DESC, id DESC) — most-favorited first (issue Q23). No coalesce:
    // `favorite_count` is NOT NULL by default, so the keyset stays total
    // without one. The order is live: counts move while someone scrolls, and
    // the cursor guarantees no repeats of what it has already seen, not a
    // frozen snapshot — the accepted posture for any ranked list.
    orderBy: [desc(game.favoriteCount), desc(game.igdbId)],
    cursorFilter: ({ key, igdbId }: { key: number | string | null; igdbId: number }) =>
      sql`(${game.favoriteCount}, ${game.igdbId}) < (${sql.param(key, game.favoriteCount)}, ${igdbId})`,
    keyOf: (row: { favoriteCount: number }) => row.favoriteCount,
  },
  upcoming: {
    // Unreleased games by most-wanted first: IGDB `hypes` DESC. The
    // unreleased predicate lives in `baseFilter` so it ANDs with both the
    // cursor comparison and the caller's `q` — one definition of "upcoming",
    // not two that could drift. No coalesce: `hype_count` defaults 0.
    orderBy: [desc(game.hypeCount), desc(game.igdbId)],
    cursorFilter: ({ key, igdbId }: { key: number | string | null; igdbId: number }) =>
      sql`(${game.hypeCount}, ${game.igdbId}) < (${sql.param(key, game.hypeCount)}, ${igdbId})`,
    keyOf: (row: { hypeCount: number }) => row.hypeCount,
    baseFilter: unreleasedFilter(),
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
  firstReleaseDate: number | null;
  hypeCount: number;
  popularityRank: number | null;
  favoriteCount: number;
};

/**
 * The hashtag tokens the client's linkifier can produce, as one regex — the
 * server-side mirror of `matchHashtag`'s word charset (`[a-zA-Z0-9_]`, apps/
 * web `linked-text.tsx`). Extracting a SUPERSET of what the client will
 * actually linkify is harmless (extra map keys are never read); a subset
 * would silently drop resolutions.
 */
const HASHTAG_TOKEN = /#([a-zA-Z0-9_]{1,99})/g;

/**
 * Every distinct hashtag key a batch of texts contains, lowercased and
 * hash-stripped — the client's canonical tag shape. Underscored tokens stay
 * (the client links them; no game key contains one, so they simply match
 * nothing), and the set is capped so a pathological batch cannot build an
 * unbounded IN list.
 */
export function extractHashtagKeys(
  texts: Iterable<string | null | undefined>,
  maxKeys = 200,
): string[] {
  const keys = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(HASHTAG_TOKEN)) {
      keys.add(match[1].toLowerCase());
      if (keys.size >= maxKeys) return [...keys];
    }
  }
  return [...keys];
}

/**
 * The per-batch hashtag→game map (issue #314, Q16/Q21): one keyed lookup
 * alongside the posts query, returned on the response so the renderer can
 * link resolved tags to `/games/{slug}` while unresolved tags keep their
 * search link. A superset of the client's tokens is fine; a miss is simply
 * an absent key.
 */
export async function gameMentionsFor(
  db: GameReader,
  texts: Iterable<string | null | undefined>,
): Promise<Record<string, string>> {
  const keys = extractHashtagKeys(texts);
  if (keys.length === 0) return {};

  const rows = await db
    .select({ hashtagKey: game.hashtagKey, slug: game.slug })
    .from(game)
    .where(inArray(game.hashtagKey, keys));

  return Object.fromEntries(rows.map((row) => [row.hashtagKey, row.slug]));
}

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
  const entry = GAME_SORTS[args.sort];
  const decoded = args.cursor ? gameCursor.decode(args.cursor, args.sort) : undefined;
  // Only the upcoming sort carries an inherent WHERE (the unreleased
  // predicate); the `in` guard keeps the union's members without it from
  // needing the property.
  const baseFilter = "baseFilter" in entry ? entry.baseFilter : undefined;
  const where = and(baseFilter, decoded ? entry.cursorFilter(decoded) : undefined, args.filters);

  const rows: GameCardRow[] = await args.db
    .select(gameCardSelection)
    .from(game)
    .where(where)
    .orderBy(...entry.orderBy)
    .limit(args.limit + 1);

  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  const last = items.at(-1);

  if (!hasMore || !last) return { items, nextCursor: null };
  return { items, nextCursor: gameCursor.encode(args.sort, entry.keyOf(last), last.igdbId) };
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
   * The `upcoming` sort lists unreleased games only (TBA or future release),
   * most-wanted first by IGDB hypes.
   */
  list: publicReadProcedure
    .use(publicRateLimit(RATE_LIMITS.read))
    .input(
      z.object({
        sort: z.enum(["popularity", "name", "year", "favorites", "upcoming"]).default("popularity"),
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

  /**
   * Favorites a game — the `post.bookmark` pair's mirror with one public
   * consequence: the denormalized `favorite_count` moves in the SAME
   * transaction, and only when the insert actually inserted. Idempotent by
   * the composite primary key (`onConflictDoNothing`), so a double-click can
   * neither double the count nor error; a re-favorite after unfavorite
   * re-inserts a fresh row, moving the game back to the top of the rail.
   *
   * No notification, no relationship lock — a favorite stamps a game, not a
   * person (Q17).
   */
  favorite: protectedProcedure
    .use(rateLimit(RATE_LIMITS.favoriteGame))
    .input(z.object({ slug: z.string().trim().min(1).max(GAME_SLUG_MAX_LENGTH) }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ igdbId: game.igdbId })
        .from(game)
        .where(eq(game.slug, input.slug))
        .limit(1);
      if (!target) throw new ORPCError("NOT_FOUND", { message: "No such game." });

      const favoriteCount = await context.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(gameFavorite)
          .values({ gameId: target.igdbId, userId: context.user.id })
          .onConflictDoNothing()
          .returning({ gameId: gameFavorite.gameId });
        if (inserted.length > 0) {
          await tx
            .update(game)
            .set({ favoriteCount: sql`${game.favoriteCount} + 1` })
            .where(eq(game.igdbId, target.igdbId));
        }
        const [row] = await tx
          .select({ favoriteCount: game.favoriteCount })
          .from(game)
          .where(eq(game.igdbId, target.igdbId))
          .limit(1);
        return row.favoriteCount;
      });

      return { slug: input.slug, favoriteCount, viewerHasFavoritedGame: true };
    }),

  /**
   * Unfavorites a game. Idempotent; the count decrements only when a row
   * was actually deleted, in the same transaction. Like `post.unbookmark`,
   * deliberately no visibility check on the target: the only row this can
   * delete is the caller's own, and a favorite must never become stuck.
   * The catalog never delists (Q29), so a slug lookup that fails means
   * there is nothing to unfavorite — NOT_FOUND is honest, not a leak.
   */
  unfavorite: protectedProcedure
    .use(rateLimit(RATE_LIMITS.favoriteGame))
    .input(z.object({ slug: z.string().trim().min(1).max(GAME_SLUG_MAX_LENGTH) }))
    .handler(async ({ input, context }) => {
      const [target] = await context.db
        .select({ igdbId: game.igdbId })
        .from(game)
        .where(eq(game.slug, input.slug))
        .limit(1);
      if (!target) throw new ORPCError("NOT_FOUND", { message: "No such game." });

      const favoriteCount = await context.db.transaction(async (tx) => {
        const removed = await tx
          .delete(gameFavorite)
          .where(
            and(eq(gameFavorite.gameId, target.igdbId), eq(gameFavorite.userId, context.user.id)),
          )
          .returning({ gameId: gameFavorite.gameId });
        if (removed.length > 0) {
          await tx
            .update(game)
            .set({ favoriteCount: sql`${game.favoriteCount} - 1` })
            .where(eq(game.igdbId, target.igdbId));
        }
        const [row] = await tx
          .select({ favoriteCount: game.favoriteCount })
          .from(game)
          .where(eq(game.igdbId, target.igdbId))
          .limit(1);
        return row.favoriteCount;
      });

      return { slug: input.slug, favoriteCount, viewerHasFavoritedGame: false };
    }),

  /**
   * One profile's favorites rail (Q11/Q25): the games a user has favorited,
   * newest first, capped — a showcase strip, not a list page. Session-gated
   * like every profile surface, and read through `visibleUser` so a banned
   * owner (or a blocked pair) answers NOT_FOUND exactly like their profile
   * does — the rail never outlives the page that carries it. A private
   * owner's rail reads as EMPTY for viewers who are neither the owner nor an
   * approved follower — the same redaction the follow graphs apply, so the
   * rail cannot disagree with the locked profile carrying it.
   */
  favorites: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(
      z.object({ username: z.string().trim().min(USERNAME_MIN_LENGTH).max(USERNAME_MAX_LENGTH) }),
    )
    .handler(async ({ input, context }) => {
      // The owner resolves first, through the same predicate their profile
      // reads — a missing or hidden owner is NOT_FOUND, never an empty rail
      // that would outlive the page carrying it. An owner with no favorites
      // IS an empty rail; the two must stay distinguishable.
      const [owner] = await context.db
        .select({ id: user.id, isPrivate: user.isPrivate })
        .from(user)
        .where(
          and(
            // `normalizeUsername` — the same one-definition matching every
            // profile lookup applies.
            eq(user.username, normalizeUsername(input.username)),
            visibleUser(context.user.id),
          ),
        )
        .limit(1);
      if (!owner) throw new ORPCError("NOT_FOUND", { message: "No such user." });

      // A private showcase hides like a private graph: the profile itself
      // still resolves (so the client renders the locked notice), but the
      // member list — here the favorited games — redacts to empty. Null
      // `isPrivate` (pre-privacy rows) reads as public.
      if (owner.isPrivate && owner.id !== context.user.id) {
        const [edge] = await context.db
          .select({ followerId: follow.followerId })
          .from(follow)
          .where(and(eq(follow.followerId, context.user.id), eq(follow.followingId, owner.id)))
          .limit(1);
        if (!edge) return { items: [] };
      }

      const rows = await context.db
        .select({
          slug: game.slug,
          name: game.name,
          coverMediaPath: game.coverMediaPath,
          firstReleaseYear: game.firstReleaseYear,
        })
        .from(gameFavorite)
        .innerJoin(game, eq(game.igdbId, gameFavorite.gameId))
        .where(eq(gameFavorite.userId, owner.id))
        .orderBy(desc(gameFavorite.createdAt), desc(gameFavorite.gameId))
        .limit(GAME_RAIL_LIMIT);

      return { items: rows };
    }),
};
