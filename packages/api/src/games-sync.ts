/**
 * The game-catalog sync (issue #314): stage, validate, commit — in that
 * order, with exactly ONE transaction at the end.
 *
 * Fail-closed (Q28) is the whole design: every IGDB call, derivation and
 * check happens BEFORE the commit transaction, so any failure — a refused
 * token, a 5xx that survives its one retry, a game that fails validation —
 * throws with the previous catalog byte-identical, and the entrypoint
 * (`apps/server/src/games-sync.ts`) turns that into exit 1 so Railway marks
 * the cron run FAILED.
 *
 * Never delete, never freeze (Q29): the scan reads the current top set by
 * Twitch-hours-watched, but the ids hydrated are the union of that set with
 * EVERY id the `game` table already holds — dropouts are re-staged from
 * their existing row (IGDB-side removal tolerated), keep their last-known
 * `popularityRank`, and a dropout IGDB no longer returns at all survives
 * verbatim. That is also why the upsert never rewrites `hashtagKey` or
 * `createdAt` (see `./games-hashtag.ts` for the stickiness reasoning).
 *
 * Covers are the one thing that cannot be transactional — they are bucket
 * writes. They happen BEFORE the transaction under content-addressed keys
 * (`games/<igdbId>-<imageId>.<ext>`, see `./game-media.ts`), which makes
 * them idempotent instead: a run that dies after uploading leaves exactly
 * the objects the next successful run writes and references. Superseded
 * objects are removed best-effort AFTER the commit, the link-card ordering.
 *
 * `upsertGames` is the single row-write path, shared with the fixture
 * seeder (`scripts/seed-games.ts`) so the two writers cannot drift.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { game } from "@my-tuums/db/schema";
import {
  GAME_GENRES_MAX,
  GAME_LABEL_MAX_LENGTH,
  GAME_PLATFORMS_MAX,
  GAME_SUMMARY_MAX_LENGTH,
  GAMES_CATALOG_SIZE,
  GAMES_HYDRATION_BATCH,
  IGDB_POPULARITY_TYPE_NAME,
} from "./constants.js";
import { gameCoverObjectKey } from "./game-media.js";
import { assignHashtagKeys, type HashtagCandidate } from "./games-hashtag.js";
import {
  createIgdbClient,
  createIgdbTransport,
  igdbGameRowSchema,
  igdbPopularityPrimitiveSchema,
  igdbPopularityTypeSchema,
  type IgdbGameRow,
  type IgdbTransport,
} from "./igdb.js";

// The transport factory rides along on this module's exports: it is the
// entrypoint's one import surface for everything sync-shaped, and there is
// no `./igdb` package subpath for the container to reach instead.
export { createIgdbTransport };
import { IMAGE_EXTENSION, mediaPathFor } from "./image.js";
import type { Storage } from "./storage.js";

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

/** The subset of `Database` upserts need — satisfied by `db` and any `tx`. */
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
 * The single row-write path (sync + seeder). `hashtagKey` and `createdAt`
 * are deliberately ABSENT from the `set` clause: an existing key is sticky
 * (Q29) and a creation timestamp is a creation timestamp — the omission is
 * the rule, not an oversight.
 */
export async function upsertGames(
  writer: GameWriter,
  rows: readonly StagedGameRow[],
  now: Date,
): Promise<void> {
  for (const batch of chunk(rows, GAMES_HYDRATION_BATCH)) {
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
          genres: sql`excluded.genres`,
          platforms: sql`excluded.platforms`,
          popularityRank: sql`excluded.popularity_rank`,
          lastSyncedAt: sql`excluded.last_synced_at`,
        },
      });
  }
}

function validateStaged(rows: readonly StagedGameRow[], maxYear: number): void {
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
      (row.popularityRank < 1 || row.popularityRank > GAMES_CATALOG_SIZE)
    ) {
      // Bounded by the scan's ceiling, NOT the current scan's size: a
      // dropout keeps its last-known rank (Q29), which legitimately exceeds
      // a later, smaller scan's count.
      violations.push(
        `igdb ${row.igdbId} has rank ${row.popularityRank} outside 1..${GAMES_CATALOG_SIZE}`,
      );
    }
  }

  if (violations.length > 0) throw new CatalogValidationError(violations);
}

/**
 * The committed fixture's location — hand-authored seed data in
 * `packages/db/fixtures/` (issue Q27), read at runtime so the JSON never
 * compiles into a second copy. Only ever executed from source (the seeder
 * script and e2e's global setup, both tsx-run); the container bundles the
 * sync only, which never reads the fixture.
 */
function gamesFixturePath(): string {
  return new URL("../../db/fixtures/games.json", import.meta.url).pathname;
}

