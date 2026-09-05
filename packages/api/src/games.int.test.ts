import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGames, type StagedGameRow } from "./games-sync.js";
import { appRouter } from "./router.js";
import { anonContext, contextFor, createTestUser, truncateAll } from "./testing/harness.js";

/**
 * The public game directory's reads (issue #314, stage 2), against the real
 * `_test` database. One invariant per test: the anonymous surface works, the
 * page projection is exactly what the page renders (no more — the pin
 * users.int.test.ts made standard), the three sorts each walk their own
 * total order exactly once (the hand-rolled keyset walker's substitute for
 * the shared skeleton's enforcement), and the favorite read model answers
 * per viewer while its count stays public.
 */

const now = new Date("2026-09-04T00:00:00.000Z");

/**
 * Seven games whose rank, name and year orders all differ, with one null
 * rank and one null year — every sort has its own order, a tie inside it,
 * and a null key to place at the deterministic end.
 */
function seedRow(overrides: Partial<StagedGameRow> & { igdbId: number }): StagedGameRow {
  return {
    slug: `game-${overrides.igdbId}`,
    hashtagKey: `game${overrides.igdbId}`,
    name: `Game ${overrides.igdbId}`,
    summary: null,
    coverMediaPath: null,
    coverImageId: null,
    firstReleaseYear: 2010,
    firstReleaseDate: null,
    hypeCount: 0,
    genres: [],
    platforms: [],
    popularityRank: null,
    ...overrides,
  };
}

const SEED: StagedGameRow[] = [
  seedRow({ igdbId: 1, name: "Zelda", popularityRank: 3, firstReleaseYear: 2020 }),
  seedRow({ igdbId: 2, name: "Alpha", popularityRank: 1, firstReleaseYear: 1999 }),
  seedRow({ igdbId: 3, name: "Midway", popularityRank: 2, firstReleaseYear: null }),
  seedRow({ igdbId: 4, name: "Beta", popularityRank: null, firstReleaseYear: 2015 }),
  seedRow({ igdbId: 5, name: "Gamma", popularityRank: 5, firstReleaseYear: 2024 }),
  seedRow({ igdbId: 6, name: "Delta", popularityRank: 4, firstReleaseYear: 2024 }),
  seedRow({ igdbId: 7, name: "Omega", popularityRank: 3, firstReleaseYear: 2001 }),
];

beforeAll(async () => {
  await truncateAll();
  await upsertGames(db, SEED, now);
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** Walks a sort's whole list two rows at a time, returning the seen order. */
async function walkAll(
  sort: "popularity" | "name" | "year" | "favorites" | "upcoming",
): Promise<number[]> {
  const seen: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await call(
      appRouter.game.list,
      { sort, limit: 2, cursor },
      { context: anonContext },
    );
    seen.push(...page.items.map((item) => item.igdbId));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 10) throw new Error("keyset walk did not terminate");
  } while (cursor);
  return seen;
}

