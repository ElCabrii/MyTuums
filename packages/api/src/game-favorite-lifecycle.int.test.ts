import { call } from "@orpc/server";
import { game, gameFavorite, user } from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import { appRouter } from "./router.js";
import { db, closeDb } from "./testing/runtime.js";
import { anonContext, contextFor, createTestUser, truncateAll } from "./testing/harness.js";

beforeEach(async () => {
  await truncateAll();
  await db.insert(game).values({
    igdbId: 1,
    slug: "favorite-contract",
    hashtagKey: "favoritecontract",
    name: "Favorite contract",
    lastSyncedAt: new Date(),
  });
});
afterAll(closeDb);

it("rolls back the favorite edge when its public count cannot change, in both directions", async () => {
  const viewer = await createTestUser();
  const favorite = () =>
    call(appRouter.game.favorite, { slug: "favorite-contract" }, { context: contextFor(viewer) });
  const unfavorite = () =>
    call(appRouter.game.unfavorite, { slug: "favorite-contract" }, { context: contextFor(viewer) });

  for (const favorited of [false, true]) {
    await db.run(sql`create trigger reject_game_count_test before update of favorite_count on game
      begin select raise(abort, 'injected favorite count failure'); end`);
    try {
      await expect(favorited ? unfavorite() : favorite()).rejects.toThrow();
    } finally {
      await db.run(sql`drop trigger reject_game_count_test`);
    }
    expect(await db.select().from(gameFavorite)).toHaveLength(favorited ? 1 : 0);
    const page = await call(
      appRouter.game.bySlug,
      { slug: "favorite-contract" },
      { context: contextFor(viewer) },
    );
    expect(page).toMatchObject({
      favoriteCount: favorited ? 1 : 0,
      viewerHasFavoritedGame: favorited,
    });
    if (!favorited) await favorite();
  }
});

it("counts concurrent retries once and removes only the deleted account's contribution", async () => {
  const owner = await createTestUser();
  const other = await createTestUser();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      call(appRouter.game.favorite, { slug: "favorite-contract" }, { context: contextFor(owner) }),
    ),
  );
  expect(results.every((result) => result.favoriteCount === 1)).toBe(true);
  await call(
    appRouter.game.favorite,
    { slug: "favorite-contract" },
    { context: contextFor(other) },
  );
  await db.delete(user).where(eq(user.id, owner.id));

  const page = await call(
    appRouter.game.bySlug,
    { slug: "favorite-contract" },
    { context: anonContext },
  );
  expect(page).toMatchObject({ favoriteCount: 1, viewerHasFavoritedGame: false });
  expect(await db.select({ userId: gameFavorite.userId }).from(gameFavorite)).toEqual([
    { userId: other.id },
  ]);
});