function gamesFixtureCoversDir(): string {
  return new URL("../../db/fixtures/covers", import.meta.url).pathname;
}

/**
 * The fixture file's own schema — a hand-authored file is still external
 * input (a hand-edit can break it), so it is parsed at the read boundary
 * like every other I/O. Exported for `games-fixture.test.ts`, which pins
 * the file's semantic contract on top of this shape contract.
 */
export const stagedGameFixtureSchema = z.object({
  igdbId: z.number(),
  slug: z.string().min(1),
  hashtagKey: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().nullable(),
  coverImageId: z.string().nullable(),
  firstReleaseYear: z.number().nullable(),
  genres: z.array(z.string()),
  platforms: z.array(z.string()),
  popularityRank: z.number().nullable(),
});

/** Reads and shape-checks the fixture; throws plainly on a hand-edit that breaks it. */
function readGamesFixture(): StagedGameRow[] {
  const parsed = stagedGameFixtureSchema
    .array()
    .safeParse(JSON.parse(readFileSync(gamesFixturePath(), "utf8")));
  if (!parsed.success) {
    throw new Error(
      `packages/db/fixtures/games.json failed its schema: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(", ")}`,
    );
  }
  return parsed.data.map((row) => ({ ...row, coverMediaPath: null }));
}

/**
 * Seeds the catalog from the committed fixture — the dev/CI/e2e data source
 * (issue Q27), and the only writer besides the sync itself. Upserts through
 * the same `upsertGames`, so a re-seed is idempotent and the two writers
 * cannot drift.
 *
 * Covers upload only when a bucket is configured (the whole S3_* group or
 * none — the same rule `context.ts` applies); without one the catalog is
 * seeded bare rather than failing, mirroring how uploads degrade. A cover
 * failure here fails the seed: unlike the sync's per-game tolerance, the
 * fixture's covers are local files with no remote to fail against.
 */
export async function seedGamesFixture(deps: {
  db: Database;
  storage: Storage | null;
  now?: () => Date;
}): Promise<{ seeded: number; coversUploaded: number }> {
  const now = deps.now?.() ?? new Date();
  const rows = readGamesFixture();
  let coversUploaded = 0;

  if (deps.storage) {
    for (const row of rows) {
      if (!row.coverImageId) continue;
      const bytes = new Uint8Array(
        readFileSync(join(gamesFixtureCoversDir(), `${row.coverImageId}.jpg`)),
      );
      const key = gameCoverObjectKey(row.igdbId, row.coverImageId, "jpg");
      await deps.storage.put(key, bytes, "image/jpeg");
      row.coverMediaPath = mediaPathFor(key);
      coversUploaded++;
    }
  }

  await deps.db.transaction(async (tx) => {
    await upsertGames(tx, rows, now);
  });
  return { seeded: rows.length, coversUploaded };
}