describe("game.bySlug", () => {
  it("returns exactly the game page's projection — widening it must fail here first", async () => {
    const result = await call(appRouter.game.bySlug, { slug: "game-2" }, { context: anonContext });

    expect(Object.keys(result).sort()).toEqual(
      [
        "coverMediaPath",
        "favoriteCount",
        "firstReleaseDate",
        "firstReleaseYear",
        "genres",
        "hypeCount",
        "name",
        "platforms",
        "slug",
        "summary",
        "viewerHasFavoritedGame",
      ].sort(),
    );
    expect(result).toMatchObject({ slug: "game-2", name: "Alpha", firstReleaseYear: 1999 });
  });

  it("answers NOT_FOUND for an unknown slug — anonymous caller, no session demanded", async () => {
    await expect(
      call(appRouter.game.bySlug, { slug: "no-such-game" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers the favorite read model per viewer, with a public count", async () => {
    const [favoriter, other] = await Promise.all([createTestUser(), createTestUser()]);
    // Write through the procedure: the count is denormalized on the row, so
    // a direct insert would not move it.
    await call(appRouter.game.favorite, { slug: "game-2" }, { context: contextFor(favoriter) });

    const asFavoriter = await call(
      appRouter.game.bySlug,
      { slug: "game-2" },
      { context: contextFor(favoriter) },
    );
    const asOther = await call(
      appRouter.game.bySlug,
      { slug: "game-2" },
      { context: contextFor(other) },
    );
    const asAnonymous = await call(
      appRouter.game.bySlug,
      { slug: "game-2" },
      { context: anonContext },
    );

    expect(asFavoriter.viewerHasFavoritedGame).toBe(true);
    expect(asOther.viewerHasFavoritedGame).toBe(false);
    expect(asAnonymous.viewerHasFavoritedGame).toBe(false);
    // The showcase divergence (Q26): unlike bookmarks, the count is public —
    // the same number for every viewer, whatever their own favorite state.
    expect(asFavoriter.favoriteCount).toBe(1);
    expect(asAnonymous.favoriteCount).toBe(1);
  });
});

describe("game.list", () => {
  it("walks each sort's own total order exactly once — ties by id, nulls at the end", async () => {
    // (rank, id) ASC, unranked last: Alpha(1), Midway(2), Zelda(3, id 1),
    // Omega(3, id 7), Delta(4), Gamma(5), Beta(null).
    expect(await walkAll("popularity")).toEqual([2, 3, 1, 7, 6, 5, 4]);

    // (name, id) ASC — a completely different order than popularity's.
    expect(await walkAll("name")).toEqual([2, 4, 6, 5, 3, 7, 1]);

    // (coalesce(year, 0), id) DESC, unknown-year last: the 2024 tie breaks
    // id-desc (Delta 6 ahead of Gamma 5), and Midway's unknown year lands
    // after every dated game.
    expect(await walkAll("year")).toEqual([6, 5, 1, 4, 7, 2, 3]);
  });

  it("lists unreleased games only, most-wanted first — released games never surface no matter their hypes", async () => {
    const future = Math.floor(new Date("2028-01-01T00:00:00Z").getTime() / 1000);
    const past = Math.floor(new Date("2020-01-01T00:00:00Z").getTime() / 1000);
    await upsertGames(
      db,
      [
        {
          igdbId: 11,
          slug: "upcoming-high",
          hashtagKey: "upcominghigh",
          name: "Upcoming High",
          summary: null,
          coverMediaPath: null,
          coverImageId: null,
          firstReleaseYear: 2028,
          firstReleaseDate: future,
          hypeCount: 500,
          genres: [],
          platforms: [],
          popularityRank: null,
        },
        {
          igdbId: 12,
          slug: "upcoming-tba",
          hashtagKey: "upcomingtba",
          name: "Upcoming TBA",
          summary: null,
          coverMediaPath: null,
          coverImageId: null,
          firstReleaseYear: null,
          firstReleaseDate: null,
          hypeCount: 900,
          genres: [],
          platforms: [],
          popularityRank: null,
        },
        {
          igdbId: 13,
          slug: "released-hot",
          hashtagKey: "releasedhot",
          name: "Released Hot",
          summary: null,
          coverMediaPath: null,
          coverImageId: null,
          firstReleaseYear: 2020,
          firstReleaseDate: past,
          hypeCount: 9999,
          genres: [],
          platforms: [],
          popularityRank: null,
        },
      ],
      now,
    );

    const page = await call(
      appRouter.game.list,
      { sort: "upcoming", limit: 50 },
      { context: anonContext },
    );
    const slugs = page.items.map((item) => item.slug);
    // TBA (900 hypes) leads dated-future (500); the released row's 9999
    // hypes buy it nothing — unreleased-only means unreleased-only.
    expect(slugs.slice(0, 2)).toEqual(["upcoming-tba", "upcoming-high"]);
    expect(slugs).not.toContain("released-hot");
    // Keyset walk terminates over the filtered set.
    expect(await walkAll("upcoming")).toEqual(page.items.map((item) => item.igdbId));
  });

  it("refuses a cursor minted under a different sort as malformed", async () => {
    const firstPage = await call(
      appRouter.game.list,
      { sort: "popularity", limit: 2 },
      { context: anonContext },
    );
    expect(firstPage.nextCursor).toBeTruthy();

    await expect(
      call(
        appRouter.game.list,
        { sort: "name", limit: 2, cursor: firstPage.nextCursor ?? undefined },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("serves an anonymous caller — the public directory's whole point", async () => {
    const page = await call(appRouter.game.list, { limit: 3 }, { context: anonContext });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeTruthy();
  });

  it("narrows to a query by name or hashtag key — the page's search bar and /search's Games section", async () => {
    // Seeded here (not in SEED) so the walk tests above keep one catalog.
    await upsertGames(
      db,
      [
        {
          igdbId: 21,
          slug: "world-at-war",
          hashtagKey: "worldatwar",
          name: "World at War",
          rank: 2,
        },
        {
          igdbId: 22,
          slug: "unrelated",
          hashtagKey: "worldofwarcraft",
          name: "Unrelated Title",
          rank: 1,
        },
        { igdbId: 23, slug: "hades", hashtagKey: "hades", name: "Hades", rank: 3 },
      ].map(({ igdbId, slug, hashtagKey, name, rank }) => ({
        igdbId,
        slug,
        hashtagKey,
        name,
        summary: null,
        coverMediaPath: null,
        coverImageId: null,
        firstReleaseYear: 2020,
        firstReleaseDate: null,
        hypeCount: 0,
        genres: [],
        platforms: [],
        popularityRank: rank,
      })),
      now,
    );

    const byName = await call(appRouter.game.list, { q: "world" }, { context: anonContext });
    expect(byName.items.map((item) => item.slug)).toEqual(["unrelated", "world-at-war"]);

    // The hashtag-key half: `worldofwarcraft` finds the game whose NAME does
    // not match at all.
    const byKey = await call(
      appRouter.game.list,
      { q: "worldofwarcraft" },
      { context: anonContext },
    );
    expect(byKey.items.map((item) => item.slug)).toEqual(["unrelated"]);

    // A query over a different sort keeps that sort's order.
    const sorted = await call(
      appRouter.game.list,
      { q: "world", sort: "name" },
      { context: anonContext },
    );
    expect(sorted.items.map((item) => item.slug)).toEqual(["unrelated", "world-at-war"]);
  });
});
