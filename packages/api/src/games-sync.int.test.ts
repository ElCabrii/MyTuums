import { closeDb, db } from "@my-tuums/db";
import { game } from "@my-tuums/db/schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAMES_CATALOG_SIZE } from "./constants.js";
import { syncGamesCatalog, upsertGames, type StagedGameRow } from "./games-sync.js";
import type { IgdbGameRow, IgdbTransport, TwitchTopGame } from "./igdb.js";
import { testStorage, testStorageObjects, truncateAll } from "./testing/harness.js";

/**
 * The sync's database behavior, against the real `_test` database with Twitch
 * and IGDB faked at the transport seam (the network is never reached — the
 * same contract `igdb.test.ts` pins at the client). One invariant per test,
 * and the first is the issue's own headline: fail-closed (Q28) — a run that
 * fails anywhere leaves the previous catalog byte-identical.
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x10]);

interface FakeTwitchOptions {
  /** Twitch `games/top` entries in returned order — the fake serves them 100 per page behind cursors. */
  top: TwitchTopGame[];
  /** `/games` hydration rows keyed by id. Omitting a requested id is how a
   * dropout "IGDB no longer returns" is simulated. */
  games: Map<number, IgdbGameRow>;
  /** Cover bytes keyed by image id. */
  covers: Map<string, Uint8Array>;
  /** When set, Helix answers 500 — the run must fail. */
  failHelix?: boolean;
}

let categorySeq = 0;

/**
 * One Helix entry. The category `id` is deliberately unrelated to the IGDB
 * id (`cat-<n>` vs the numeric `igdb_id`) — if the sync ever ranked by the
 * category id, hydration would miss and the run would fail, so every test
 * below pins `igdb_id` as the stored identity without saying so again.
 */
function topEntry(igdbId: string | null | undefined, name?: string): TwitchTopGame {
  const categoryId = `cat-${categorySeq++}`;
  return {
    id: categoryId,
    name: name ?? `Twitch Game ${String(igdbId)}`,
    box_art_url: `https://static-cdn.jtvnw.net/ttv-boxart/${categoryId}-{width}x{height}.jpg`,
    igdb_id: igdbId,
  };
}

/** A transport answering from data — no call-order coupling beyond the Helix cursors. */
interface FakeTwitch {
  transport: IgdbTransport;
  /** The `after` param of every Helix request (`null` for the first page) — the cursor-following pin. */
  afterCursors: (string | null)[];
  /** The IGDB ids of every `/games` hydration batch — the skip/dedupe pin. */
  requestedIds: number[][];
}

