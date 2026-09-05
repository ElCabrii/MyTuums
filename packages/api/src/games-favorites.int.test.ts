import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import { gameFavorite } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGames, type StagedGameRow } from "./games-sync.js";
import { appRouter } from "./router.js";
import { contextFor, createTestUser, truncateAll } from "./testing/harness.js";

/**
 * The favorite pair's write behavior (issue #314, stage 3), against the real
 * `_test` database. The pair deliberately mirrors `post.bookmark`'s contract
 * — pinned in bookmarks.int.test.ts — so this file pins only what is
 * DIFFERENT about games: the count is public and denormalized (Q26's
 * showcase divergence), maintained transactionally with the pair's own
 * write, and the rail reads it back as a showcase for every signed-in
 * viewer.
 */

const now = new Date("2026-09-04T00:00:00.000Z");

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

const SEED = [
  seedRow({ igdbId: 31, name: "Astro" }),
  seedRow({ igdbId: 32, name: "Bramble" }),
  seedRow({ igdbId: 33, name: "Comet" }),
];

beforeAll(async () => {
  await truncateAll();
  await upsertGames(db, SEED, now);
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

async function favoriteRows(): Promise<number> {
  const rows = await db.select().from(gameFavorite);
  return rows.length;
}

describe("game.favorite / game.unfavorite", () => {
  it("is idempotent — a double favorite neither duplicates the row nor double-counts", async () => {
    const viewer = await createTestUser();
    const first = await call(
      appRouter.game.favorite,
      { slug: "game-31" },
      { context: contextFor(viewer) },
    );
    const second = await call(
      appRouter.game.favorite,
      { slug: "game-31" },
      { context: contextFor(viewer) },
    );

    expect(first).toMatchObject({
      slug: "game-31",
      favoriteCount: 1,
      viewerHasFavoritedGame: true,
    });
    expect(second.favoriteCount).toBe(1);
    expect(await favoriteRows()).toBe(1);
  });

  it("unfavorite is a no-op when nothing was favorited, and the count never drops below its rows", async () => {
    const viewer = await createTestUser();
    const result = await call(
      appRouter.game.unfavorite,
      { slug: "game-32" },
      { context: contextFor(viewer) },
    );
    expect(result).toMatchObject({
      slug: "game-32",
      favoriteCount: 0,
      viewerHasFavoritedGame: false,
    });

    // Idempotent on the way out too: a second unfavorite stays at zero.
    const again = await call(
      appRouter.game.unfavorite,
      { slug: "game-32" },
      { context: contextFor(viewer) },
    );
    expect(again.favoriteCount).toBe(0);
  });

  it("maintains the public count across users and directions — the showcase divergence", async () => {
    const [alice, bob] = await Promise.all([createTestUser(), createTestUser()]);
    await call(appRouter.game.favorite, { slug: "game-33" }, { context: contextFor(alice) });
    const both = await call(
      appRouter.game.favorite,
      { slug: "game-33" },
      { context: contextFor(bob) },
    );
    expect(both.favoriteCount).toBe(2);

    // Any viewer reads the same public count — alice's own state does not
    // shade it (Q26).
    const asBob = await call(
      appRouter.game.bySlug,
      { slug: "game-33" },
      { context: contextFor(bob) },
    );
    expect(asBob.favoriteCount).toBe(2);
    expect(asBob.viewerHasFavoritedGame).toBe(true);

    await call(appRouter.game.unfavorite, { slug: "game-33" }, { context: contextFor(alice) });
    const after = await call(
      appRouter.game.bySlug,
      { slug: "game-33" },
      { context: contextFor(bob) },
    );
    expect(after.favoriteCount).toBe(1);
    expect(after.viewerHasFavoritedGame).toBe(true);
  });

  it("refuses an unknown slug with NOT_FOUND on both halves of the pair", async () => {
    const viewer = await createTestUser();
    await expect(
      call(appRouter.game.favorite, { slug: "no-such-game" }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(appRouter.game.unfavorite, { slug: "no-such-game" }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a re-favorite after unfavorite inserts a fresh row — rail order is last-touched, not remembered", async () => {
    const viewer = await createTestUser();
    await call(appRouter.game.favorite, { slug: "game-31" }, { context: contextFor(viewer) });
    await call(appRouter.game.favorite, { slug: "game-32" }, { context: contextFor(viewer) });
    await call(appRouter.game.unfavorite, { slug: "game-31" }, { context: contextFor(viewer) });

    // Direct timestamp control for the re-favorite: the harness's clock is
    // the database's, so re-favoriting after the unfavorite above must land
    // strictly later than game-32's row.
    await call(appRouter.game.favorite, { slug: "game-31" }, { context: contextFor(viewer) });

    const rail = await call(
      appRouter.game.favorites,
      { username: viewer.session.user.username! },
      { context: contextFor(viewer) },
    );
    expect(rail.items.map((item) => item.slug)).toEqual(["game-31", "game-32"]);
  });
});

describe("game.favorites (the profile rail)", () => {
  it("shows one user's showcase to another viewer, newest first, exactly the rail's fields", async () => {
    const owner = await createTestUser();
    const visitor = await createTestUser();
    await call(appRouter.game.favorite, { slug: "game-31" }, { context: contextFor(owner) });
    await call(appRouter.game.favorite, { slug: "game-32" }, { context: contextFor(owner) });
    // Someone else's favorites never join the owner's rail.
    await call(appRouter.game.favorite, { slug: "game-33" }, { context: contextFor(visitor) });

    const rail = await call(
      appRouter.game.favorites,
      { username: owner.session.user.username! },
      { context: contextFor(visitor) },
    );

    expect(rail.items.map((item) => item.slug)).toEqual(["game-32", "game-31"]);
    expect(Object.keys(rail.items[0]).sort()).toEqual([
      "coverMediaPath",
      "firstReleaseYear",
      "name",
      "slug",
    ]);
  });

  it("answers NOT_FOUND for a username that is not there — the rail never outlives its profile", async () => {
    const viewer = await createTestUser();
    await expect(
      call(
        appRouter.game.favorites,
        { username: "nobody-such-user" },
        { context: contextFor(viewer) },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("caps the rail at GAME_RAIL_LIMIT — the rest lives in the directory", async () => {
    const owner = await createTestUser();
    const games = Array.from({ length: 20 }, (_value, index) =>
      seedRow({ igdbId: 100 + index, name: `Rail ${index}` }),
    );
    await upsertGames(db, games, now);
    for (const game of games) {
      await call(appRouter.game.favorite, { slug: game.slug }, { context: contextFor(owner) });
    }

    const rail = await call(
      appRouter.game.favorites,
      { username: owner.session.user.username! },
      { context: contextFor(owner) },
    );
    expect(rail.items).toHaveLength(12);
    // Newest first: the last-favorited game leads.
    expect(rail.items[0].slug).toBe(games.at(-1)?.slug);
  });
});

describe("game.list sort=favorites", () => {
  it("orders by the live count, descending, exactly-once through the keyset", async () => {
    // Fresh games with a deliberate count spread: Trio 2, Duo 1, Solo 0.
    // Earlier tests in this file have favorited other games, so the
    // assertion compares the trio's order against their CURRENT counts
    // rather than assuming a clean slate.
    const games = [
      seedRow({ igdbId: 201, name: "Solo" }),
      seedRow({ igdbId: 202, name: "Duo" }),
      seedRow({ igdbId: 203, name: "Trio" }),
    ];
    await upsertGames(db, games, now);
    const [fanOne, fanTwo] = await Promise.all([createTestUser(), createTestUser()]);
    for (const slug of ["game-202", "game-203"]) {
      await call(appRouter.game.favorite, { slug }, { context: contextFor(fanOne) });
    }
    await call(appRouter.game.favorite, { slug: "game-203" }, { context: contextFor(fanTwo) });

    const counts = new Map(
      await Promise.all(
        games.map(async (game) => {
          const page = await call(
            appRouter.game.bySlug,
            { slug: game.slug },
            { context: contextFor(fanOne) },
          );
          return [game.igdbId, page.favoriteCount] as const;
        }),
      ),
    );
    // (count DESC, id DESC) — the sort's own rule, over the trio.
    const expectedTrioOrder = [...games]
      .map((game) => game.igdbId)
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || b - a);

    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(
        appRouter.game.list,
        { sort: "favorites", limit: 3, cursor },
        { context: contextFor(fanOne) },
      );
      seen.push(...page.items.map((item) => item.igdbId));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (pages > 40) throw new Error("favorites keyset walk did not terminate");
    } while (cursor);

    // Exactly-once across the whole catalog, ties included, and the trio
    // appears in the order its counts dictate.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => counts.has(id))).toEqual(expectedTrioOrder);
    // The spread is real, not a tie: Trio outranks Duo outranks Solo.
    expect(counts.get(203) ?? 0).toBeGreaterThan(counts.get(202) ?? 0);
    expect(counts.get(202) ?? 0).toBeGreaterThan(counts.get(201) ?? 0);
  });

  it("refuses a favorites cursor in another sort's list — the codec's fourth arm", async () => {
    const firstPage = await call(
      appRouter.game.list,
      { sort: "favorites", limit: 2 },
      { context: contextFor(await createTestUser()) },
    );
    expect(firstPage.nextCursor).toBeTruthy();

    await expect(
      call(
        appRouter.game.list,
        { sort: "popularity", limit: 2, cursor: firstPage.nextCursor ?? undefined },
        { context: contextFor(await createTestUser()) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
