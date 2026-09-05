import { closeDb, db } from "@my-tuums/db";
import { game } from "@my-tuums/db/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { syncGamesCatalog, upsertGames, type StagedGameRow } from "./games-sync.js";
import type {
  IgdbGameRow,
  IgdbPopularityPrimitive,
  IgdbPopularityType,
  IgdbTransport,
} from "./igdb.js";
import { testStorage, testStorageObjects, truncateAll } from "./testing/harness.js";

/**
 * The sync's database behavior, against the real `_test` database with IGDB
 * faked at the transport seam (the network is never reached — the same
 * contract `igdb.test.ts` pins at the client). One invariant per test, and
 * the first is the issue's own headline: fail-closed (Q28) — a run that
 * fails anywhere leaves the previous catalog byte-identical.
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x10]);

interface FakeIgdbOptions {
  /** `/popularity_types` rows. */
  types: IgdbPopularityType[];
  /** One page of `/popularity_primitives`, already value-desc — under a
   * batch long so the scan stops after it. */
  primitives: IgdbPopularityPrimitive[];
  /** `/games` hydration rows keyed by id. Omitting a requested id is how a
   * dropout "IGDB no longer returns" is simulated. */
  games: Map<number, IgdbGameRow>;
  /** Cover bytes keyed by image id. */
  covers: Map<string, Uint8Array>;
  /** When set, every `/v4/` query answers 500 — the run must fail. */
  failApi?: boolean;
}