export async function syncGamesCatalog(deps: {
  db: Database;
  storage: Storage | null;
  transport: IgdbTransport;
  clientId: string;
  clientSecret: string;
  now?: () => Date;
}): Promise<SyncGamesResult> {
  const now = deps.now?.() ?? new Date();
  const client = createIgdbClient({
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    transport: deps.transport,
  });

  // 1. Resolve the popularity type BY NAME (Q2) — the numeric id is not
  //    stable across IGDB environments, and the docs only enumerate a few.
  const types = parsePage(
    igdbPopularityTypeSchema,
    "popularity_types",
    await client.query("popularity_types", "fields id,name; limit 100;"),
  );
  const popularityTypeId = types.find((type) => type.name === IGDB_POPULARITY_TYPE_NAME)?.id;
  if (popularityTypeId === undefined) {
    throw new CatalogValidationError(
      types.length === 0
        ? "popularity_types returned no rows — cannot rank the catalog"
        : `popularity_types has no "${IGDB_POPULARITY_TYPE_NAME}" (received: ${types
            .map((type) => type.name)
            .join(", ")})`,
    );
  }

  // 2. The popularity scan: pages of the top set by value desc. Ranks are
  //    dense by first occurrence, which is the scan's own order.
  const ranks = new Map<number, number>();
  for (let offset = 0; offset < GAMES_CATALOG_SIZE; offset += GAMES_HYDRATION_BATCH) {
    const rows = parsePage(
      igdbPopularityPrimitiveSchema,
      "popularity_primitives",
      await client.query(
        "popularity_primitives",
        `fields game_id,value; where popularity_type = ${popularityTypeId} & game_id != null; sort value desc; limit ${GAMES_HYDRATION_BATCH}; offset ${offset};`,
      ),
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.game_id === null) continue;
      if (!ranks.has(row.game_id)) ranks.set(row.game_id, ranks.size + 1);
    }
    if (rows.length < GAMES_HYDRATION_BATCH) break;
  }
  if (ranks.size === 0) {
    throw new CatalogValidationError(
      "the popularity scan returned no games — refusing to sync an empty catalog",
    );
  }

  // 3. Every id this run must leave better than it found it: the scan's top
  //    set UNION every id the table already holds (Q29's "every sync
  //    refreshes ALL known games").
  const knownRows = await deps.db.select().from(game);
  const known = new Map(knownRows.map((row) => [row.igdbId, row]));
  const allIds = new Set<number>([...ranks.keys(), ...known.keys()]);

  // 4. Hydration, id-batched, one request per batch (sub-expansion inline —
  //    three separate /covers /genres /platforms calls would triple the
  //    requests for a join no client-side code performs).
  const hydrated = new Map<number, IgdbGameRow>();
  for (const batch of chunk([...allIds], GAMES_HYDRATION_BATCH)) {
    const rows = parsePage(
      igdbGameRowSchema,
      "games",
      await client.query(
        "games",
        `fields name,slug,summary,first_release_date,cover.image_id,genres.name,platforms.abbreviation,platforms.name; where id = (${batch.join(",")}); limit ${GAMES_HYDRATION_BATCH};`,
      ),
    );
    for (const row of rows) hydrated.set(row.id, row);
  }

  // 5. Stage. A CURRENT scan member IGDB fails to hydrate is a validation
  //    failure (popularity says it exists); a dropout IGDB no longer returns
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

  // 6. Sticky keys for the newcomers; `occupied` is every key an existing
  //    row holds, so an incumbent can never be displaced.
  const assignments = assignHashtagKeys(
    newCandidates,
    new Set(knownRows.map((row) => row.hashtagKey)),
  );
  for (const row of staged) {
    const assigned = assignments.get(row.igdbId);
    if (assigned !== undefined) row.hashtagKey = assigned;
  }

  // 7. Validate everything, before any write (the Q28 pin).
  validateStaged(staged, now.getUTCFullYear() + 5);

  // 8. Covers — bucket-only, before the transaction, only where IGDB's image
  //    id CHANGED (the incremental rule, Q27). A cover's failure keeps the
  //    previous cover AND its compare key, so the next sync retries; a
  //    vanished cover (image id gone) nulls both out per Q28's
  //    "optional-field gaps null out".
  const result: SyncGamesResult = {
    scanned: ranks.size,
    knownIds: knownRows.length,
    newGames: assignments.size,
    coversUploaded: 0,
    coversKept: 0,
    coversFailed: 0,
  };
  const supersededKeys: string[] = [];
  if (deps.storage) {
    for (const row of staged) {
      const existing = known.get(row.igdbId);
      const desiredImageId = row.coverImageId;
      if (desiredImageId !== null && desiredImageId === existing?.coverImageId) {
        result.coversKept++;
        continue;
      }
      const previousKey = existing?.coverMediaPath?.startsWith("/media/")
        ? existing.coverMediaPath.slice("/media/".length)
        : null;

      if (desiredImageId === null) {
        row.coverMediaPath = null;
        row.coverImageId = null;
        if (previousKey) supersededKeys.push(previousKey);
        continue;
      }

      try {
        const cover = await client.fetchCoverImage(desiredImageId);
        const key = gameCoverObjectKey(
          row.igdbId,
          desiredImageId,
          IMAGE_EXTENSION[cover.contentType],
        );
        await deps.storage.put(key, cover.bytes, cover.contentType);
        row.coverMediaPath = mediaPathFor(key);
        row.coverImageId = desiredImageId;
        if (previousKey && previousKey !== key) supersededKeys.push(previousKey);
        result.coversUploaded++;
      } catch (error) {
        // Per-cover tolerance (Q28): warn, keep the old cover and its
        // compare key so the change retries next run.
        result.coversFailed++;
        row.coverMediaPath = existing?.coverMediaPath ?? null;
        row.coverImageId = existing?.coverImageId ?? null;
        console.warn(
          `games-sync: cover for igdb ${row.igdbId} (${desiredImageId}) failed — keeping the previous cover: ${String(error)}`,
        );
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

  // 9. Commit: ONE transaction, all rows, all-or-nothing (Q28).
  await deps.db.transaction(async (tx) => {
    await upsertGames(tx, staged, now);
  });

  // 10. Superseded covers leave AFTER the rows that referenced them are
  //     committed — the link-card ordering. Best-effort by design: a missed
  //     removal is an orphan, never a broken reference.
  for (const key of supersededKeys) {
    if (deps.storage) await deps.storage.remove(key).catch(() => {});
  }

  return result;
}
