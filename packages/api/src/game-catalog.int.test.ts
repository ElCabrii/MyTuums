import {
  game,
  gameCatalogRow,
  gameCatalogState,
  gameCatalogVersion,
  gameFavorite,
  mediaIntent,
} from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import {
  beginGameCatalog,
  CatalogLeaseError,
  CatalogAlreadyCurrent,
  cleanupGameCatalogVersions,
  publishGameCatalog,
  releaseGameCatalog,
  stageGameCatalog,
} from "./game-catalog.js";
import type { StagedGameRow } from "./games-sync.js";
import { createTestUser, testStorage, testStorageObjects, truncateAll } from "./testing/harness.js";
import { beginMediaUpload, cleanupMediaIntents, readMediaReferences } from "./media-intents.js";
import { gameCoverObjectKey } from "./game-media.js";
import { reconcileMedia } from "./reconcile-media.js";
import { closeDb, db } from "./testing/runtime.js";

beforeEach(truncateAll);
afterAll(closeDb);

it("rejects duplicate or superseded schedules in the lease acquisition boundary", async () => {
  const scheduledAt = new Date("2026-09-15T00:00:00Z");
  const current = await beginGameCatalog(db, scheduledAt, true);
  await stageGameCatalog(db, current, [row(1)]);
  await publishGameCatalog(db, current, 1);
  await releaseGameCatalog(db, current);
  const before = await db.select().from(gameCatalogVersion);
  await expect(beginGameCatalog(db, scheduledAt, true)).rejects.toThrow(CatalogAlreadyCurrent);
  await expect(beginGameCatalog(db, new Date(0), true)).rejects.toThrow(CatalogAlreadyCurrent);
  expect(await db.select().from(gameCatalogVersion)).toEqual(before);
  const newer = await beginGameCatalog(db, new Date(scheduledAt.getTime() + 86_400_000), true);
  expect(newer).not.toBe(current);
  await expect(
    beginGameCatalog(db, new Date(scheduledAt.getTime() + 172_800_000), true),
  ).rejects.toThrow(CatalogLeaseError);
});

function row(id: number): StagedGameRow {
  return {
    igdbId: id,
    slug: `game-${id}`,
    hashtagKey: `game${id}`,
    name: `Game ${id}`,
    summary: null,
    coverMediaPath: null,
    coverImageId: null,
    firstReleaseYear: null,
    firstReleaseDate: null,
    hypeCount: 0,
    genres: [],
    platforms: [],
    popularityRank: null,
  };
}

it("keeps staged pages invisible and publishes complete rows with live favorites intact", async () => {
  const originalTime = new Date("2026-01-01T00:00:00Z");
  await db.insert(game).values({ ...row(1), lastSyncedAt: originalTime, createdAt: originalTime });
  const version = await beginGameCatalog(db, new Date());
  const staged = Array.from({ length: 131 }, (_, index) => ({
    ...row(index + 1),
    name: `Refreshed ${index + 1}`,
  }));
  await stageGameCatalog(db, version, staged.slice(0, 50));
  await expect(publishGameCatalog(db, version, staged.length)).rejects.toThrow(CatalogLeaseError);
  expect(await db.select({ name: game.name }).from(game)).toEqual([{ name: "Game 1" }]);
  await stageGameCatalog(db, version, staged.slice(50));
  // A retry overwrites only the invisible version's matching rows.
  await stageGameCatalog(db, version, staged.slice(0, 50));
  const owner = await createTestUser();
  await db.insert(gameFavorite).values({ gameId: 1, userId: owner.id });
  await publishGameCatalog(db, version, staged.length);
  await publishGameCatalog(db, version, staged.length);
  expect(await db.select().from(game)).toHaveLength(131);
  expect(await db.select().from(game).where(eq(game.igdbId, 1))).toMatchObject([
    { name: "Refreshed 1", favoriteCount: 1, createdAt: originalTime, hashtagKey: "game1" },
  ]);
  expect(await db.select().from(gameFavorite)).toHaveLength(1);
  expect(await db.select().from(gameCatalogState)).toMatchObject([{ activeVersion: version }]);
  await expect(stageGameCatalog(db, version, [row(1)])).rejects.toThrow(CatalogLeaseError);
});

