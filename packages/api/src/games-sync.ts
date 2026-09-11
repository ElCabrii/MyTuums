/**
 * Fetch and validate a complete IGDB/Twitch catalog under a fenced D1 lease.
 * game-catalog.ts stages invisible rows and atomically publishes their live
 * projection with an active-version pointer. Existing IDs, hashtag assignments,
 * creation times and favorites survive every refresh, including IGDB dropouts.
 *
 * Cover uploads have version-specific immutable paths protected by media intents.
 * Publication consumes live intents and records superseded-object cleanup in
 * the same transaction. Failed runs keep the previous public catalog intact.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { game } from "@my-tuums/db/schema";
import {
  beginGameCatalog,
  cleanupGameCatalogVersions,
  publishGameCatalog,
  releaseGameCatalog,
  stageGameCatalog,
} from "./game-catalog.js";
import {
  GAME_GENRES_MAX,
  GAME_LABEL_MAX_LENGTH,
  GAME_PLATFORMS_MAX,
  GAME_SUMMARY_MAX_LENGTH,
  GAMES_CATALOG_SIZE,
  GAMES_HYDRATION_BATCH,
  GAMES_POPULARITY_PAGE_SIZE,
  GAMES_POPULARITY_SCAN_LIMIT,
  GAMES_TWITCH_SIZE,
  GAMES_UPCOMING_SIZE,
} from "./constants.js";
import { gameCoverObjectKey } from "./game-media.js";
import { assignHashtagKeys, type HashtagCandidate } from "./games-hashtag.js";
import {
  createIgdbClient,
  createIgdbTransport,
  igdbGameRowSchema,
  type IgdbGameRow,
  type IgdbClient,
  type IgdbTransport,
  type TwitchTopGame,
} from "./igdb.js";

// The transport factory rides along on this module's exports: it is the
// entrypoint's one import surface for everything sync-shaped, and there is
// no `./igdb` package subpath for the container to reach instead.
export { createIgdbTransport };
import { IMAGE_EXTENSION, mediaPathFor } from "./image.js";
import type { ObjectStorage } from "./object-storage.js";
import { beginMediaUpload, cleanupMediaIntents } from "./media-intents.js";

/** A validated catalog row, ready to upsert. The fixture's exact shape. */
export interface StagedGameRow {
  igdbId: number;
  slug: string;
  hashtagKey: string;
  name: string;
  summary: string | null;
  coverMediaPath: string | null;
  coverImageId: string | null;
  firstReleaseYear: number | null;
  /** IGDB `first_release_date` as unix seconds — null means TBA. */
  firstReleaseDate: number | null;
  /** IGDB `hypes` — the pre-release want count the upcoming sort orders by. */
  hypeCount: number;
  genres: string[];
  platforms: string[];
  popularityRank: number | null;
}

/**
 * The staged catalog violated an invariant — thrown BEFORE any write, so the
 * previous catalog survives untouched. Accepts one violation or a whole
 * list, so a bad sync is diagnosed in one run, not one per week.
 */
export class CatalogValidationError extends Error {
  readonly violations: readonly string[];

  constructor(violations: string | readonly string[]) {
    const list = Array.isArray(violations) ? violations : [violations];
    super(`Staged game catalog failed validation: ${list.join("; ")}`);
    this.name = "CatalogValidationError";
    this.violations = list;
  }
}

export interface SyncGamesResult {
  /** Games the popularity scan ranked this run. */
  scanned: number;
  /** Unique games selected from Twitch and IGDB popularity, before upcoming and retained rows. */
  selected: number;
  /** Unreleased games the hypes scan returned this run. */
  upcoming: number;
  /** Games the table already held before this run. */
  knownIds: number;
  /** Games receiving their first row this run. */
  newGames: number;
  coversUploaded: number;
  coversKept: number;
  /** Per-cover failures — each kept the previous cover and will retry. */
  coversFailed: number;
}

/**
 * Normalizes one Twitch `games/top` entry to the IGDB id the catalog stores,
 * or null when the entry is not a storable game. Non-game categories (Just
 * Chatting, IRL, Slots, …) arrive with an empty `igdb_id`; anything that is
 * not a positive integer is malformed. Twitch's category `id` is never
 * consulted — it names the category, not the game.
 */