function fakeTwitch(options: FakeTwitchOptions): FakeTwitch {
  const afterCursors: (string | null)[] = [];
  const requestedIds: number[][] = [];
  const json = (body: readonly unknown[] | Record<string, never>, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // The production `first=100` page shape: every page but the last carries
  // the cursor the next request sends back as `after`.
  const pages: TwitchTopGame[][] = [];
  for (let index = 0; index < options.top.length; index += 100) {
    pages.push(options.top.slice(index, index + 100));
  }

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
    if (url.startsWith("https://api.twitch.tv/helix/games/top")) {
      if (options.failHelix) return json([{ error: "unavailable" }], 500);
      const after = new URL(url).searchParams.get("after");
      afterCursors.push(after);
      let pageIndex = 0;
      if (after !== null) {
        const match = /^cursor-(\d+)$/.exec(after);
        pageIndex = match ? Number(match[1]) : -1;
        if (pageIndex < 0 || pageIndex >= pages.length) {
          return new Response(JSON.stringify({ data: [], pagination: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      const entries = pages[pageIndex] ?? [];
      const cursor = pageIndex + 1 < pages.length ? `cursor-${pageIndex + 1}` : undefined;
      return new Response(JSON.stringify({ data: entries, pagination: cursor ? { cursor } : {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v4/games")) {
      const requested =
        /where id = \(([\d,]+)\)/
          .exec(init.body ?? "")?.[1]
          ?.split(",")
          .map(Number) ?? [];
      requestedIds.push(requested);
      const rows = requested
        .map((id) => options.games.get(id))
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
    afterCursors,
    requestedIds,
    transport: {
      fetch: (url, init) => Promise.resolve(route(url, init)),
    },
  };
}

/** The two-game DOOM fixture the hashtag tests reason with, hydrated. */
function doomGames(): Map<number, IgdbGameRow> {
  return new Map([
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
  ]);
}

function doomCovers(): Map<string, Uint8Array> {
  return new Map([
    ["co1993", JPEG],
    ["co2016", JPEG],
  ]);
}

/** A hydratable filler row: no cover, no dates, a distinct name/slug per id. */
function fillerGame(id: number): IgdbGameRow {
  return { id, name: `Filler Game ${id}`, slug: `filler-game-${id}` };
}

const FILLER_BASE = 5000;

/**
 * Pads a custom head of Helix entries out to a full `GAMES_CATALOG_SIZE`
 * snapshot with filler games. `headIds` declares the valid unique IGDB ids
 * the head contributes, in first-occurrence order — the test states what it
 * built, and a miscount fails the run loudly instead of passing quietly.
 */
function snapshot(head: readonly TwitchTopGame[], headIds: readonly number[]): FakeTwitchOptions {
  const avoid = new Set(headIds);
  const fillers: number[] = [];
  for (let id = FILLER_BASE; fillers.length < GAMES_CATALOG_SIZE - headIds.length; id++) {
    if (!avoid.has(id)) {
      avoid.add(id);
      fillers.push(id);
    }
  }
  return {
    top: [...head, ...fillers.map((id) => topEntry(String(id)))],
    games: new Map<number, IgdbGameRow>([
      ...doomGames(),
      ...fillers.map((id) => [id, fillerGame(id)] as const),
    ]),
    covers: doomCovers(),
  };
}

/** The standard two-DOOM catalog: igdb 20 ranks first, igdb 10 second, fillers after. */
function doomCatalog(): FakeTwitchOptions {
  return snapshot([topEntry("20"), topEntry("10")], [20, 10]);
}

async function runSync(options: FakeTwitchOptions, storage = testStorage) {
  const fake = fakeTwitch(options);
  const result = await syncGamesCatalog({
    db,
    storage,
    transport: fake.transport,
    clientId: "client-id",
    clientSecret: "client-secret",
    // Fixed clock: rank windows and release-year bounds never flake.
    now: () => new Date("2026-09-04T00:00:00Z"),
  });
  return { ...result, afterCursors: fake.afterCursors, requestedIds: fake.requestedIds };
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
  it("commits the snapshot: sticky collision keys, dense ranks, normalized labels, re-hosted covers", async () => {
    const result = await runSync(doomCatalog());

    expect(result).toMatchObject({
      scanned: GAMES_CATALOG_SIZE,
      knownIds: 0,
      newGames: GAMES_CATALOG_SIZE,
      coversUploaded: 2,
      coversFailed: 0,
    });

    const rows = await db.select().from(game);
    expect(rows).toHaveLength(GAMES_CATALOG_SIZE);
    const byId = new Map(rows.map((row) => [row.igdbId, row]));
    expect(byId.get(10)).toMatchObject({
      slug: "doom",
      // The lower IGDB id keeps the bare key; the 2016 collider takes the
      // year suffix.
      hashtagKey: "doom",
      // Rank follows the snapshot's returned order: 20 precedes 10, so the
      // 1993 classic ranks second TODAY.
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

  it("follows cursor pagination past the first 100-item page until the snapshot is complete", async () => {
    const result = await runSync(doomCatalog());

    expect(result.scanned).toBe(GAMES_CATALOG_SIZE);
    // Ten pages of 100: the first request carries no cursor, every later one
    // sends the previous page's cursor back as `after`.
    expect(result.afterCursors).toHaveLength(10);
    expect(result.afterCursors[0]).toBeNull();
    expect(new Set(result.afterCursors.slice(1)).size).toBe(9);

    // Ranks cross the page boundary without gaps: the snapshot is
    // [20, 10, 5000, 5001, …], so filler 5097 (index 99, last of page one)
    // ranks 100 and filler 5098 (index 100, first of page two) ranks 101.
    const rows = await db.select().from(game);
    const byId = new Map(rows.map((row) => [row.igdbId, row]));
    expect(byId.get(5097)?.popularityRank).toBe(100);
    expect(byId.get(5098)?.popularityRank).toBe(101);
  });

  it("skips non-game and malformed igdb_ids without consuming ranks or hydrating them", async () => {
    const head = [
      topEntry("", "Just Chatting"),
      topEntry(null, "IRL"),
      topEntry("0", "Zero"),
      topEntry("-7", "Negative"),
      topEntry("abc", "Gibberish"),
      topEntry("4.5", "Decimal"),
      topEntry("20"),
      topEntry("10"),
    ];
    const result = await runSync(snapshot(head, [20, 10]));

    expect(result.scanned).toBe(GAMES_CATALOG_SIZE);
    const rows = await db.select().from(game);
    const byId = new Map(rows.map((row) => [row.igdbId, row]));
    // The six skipped entries consumed no ranks: the first valid games rank
    // exactly as if the skips were never there.
    expect(byId.get(20)?.popularityRank).toBe(1);
    expect(byId.get(10)?.popularityRank).toBe(2);
    expect(byId.get(FILLER_BASE)?.popularityRank).toBe(3);
    // And none of them ever reached IGDB hydration — every requested id is
    // a positive integer, so no skip or malformed spelling was looked up.
    for (const batch of result.requestedIds) {
      for (const id of batch) expect(id).toBeGreaterThan(0);
    }
    expect(rows.find((row) => row.name === "Just Chatting")).toBeUndefined();
  });

  it("deduplicates repeated igdb_ids, keeping the first occurrence's rank", async () => {
    const head = [topEntry("20"), topEntry("10"), topEntry("20"), topEntry("10")];
    const result = await runSync(snapshot(head, [20, 10]));

    expect(result.scanned).toBe(GAMES_CATALOG_SIZE);
    const rows = await db.select().from(game);
    const byId = new Map(rows.map((row) => [row.igdbId, row]));
    expect(byId.get(20)?.popularityRank).toBe(1);
    expect(byId.get(10)?.popularityRank).toBe(2);
    expect(byId.get(FILLER_BASE)?.popularityRank).toBe(3);
    // Each id hydrated exactly once, however often Twitch repeated it.
    const flat = result.requestedIds.flat();
    expect(flat.filter((id) => id === 20)).toHaveLength(1);
    expect(flat.filter((id) => id === 10)).toHaveLength(1);
  });

  it("assigns stable dense ranks 1..N across the snapshot in Twitch order", async () => {
    await runSync(doomCatalog());

    const rows = await db.select().from(game);
    const ranks = rows.map((row) => row.popularityRank).sort((a, b) => (a ?? 0) - (b ?? 0));
    // Dense: every integer exactly once, no gaps from skips or duplicates.
    expect(ranks).toEqual(Array.from({ length: GAMES_CATALOG_SIZE }, (_, index) => index + 1));
    // Stable: the rank is the first-occurrence position — [20, 10, 5000, …].
    const byId = new Map(rows.map((row) => [row.igdbId, row]));
    expect(byId.get(20)?.popularityRank).toBe(1);
    expect(byId.get(10)?.popularityRank).toBe(2);
    expect(byId.get(FILLER_BASE)?.popularityRank).toBe(3);
    expect(byId.get(FILLER_BASE + GAMES_CATALOG_SIZE - 3)?.popularityRank).toBe(GAMES_CATALOG_SIZE);
  });

  it("fails closed when the snapshot ends before GAMES_CATALOG_SIZE unique games", async () => {
    await expect(
      runSync({
        top: [topEntry("20"), topEntry("10"), topEntry("", "Just Chatting")],
        games: doomGames(),
        covers: new Map(),
      }),
    ).rejects.toThrow(/ended after 2 unique games/);
    // Nothing was staged, so nothing was written.
    expect(await db.select().from(game)).toHaveLength(0);
    expect([...testStorageObjects.keys()]).toEqual([]);
  });

  it("is fail-closed: a run whose API fails leaves the previous catalog byte-identical", async () => {
    await upsertGames(
      db,
      [stagedRow({ igdbId: 10, name: "DOOM", hashtagKey: "doom", slug: "doom" })],
      new Date(),
    );
    const before = await db.select().from(game);
    testStorageObjects.clear();

    await expect(runSync({ ...doomCatalog(), failHelix: true })).rejects.toMatchObject({
      reason: "server",
    });

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
    expect(second).toMatchObject({
      knownIds: GAMES_CATALOG_SIZE,
      newGames: 0,
      coversKept: 2,
      coversUploaded: 0,
    });

    const after = (await db.select().from(game)).find((row) => row.igdbId === 10);
    expect(after?.coverMediaPath).toBe(before?.coverMediaPath);
  });

  it("re-hosts a changed cover, content-addressed, and removes the superseded object after commit", async () => {
    const catalog = doomCatalog();
    await runSync(catalog);

    const changed: FakeTwitchOptions = {
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

    const failing: FakeTwitchOptions = {
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

    // Run 2: only igdb 20 is in the snapshot (padded with fillers to the
    // full size); 10 is a dropout but still hydratable (its id is known, so
    // the union re-hydrates it).
    const dropoutScan = snapshot([topEntry("20")], [20]);
    await runSync(dropoutScan);

    const rows = await db.select().from(game);
    // The dropout plus the filler's replacement: run 2's snapshot holds one
    // filler (5998) run 1 never saw, while dropout 10 survives beside it —
    // the catalog never shrinks (Q29).
    expect(rows).toHaveLength(GAMES_CATALOG_SIZE + 1);
    const dropout = rows.find((row) => row.igdbId === 10);
    // Last-known rank (2 from run 1) — not null, and not clamped to the new
    // snapshot's composition; ordering dropouts "by where they last placed"
    // (Q29) is exactly this column's meaning.
    expect(dropout?.popularityRank).toBe(2);
    expect(dropout?.name).toBe("DOOM");

    // Run 3: the dropout stops hydrating entirely — the row still survives,
    // verbatim, with its sticky key and last-known rank (Q29).
    const vanished: FakeTwitchOptions = {
      ...dropoutScan,
      games: new Map([...dropoutScan.games].filter(([id]) => id !== 10)),
    };
    await runSync(vanished);

    const survivor = (await db.select().from(game)).find((row) => row.igdbId === 10);
    expect(survivor).toMatchObject({ hashtagKey: "doom", popularityRank: 2, slug: "doom" });
  });
});
