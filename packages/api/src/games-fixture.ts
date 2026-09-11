/** Node-only committed fixtures; never imported by a deployed Worker. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { gameCoverObjectKey } from "./game-media.js";
import { mediaPathFor } from "./image.js";
import { beginMediaUpload } from "./media-intents.js";
import type { ObjectStorage } from "./object-storage.js";
import { validateStaged, type StagedGameRow } from "./games-sync.js";

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
  firstReleaseDate: z.number().nullable().optional(),
  hypeCount: z.number().optional(),
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
  // Older fixture rows predate the hype fields — default them so a hand-edit
  // adding only the catalog columns keeps seeding. New rows carry both.
  return parsed.data.map((row) => ({
    ...row,
    firstReleaseDate: row.firstReleaseDate ?? null,
    hypeCount: row.hypeCount ?? 0,
    coverMediaPath: null,
  }));
}

/**
 * Seeds the catalog from the committed fixture — the dev/CI/e2e data source
 * (issue Q27). It uses the same fenced publisher as sync and merges all known
 * games so seeding cannot discard an incumbent or its favorite identity.
 *
 * Covers upload only when a storage adapter is supplied; without one the catalog is
 * seeded bare rather than failing, mirroring how uploads degrade. A cover
 * failure here fails the seed: unlike the sync's per-game tolerance, the
 * fixture's covers are local files with no remote to fail against.
 */
export async function seedGamesFixture(deps: {
  db: Database;
  storage: ObjectStorage | null;
  now?: () => Date;
}): Promise<{ seeded: number; coversUploaded: number }> {
  const now = deps.now?.() ?? new Date();
  const rows = readGamesFixture();
  let coversUploaded = 0;

  const version = await beginGameCatalog(deps.db, now);
  try {
    if (deps.storage) {
      for (const row of rows) {
        if (!row.coverImageId) continue;
        const bytes = new Uint8Array(
          readFileSync(join(gamesFixtureCoversDir(), `${row.coverImageId}.jpg`)),
        );
        const key = gameCoverObjectKey(row.igdbId, row.coverImageId, "jpg", version);
        await beginMediaUpload(deps.db, `catalog:${version}`, [mediaPathFor(key)]);
        await deps.storage.put(key, bytes, "image/jpeg");
        row.coverMediaPath = mediaPathFor(key);
        coversUploaded++;
      }
    }

    const existing = await deps.db.select().from(game);
    const merged = new Map<number, StagedGameRow>(existing.map((row) => [row.igdbId, row]));
    for (const row of rows)
      merged.set(row.igdbId, {
        ...row,
        hashtagKey: merged.get(row.igdbId)?.hashtagKey ?? row.hashtagKey,
      });
    const staged = [...merged.values()];
    validateStaged(staged, now.getUTCFullYear() + 5);
    await stageGameCatalog(deps.db, version, staged);
    await publishGameCatalog(deps.db, version, staged.length);
  } finally {
    await releaseGameCatalog(deps.db, version);
    await cleanupGameCatalogVersions(deps.db).catch(() => {
      console.error({ event: "catalog_version_cleanup_deferred" });
    });
  }
  return { seeded: rows.length, coversUploaded };
}