function twitchIgdbId(entry: Pick<TwitchTopGame, "igdb_id">): number | null {
  const text = (entry.igdb_id ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Parses one IGDB response page against its wire schema, mapping a mismatch
 * to the sync's own validation failure — an IGDB that stops speaking the
 * shape this sync stages is a fail-closed event (Q28), not a cast.
 */
function parsePage<Row>(schema: z.ZodType<Row>, endpoint: string, rows: readonly unknown[]): Row[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) {
    throw new CatalogValidationError(
      `${endpoint} returned rows in an unexpected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
    );
  }
  return parsed.data;
}

/** Direct row insertion is reserved for integration fixtures. */
type GameWriter = Pick<Database, "insert">;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Display labels: trimmed, non-empty, length-capped, count-capped, in IGDB's order. */
function normalizeLabels(
  source: { name?: string | null }[] | null | undefined,
  maxCount: number,
): string[] {
  const labels: string[] = [];
  for (const entry of source ?? []) {
    const label = (entry.name ?? "").trim();
    if (label === "" || label.length > GAME_LABEL_MAX_LENGTH) continue;
    if (!labels.includes(label)) labels.push(label);
    if (labels.length === maxCount) break;
  }
  return labels;
}

function releaseYear(firstReleaseDate: number | null | undefined): number | null {
  if (firstReleaseDate == null) return null;
  const year = new Date(firstReleaseDate * 1000).getUTCFullYear();
  return Number.isFinite(year) ? year : null;
}

/**
 * Integration fixture helper. Production sync and seeding use game-catalog.ts.
 * `hashtagKey` and `createdAt`
 * are deliberately ABSENT from the `set` clause: an existing key is sticky
 * (Q29) and a creation timestamp is a creation timestamp — the omission is
 * the rule, not an oversight.
 */
export async function upsertGames(
  writer: GameWriter,
  rows: readonly StagedGameRow[],
  now: Date,
): Promise<void> {
  // Each row has 14 bound values; five rows leave room below D1's 100-parameter limit.
  for (const batch of chunk(rows, 5)) {
    await writer
      .insert(game)
      .values(
        batch.map((row) => ({
          ...row,
          genres: [...row.genres],
          platforms: [...row.platforms],
          lastSyncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: game.igdbId,
        set: {
          slug: sql`excluded.slug`,
          name: sql`excluded.name`,
          summary: sql`excluded.summary`,
          coverMediaPath: sql`excluded.cover_media_path`,
          coverImageId: sql`excluded.cover_image_id`,
          firstReleaseYear: sql`excluded.first_release_year`,
          firstReleaseDate: sql`excluded.first_release_date`,
          hypeCount: sql`excluded.hype_count`,
          genres: sql`excluded.genres`,
          platforms: sql`excluded.platforms`,
          popularityRank: sql`excluded.popularity_rank`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      });
  }
}

export function validateStaged(rows: readonly StagedGameRow[], maxYear: number): void {
  const violations: string[] = [];
  const seenIds = new Set<number>();
  const seenKeys = new Set<string>();

  if (rows.length === 0) violations.push("no games staged");
  for (const row of rows) {
    if (seenIds.has(row.igdbId)) violations.push(`duplicate igdb id ${row.igdbId}`);
    seenIds.add(row.igdbId);

    if (row.name.trim() === "") violations.push(`igdb ${row.igdbId} has an empty name`);
    if (row.slug.trim() === "") violations.push(`igdb ${row.igdbId} has an empty slug`);
    if (!/^[a-z0-9]+$/.test(row.hashtagKey)) {
      violations.push(`igdb ${row.igdbId} has a non-alphanumeric hashtag key "${row.hashtagKey}"`);
    }
    if (seenKeys.has(row.hashtagKey)) {
      violations.push(`duplicate hashtag key "${row.hashtagKey}" (igdb ${row.igdbId})`);
    }
    seenKeys.add(row.hashtagKey);

    if (
      row.firstReleaseYear !== null &&
      (row.firstReleaseYear < 1890 || row.firstReleaseYear > maxYear)
    ) {
      violations.push(`igdb ${row.igdbId} has an implausible release year ${row.firstReleaseYear}`);
    }
    if (
      row.popularityRank !== null &&
      (row.popularityRank < 1 || row.popularityRank > GAMES_TWITCH_SIZE)
    ) {
      // Bounded by the scan's ceiling, NOT the current scan's size: a
      // dropout keeps its last-known rank (Q29), which legitimately exceeds
      // a later, smaller scan's count.
      violations.push(
        `igdb ${row.igdbId} has rank ${row.popularityRank} outside 1..${GAMES_TWITCH_SIZE}`,
      );
    }
    if (!Number.isInteger(row.hypeCount) || row.hypeCount < 0) {
      violations.push(`igdb ${row.igdbId} has an invalid hype count ${row.hypeCount}`);
    }
    if (row.firstReleaseDate !== null && !Number.isInteger(row.firstReleaseDate)) {
      violations.push(`igdb ${row.igdbId} has an invalid release date ${row.firstReleaseDate}`);
    }
  }

  if (violations.length > 0) throw new CatalogValidationError(violations);
}

async function hydrateGames(client: IgdbClient, ids: readonly number[]): Promise<IgdbGameRow[]> {
  const hydrated: IgdbGameRow[] = [];
  for (const batch of chunk(ids, GAMES_HYDRATION_BATCH)) {
    hydrated.push(
      ...parsePage(
        igdbGameRowSchema,
        "games",
        await client.query(
          "games",
          `fields name,slug,summary,first_release_date,hypes,cover.image_id,genres.name,platforms.abbreviation,platforms.name; where id = (${batch.join(",")}); limit ${GAMES_HYDRATION_BATCH};`,
        ),
      ),
    );
  }
  return hydrated;
}

interface SyncGamesDeps {
  db: Database;
  storage: Pick<ObjectStorage, "put" | "remove"> | null;
  transport: IgdbTransport;
  clientId: string;
  clientSecret: string;
  now?: () => Date;
  /** Scheduled retries must never replace an identical or newer published snapshot. */
  skipIfCurrent?: boolean;
}

export async function syncGamesCatalog(deps: SyncGamesDeps): Promise<SyncGamesResult> {
  const now = deps.now?.() ?? new Date();
  const version = await beginGameCatalog(deps.db, now, deps.skipIfCurrent);
  try {
    return await buildGamesCatalog(deps, version, now);
  } finally {
    await releaseGameCatalog(deps.db, version);
    await cleanupGameCatalogVersions(deps.db).catch(() => {
      console.error({ event: "catalog_version_cleanup_deferred" });
    });
  }
}

async function buildGamesCatalog(
  deps: SyncGamesDeps,
  version: string,
  now: Date,
): Promise<SyncGamesResult> {
  const client = createIgdbClient({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    transport: deps.transport,
  });

  // 1. The Twitch popularity snapshot: `games/top` pages in returned order
  //    (current viewer count, most popular first), `first=100` per page,
  //    following `pagination.cursor` until GAMES_TWITCH_SIZE unique, valid
  //    IGDB ids are collected. Ranks are dense by first occurrence — Twitch's
  //    own order. Non-game categories carry an empty `igdb_id` and are
  //    skipped, as are malformed ids and repeats; only the `igdb_id` ever
  //    becomes a rank, never Twitch's category `id`.
  const ranks = new Map<number, number>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listTopGamesPage(cursor);
    if (page.games.length === 0) break;
    for (const entry of page.games) {
      const id = twitchIgdbId(entry);
      if (id === null || ranks.has(id)) continue;
      ranks.set(id, ranks.size + 1);
      if (ranks.size === GAMES_TWITCH_SIZE) break;
    }
    if (ranks.size === GAMES_TWITCH_SIZE) break;
    // No cursor means no further pages; a repeated cursor means the pages
    // loop — either way the snapshot is exhausted, and the size check below
    // fails the run closed instead of looping forever.
    const next = page.cursor;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  if (ranks.size < GAMES_TWITCH_SIZE) {
    throw new CatalogValidationError(
      ranks.size === 0
        ? "the Twitch popularity snapshot returned no games — refusing to sync an empty catalog"
        : `the Twitch popularity snapshot ended after ${ranks.size} unique games — need ${GAMES_TWITCH_SIZE} to rank the catalog`,
    );
  }

  // Expand directory coverage without inventing Twitch ranks for IGDB-only games.
  // Page visits (popularity type 1) supply candidates in descending order.
  const catalogIds = new Set(ranks.keys());
  const checkedCandidates = new Set(ranks.keys());
  const hydrated = new Map<number, IgdbGameRow>();
  for (let offset = 0; offset < GAMES_POPULARITY_SCAN_LIMIT; offset += GAMES_POPULARITY_PAGE_SIZE) {
    const rows = parsePage(
      z.object({ game_id: z.number().int().positive().safe() }),
      "popularity_primitives",
      await client.query(
        "popularity_primitives",
        `fields game_id; where popularity_type = 1; sort value desc; limit ${GAMES_POPULARITY_PAGE_SIZE}; offset ${offset};`,
      ),
    );
    // IGDB popularity can outlive its game record (production game 417145).
    // Only count returned game records, and reuse them during final staging.
    const candidateIds: number[] = [];
    for (const row of rows) {
      if (checkedCandidates.has(row.game_id)) continue;
      checkedCandidates.add(row.game_id);
      candidateIds.push(row.game_id);
    }
    const candidates = new Map(
      (await hydrateGames(client, candidateIds)).map((row) => [row.id, row]),
    );
    for (const id of candidateIds) {
      const candidate = candidates.get(id);
      if (!candidate) continue;
      catalogIds.add(id);
      hydrated.set(id, candidate);
      if (catalogIds.size === GAMES_CATALOG_SIZE) break;
    }
    if (catalogIds.size === GAMES_CATALOG_SIZE || rows.length < GAMES_POPULARITY_PAGE_SIZE) break;
  }
  if (catalogIds.size < GAMES_CATALOG_SIZE) {
    throw new CatalogValidationError(
      `the combined popularity catalog contains ${catalogIds.size} unique games — need ${GAMES_CATALOG_SIZE}`,
    );
  }

  // 2. The upcoming scan: unreleased games by most-wanted first — IGDB
  //    `hypes` DESC, TBA or future release only. Twitch ranks what people
  //    watch now; this ranks what they want next, and feeds the `/games`
  //    upcoming sort. Fail-closed like the snapshot: an empty answer refuses
  //    the run rather than wiping the upcoming shelf.
  const upcomingIds: number[] = [];
  {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const upcomingRows = parsePage(
      z.object({ id: z.number() }),
      "games",
      await client.query(
        "games",
        `fields id; where hypes > 0 & (first_release_date > ${nowSeconds} | first_release_date = null); sort hypes desc; limit ${GAMES_UPCOMING_SIZE};`,
      ),
    );
    for (const row of upcomingRows) {
      if (!upcomingIds.includes(row.id)) upcomingIds.push(row.id);
    }
  }

  // 3. Every id this run must leave better than it found it: the combined catalog's
  //    set UNION the upcoming set UNION every id the table already holds
  //    (Q29's "every sync refreshes ALL known games").
  const knownRows = await deps.db.select().from(game);
  const known = new Map(knownRows.map((row) => [row.igdbId, row]));
  const allIds = new Set<number>([...catalogIds, ...upcomingIds, ...known.keys()]);

  // Popularity candidates are already hydrated; refresh the remaining Twitch,
  // upcoming and known games through the same batched reader.
  const remainingIds = [...allIds].filter((id) => !hydrated.has(id));
  for (const row of await hydrateGames(client, remainingIds)) hydrated.set(row.id, row);

  // 4. Stage. A CURRENT snapshot member IGDB fails to hydrate is a validation
  //    failure (the snapshot says it exists); a dropout IGDB no longer returns
  //    is tolerated — staged verbatim from its existing row.
  const staged: StagedGameRow[] = [];
  const newCandidates: HashtagCandidate[] = [];
  for (const id of allIds) {
    const source = hydrated.get(id);
    const existing = known.get(id);

    if (!source) {
      // A dropout IGDB no longer hydrates: tolerated, staged verbatim from
      // its existing row (Q29) — rank keeps its last-known value below.
      if (!existing) throw new CatalogValidationError(`igdb ${id} is neither hydrated nor known`);
      staged.push({
        igdbId: existing.igdbId,
        slug: existing.slug,
        hashtagKey: existing.hashtagKey,
        name: existing.name,
        summary: existing.summary,
        coverMediaPath: existing.coverMediaPath,
        coverImageId: existing.coverImageId,
        firstReleaseYear: existing.firstReleaseYear,
        firstReleaseDate: existing.firstReleaseDate,
        hypeCount: existing.hypeCount,
        genres: [...existing.genres],
        platforms: [...existing.platforms],
        popularityRank: existing.popularityRank,
      });
      continue;
    }

    if (source.name.trim() === "") {
      throw new CatalogValidationError(`igdb ${id} hydrated with no name`);
    }
    const year = releaseYear(source.first_release_date);
    if (!existing && source.slug.trim() === "") {
      throw new CatalogValidationError(`igdb ${id} is new but hydrated with no slug`);
    }

    staged.push({
      igdbId: id,
      slug: (source.slug || existing?.slug || "").trim(),
      // Placeholder for rows that already hold a key; filled for new ids below.
      hashtagKey: existing?.hashtagKey ?? "",
      name: source.name.trim(),
      summary:
        source.summary != null && source.summary.trim() !== ""
          ? truncate(source.summary.trim(), GAME_SUMMARY_MAX_LENGTH)
          : null,
      // The cover decision comes after validation — see step 8.
      coverMediaPath: existing?.coverMediaPath ?? null,
      coverImageId: source.cover?.image_id ?? null,
      firstReleaseYear: year,
      firstReleaseDate: source.first_release_date ?? null,
      hypeCount: source.hypes ?? 0,
      genres: normalizeLabels(source.genres, GAME_GENRES_MAX),
      platforms: normalizeLabels(
        (source.platforms ?? []).map((platform) => ({
          name: platform.abbreviation ?? platform.name ?? null,
        })),
        GAME_PLATFORMS_MAX,
      ),
      popularityRank: ranks.get(id) ?? existing?.popularityRank ?? null,
    });

    if (!existing) {
      newCandidates.push({ igdbId: id, name: source.name, firstReleaseYear: year });
    }
  }

  // 5. Sticky keys for the newcomers; `occupied` is every key an existing
  //    row holds, so an incumbent can never be displaced.
  const assignments = assignHashtagKeys(
    newCandidates,
    new Set(knownRows.map((row) => row.hashtagKey)),
  );
  for (const row of staged) {
    const assigned = assignments.get(row.igdbId);
    if (assigned !== undefined) row.hashtagKey = assigned;
  }

  // 6. Validate everything, before any write (the Q28 pin).
  validateStaged(staged, now.getUTCFullYear() + 5);

  // 7. Covers — bucket-only, before the transaction, only where IGDB's image
  //    id CHANGED (the incremental rule, Q27). A cover's failure keeps the
  //    previous cover AND its compare key, so the next sync retries; a
  //    vanished cover (image id gone) nulls both out per Q28's
  //    "optional-field gaps null out".
  const result: SyncGamesResult = {
    scanned: ranks.size,
    selected: catalogIds.size,
    upcoming: upcomingIds.length,
    knownIds: knownRows.length,
    newGames: assignments.size,
    coversUploaded: 0,
    coversKept: 0,
    coversFailed: 0,
  };
  if (deps.storage) {
    for (const row of staged) {
      const existing = known.get(row.igdbId);
      const desiredImageId = row.coverImageId;
      if (desiredImageId !== null && desiredImageId === existing?.coverImageId) {
        result.coversKept++;
        continue;
      }

      if (desiredImageId === null) {
        row.coverMediaPath = null;
        row.coverImageId = null;
        continue;
      }

      try {
        const cover = await client.fetchCoverImage(desiredImageId);
        const key = gameCoverObjectKey(
          row.igdbId,
          desiredImageId,
          IMAGE_EXTENSION[cover.contentType],
          version,
        );
        await beginMediaUpload(deps.db, `catalog:${version}`, [mediaPathFor(key)]);
        await deps.storage.put(key, cover.bytes, cover.contentType);
        row.coverMediaPath = mediaPathFor(key);
        row.coverImageId = desiredImageId;
        result.coversUploaded++;
      } catch {
        // Per-cover tolerance (Q28): warn, keep the old cover and its
        // compare key so the change retries next run.
        result.coversFailed++;
        row.coverMediaPath = existing?.coverMediaPath ?? null;
        row.coverImageId = existing?.coverImageId ?? null;
        console.warn({ event: "game_cover_deferred", gameId: row.igdbId });
      }
    }
  } else if (staged.length > 0) {
    console.warn(
      "games-sync: no storage configured — covers skipped, catalog synced without cover changes",
    );
    for (const row of staged) {
      const existing = known.get(row.igdbId);
      row.coverMediaPath = existing?.coverMediaPath ?? null;
      row.coverImageId = existing?.coverImageId ?? null;
    }
  }

  // 8. Stage invisibly, then publish the complete projection and pointer atomically.
  await stageGameCatalog(deps.db, version, staged);
  await publishGameCatalog(deps.db, version, staged.length);

  // The publication trigger records obsolete immutable paths. Failed removals retry.
  if (deps.storage) {
    await cleanupMediaIntents(deps.db, deps.storage, "catalog").catch(() => {
      console.error({ event: "catalog_cleanup_deferred" });
    });
  }

  return result;
}