it("rolls back every catalog row and the version stamp when the final pointer write fails", async () => {
  await db.insert(game).values({ ...row(1), lastSyncedAt: new Date() });
  const before = await db.select().from(game);
  const version = await beginGameCatalog(db, new Date());
  await stageGameCatalog(db, version, [{ ...row(1), name: "Changed" }, row(2)]);
  await db.run(sql`create trigger reject_catalog_pointer_test before update of active_version on game_catalog_state
    begin select raise(abort, 'injected pointer failure'); end`);
  try {
    await expect(publishGameCatalog(db, version, 2)).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_catalog_pointer_test`);
  }
  expect(await db.select().from(game)).toEqual(before);
  expect(await db.select().from(gameCatalogVersion)).toMatchObject([
    { id: version, publishedAt: null },
  ]);
  expect(await db.select().from(gameCatalogState)).toMatchObject([{ activeVersion: null }]);
  await publishGameCatalog(db, version, 2);
  expect(await db.select().from(game)).toHaveLength(2);
});

it("fences an expired publisher and its release after a replacement run takes ownership", async () => {
  const old = await beginGameCatalog(db, new Date());
  await stageGameCatalog(db, old, [row(1)]);
  await db.update(gameCatalogState).set({ leaseUntil: new Date(0) });
  const current = await beginGameCatalog(db, new Date());
  await expect(stageGameCatalog(db, old, [row(2)])).rejects.toThrow(CatalogLeaseError);
  await expect(publishGameCatalog(db, old, 1)).rejects.toThrow(CatalogLeaseError);
  await releaseGameCatalog(db, old);
  await stageGameCatalog(db, current, [row(3)]);
  await publishGameCatalog(db, current, 1);
  expect(await db.select({ id: game.igdbId }).from(game)).toEqual([{ id: 3 }]);
  expect(await db.select().from(gameCatalogState)).toMatchObject([
    { activeVersion: current, runningVersion: current },
  ]);
});

it("grants only one lease to concurrent starters", async () => {
  const starts = await Promise.allSettled(
    Array.from({ length: 5 }, () => beginGameCatalog(db, new Date())),
  );
  expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await db.select().from(gameCatalogVersion)).toHaveLength(1);
});

it("refuses publication that drops a known game or changes its permanent hashtag identity", async () => {
  await db.insert(game).values({ ...row(1), lastSyncedAt: new Date() });
  const before = await db.select().from(game);
  for (const staged of [[row(2)], [{ ...row(1), hashtagKey: "replacement" }]]) {
    const version = await beginGameCatalog(db, new Date());
    await stageGameCatalog(db, version, staged);
    await expect(publishGameCatalog(db, version, staged.length)).rejects.toThrow(CatalogLeaseError);
    await releaseGameCatalog(db, version);
    expect(await db.select().from(game)).toEqual(before);
    expect(await db.select().from(gameCatalogState)).toMatchObject([{ activeVersion: null }]);
  }
});

it("protects uploading covers, expires unpublished uploads and never reuses a cleanup target", async () => {
  testStorageObjects.clear();
  const oldKey = "games/1-coimage.jpg";
  await testStorage.put(oldKey, new Uint8Array([1]), "image/jpeg");
  await db.insert(game).values({
    ...row(1),
    coverMediaPath: `/media/${oldKey}`,
    coverImageId: "coimage",
    lastSyncedAt: new Date(),
  });
  const version = await beginGameCatalog(db, new Date());
  const key = gameCoverObjectKey(1, "coimage", "jpg", version);
  const path = `/media/${key}`;
  const upload = await beginMediaUpload(db, `catalog:${version}`, [path]);
  await testStorage.put(key, new Uint8Array([2]), "image/jpeg");
  await reconcileMedia({ storage: testStorage, readReferences: () => readMediaReferences(db) });
  expect(testStorageObjects.has(key)).toBe(true);
  expect(testStorageObjects.has(oldKey)).toBe(true);
  await stageGameCatalog(db, version, [
    { ...row(1), coverMediaPath: path, coverImageId: "coimage" },
  ]);
  await db
    .update(mediaIntent)
    .set({ readyAt: new Date(0) })
    .where(eq(mediaIntent.id, upload));
  await expect(publishGameCatalog(db, version, 1)).rejects.toThrow(CatalogLeaseError);
  await cleanupMediaIntents(db, testStorage);
  expect(testStorageObjects.has(key)).toBe(false);
  await releaseGameCatalog(db, version);

  const retry = await beginGameCatalog(db, new Date());
  const retryKey = gameCoverObjectKey(1, "coimage", "jpg", retry);
  expect(retryKey).not.toBe(key);
  await beginMediaUpload(db, `catalog:${retry}`, [`/media/${retryKey}`]);
  await testStorage.put(retryKey, new Uint8Array([2]), "image/jpeg");
  await stageGameCatalog(db, retry, [
    { ...row(1), coverMediaPath: `/media/${retryKey}`, coverImageId: "coimage" },
  ]);
  await publishGameCatalog(db, retry, 1);
  expect(await db.select().from(mediaIntent)).toMatchObject([
    { kind: "cleanup", paths: [`/media/${oldKey}`] },
  ]);
  await cleanupMediaIntents(db, testStorage);
  expect(testStorageObjects.has(oldKey)).toBe(false);
  expect(testStorageObjects.has(retryKey)).toBe(true);
});

it("bounds old-version cleanup while retaining active and running versions", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => row(index + 1));
  const old = await beginGameCatalog(db, new Date());
  await stageGameCatalog(db, old, rows);
  await publishGameCatalog(db, old, rows.length);
  await releaseGameCatalog(db, old);
  const active = await beginGameCatalog(db, new Date());
  await stageGameCatalog(db, active, rows);
  await publishGameCatalog(db, active, rows.length);
  await releaseGameCatalog(db, active);
  const running = await beginGameCatalog(db, new Date());
  await stageGameCatalog(db, running, [row(301)]);
  await cleanupGameCatalogVersions(db);
  expect(
    await db.select().from(gameCatalogRow).where(eq(gameCatalogRow.versionId, old)),
  ).toHaveLength(50);
  await cleanupGameCatalogVersions(db);
  expect(
    await db.select().from(gameCatalogVersion).where(eq(gameCatalogVersion.id, old)),
  ).toHaveLength(0);
  expect(
    await db.select().from(gameCatalogRow).where(eq(gameCatalogRow.versionId, active)),
  ).toHaveLength(300);
  expect(
    await db.select().from(gameCatalogRow).where(eq(gameCatalogRow.versionId, running)),
  ).toHaveLength(1);
  await db.update(gameCatalogState).set({ leaseUntil: new Date(0) });
  await cleanupGameCatalogVersions(db);
  expect(
    await db.select().from(gameCatalogVersion).where(eq(gameCatalogVersion.id, running)),
  ).toHaveLength(0);
  expect(await db.select().from(gameCatalogState)).toMatchObject([
    { activeVersion: active, runningVersion: null },
  ]);
});