/** A transport answering from data, keyed by URL — no call-order coupling. */
function fakeIgdb(options: FakeIgdbOptions): IgdbTransport {
  const json = (body: readonly unknown[] | Record<string, never>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // Synchronous routing wrapped in `Promise.resolve` — the repo's fake-
  // transport shape (see link-card-http.test.ts), keeping `require-await`
  // honest: nothing here needs the event loop.
  const route = (url: string, init: { body?: string }): Response => {
    if (url.startsWith("https://id.twitch.tv/")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (options.failApi) return json([{ error: "unavailable" }], 500);
    if (url.endsWith("/v4/popularity_types")) return json(options.types);
    if (url.endsWith("/v4/popularity_primitives")) return json(options.primitives);
    if (url.endsWith("/v4/games")) {
      const requested = /where id = \(([\d,]+)\)/.exec(init.body ?? "")?.[1]?.split(",") ?? [];
      const rows = requested
        .map((id) => options.games.get(Number(id)))
        .filter((row): row is IgdbGameRow => row !== undefined);
      return json(rows);
    }
    if (url.startsWith("https://images.igdb.com/")) {
      const imageId = /t_cover_big\/([a-z0-9]+)\.jpg/.exec(url)?.[1] ?? "";
      const bytes = options.covers.get(imageId);
      return bytes ? new Response(bytes, { status: 200 }) : json([{ error: "gone" }], 404);
    }
    return json([{ error: "unexpected" }], 404);
  };

  return {
    fetch: (url, init) => Promise.resolve(route(url, init)),
  };
}

// IGDB's real, live-verified spelling (see IGDB_POPULARITY_TYPE_NAME).
const TYPES = [{ id: 7, name: "24hr Hours Watched" }];

/** The two-game DOOM fixture the hashtag tests reason with, hydrated. */
function doomCatalog() {
  return {
    types: TYPES,
    primitives: [
      { game_id: 20, value: 900 },
      { game_id: 10, value: 800 },
    ],
    games: new Map([
      [
        10,
        {
          id: 10,
          name: "DOOM",
          slug: "doom",
          summary: "  The 1993 classic.  ",
          first_release_date: Date.UTC(1993, 11, 10) / 1000,
          cover: { image_id: "co1993" },
          genres: [{ name: " Shooter " }, { name: "" }, { name: "Shooter" }],
          platforms: [{ abbreviation: "DOS" }, { abbreviation: null, name: "SNES" }],
        },
      ],
      [
        20,
        {
          id: 20,
          name: "DOOM",
          slug: "doom-2016",
          summary: null,
          first_release_date: Date.UTC(2016, 4, 13) / 1000,
          cover: { image_id: "co2016" },
          genres: [{ name: "Shooter" }],
          platforms: [],
        },
      ],
    ]),
    covers: new Map([
      ["co1993", JPEG],
      ["co2016", JPEG],
    ]),
  };
}

async function runSync(options: FakeIgdbOptions, storage = testStorage) {
  return syncGamesCatalog({
    db,
    storage,
    transport: fakeIgdb(options),
    clientId: "client-id",
    clientSecret: "client-secret",
    // Fixed clock: rank windows and release-year bounds never flake.
    now: () => new Date("2026-09-04T00:00:00Z"),
  });
}

/** A row for direct seeding — the seeder's shape, bypassing the sync. */
function stagedRow(overrides: Partial<StagedGameRow> & { igdbId: number }): StagedGameRow {
  return {
    slug: `game-${overrides.igdbId}`,
    hashtagKey: `game${overrides.igdbId}`,
    name: `Game ${overrides.igdbId}`,
    summary: null,
    coverMediaPath: null,
    coverImageId: null,
    firstReleaseYear: 2020,
    genres: [],
    platforms: [],
    popularityRank: null,
    ...overrides,
  };
}

// Each test syncs from its own empty catalog — the table state one test
// leaves behind is never another's starting point (the rank/cover
// expectations below are exact, not relative).
beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("syncGamesCatalog", () => {
  it("commits the scan: sticky collision keys, dense ranks, normalized labels, re-hosted covers", async () => {
    const result = await runSync(doomCatalog());

    expect(result).toMatchObject({
      scanned: 2,
      knownIds: 0,
      newGames: 2,
      coversUploaded: 2,
      coversFailed: 0,
    });

    const rows = await db.select().from(game);
    const byId = new Map(rows.map((row) => [row.igdbId, row]));
    expect(byId.get(10)).toMatchObject({
      slug: "doom",
      // The lower IGDB id keeps the bare key; the 2016 collider takes the
      // year suffix.
      hashtagKey: "doom",
      // Rank follows the scan's value-desc order: 20's 900 hours outrank
      // 10's 800, so the 1993 classic ranks second TODAY.
      popularityRank: 2,
      summary: "The 1993 classic.",
      firstReleaseYear: 1993,
      genres: ["Shooter"], // trimmed, empties dropped, duplicates collapsed
      platforms: ["DOS", "SNES"], // abbreviation preferred, name as fallback
      coverMediaPath: "/media/games/10-co1993.jpg",
      coverImageId: "co1993",
    });
    expect(byId.get(20)).toMatchObject({
      hashtagKey: "doom2016",
      popularityRank: 1,
      summary: null,
    });
    expect(testStorageObjects.has("games/10-co1993.jpg")).toBe(true);
    expect(testStorageObjects.has("games/20-co2016.jpg")).toBe(true);
  });

  it("is fail-closed: a run whose API fails leaves the previous catalog byte-identical", async () => {
    await upsertGames(
      db,
      [stagedRow({ igdbId: 10, name: "DOOM", hashtagKey: "doom", slug: "doom" })],
      new Date(),
    );
    const before = await db.select().from(game);
    testStorageObjects.clear();

    await expect(
      runSync({
        types: TYPES,
        primitives: [{ game_id: 10, value: 1 }],
        games: new Map(),
        covers: new Map(),
        failApi: true,
      }),
    ).rejects.toMatchObject({ reason: "server" });

    // THE pin (Q28): every row unchanged — not "still present", identical.
    expect(await db.select().from(game)).toEqual(before);
    // And nothing reached the bucket either.
    expect([...testStorageObjects.keys()]).toEqual([]);
  });

  it("keeps an unchanged cover — no upload, no key churn", async () => {
    const catalog = doomCatalog();
    await runSync(catalog);
    const before = (await db.select().from(game)).find((row) => row.igdbId === 10);

    const second = await runSync(catalog);
    expect(second).toMatchObject({ knownIds: 2, newGames: 0, coversKept: 2, coversUploaded: 0 });

    const after = (await db.select().from(game)).find((row) => row.igdbId === 10);
    expect(after?.coverMediaPath).toBe(before?.coverMediaPath);
  });

  it("re-hosts a changed cover, content-addressed, and removes the superseded object after commit", async () => {
    const catalog = doomCatalog();
    await runSync(catalog);

    const changed: FakeIgdbOptions = {
      ...catalog,
      games: new Map(catalog.games),
      covers: new Map([
        ["co1993", JPEG],
        ["co2016", JPEG],
        ["co9999", JPEG],
      ]),
    };
    changed.games.set(10, { ...catalog.games.get(10)!, cover: { image_id: "co9999" } });

    const second = await runSync(changed);
    expect(second.coversUploaded).toBe(1);

    const row = (await db.select().from(game)).find((current) => current.igdbId === 10);
    expect(row?.coverMediaPath).toBe("/media/games/10-co9999.jpg");
    expect(row?.coverImageId).toBe("co9999");
    // The old object left WITH the commit, not before it.
    expect(testStorageObjects.has("games/10-co1993.jpg")).toBe(false);
    expect(testStorageObjects.has("games/10-co9999.jpg")).toBe(true);
  });

  it("keeps a cover that fails to download, with its compare key, so the change retries", async () => {
    const catalog = doomCatalog();
    await runSync(catalog);

    const failing: FakeIgdbOptions = {
      ...catalog,
      games: new Map(catalog.games),
      covers: new Map(catalog.covers),
    };
    failing.games.set(10, { ...catalog.games.get(10)!, cover: { image_id: "co404" } });
    // `co404` is absent from covers — the transport answers 404.

    const second = await runSync(failing);
    expect(second.coversFailed).toBe(1);

    const row = (await db.select().from(game)).find((current) => current.igdbId === 10);
    expect(row?.coverImageId).toBe("co1993");
    expect(row?.coverMediaPath).toBe("/media/games/10-co1993.jpg");
  });

  it("never deletes a dropout: it keeps its row and its last-known rank, refreshed from IGDB", async () => {
    const catalog = doomCatalog();
    await runSync(catalog);

    // Run 2: only igdb 20 is in the scan; 10 is a dropout but still
    // hydratable (its id is known, so the union re-hydrates it).
    const dropoutScan: FakeIgdbOptions = { ...catalog, primitives: [{ game_id: 20, value: 50 }] };
    await runSync(dropoutScan);

    const rows = await db.select().from(game);
    expect(rows).toHaveLength(2);
    const dropout = rows.find((row) => row.igdbId === 10);
    // Last-known rank (2 from run 1) — not null, and not clamped to the new
    // scan's size of 1; ordering dropouts "by where they last placed" (Q29)
    // is exactly this column's meaning.
    expect(dropout?.popularityRank).toBe(2);
    expect(dropout?.name).toBe("DOOM");

    // Run 3: the dropout stops hydrating entirely — the row still survives,
    // verbatim, with its sticky key and last-known rank (Q29).
    const vanished: FakeIgdbOptions = {
      ...dropoutScan,
      games: new Map([[20, catalog.games.get(20)!]]),
    };
    await runSync(vanished);

    const survivor = (await db.select().from(game)).find((row) => row.igdbId === 10);
    expect(survivor).toMatchObject({ hashtagKey: "doom", popularityRank: 2, slug: "doom" });
  });

  it("refuses to sync when IGDB has no popularity type of the expected name", async () => {
    await expect(
      runSync({
        types: [{ id: 1, name: "IGDB Reviews" }],
        primitives: [],
        games: new Map(),
        covers: new Map(),
      }),
    ).rejects.toThrow(/24hr Hours Watched/);
    // Nothing was staged, so nothing was written.
    expect(await db.select().from(game)).toHaveLength(0);
  });
});
