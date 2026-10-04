import { call } from "@orpc/server";
import { game, gameSummaryTranslation } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import { translateGameSummaries } from "./game-translations.js";
import { appRouter } from "./router.js";
import { anonContext, truncateAll } from "./testing/harness.js";
import { db } from "./testing/runtime.js";

beforeEach(truncateAll);

async function seed(summaries: (string | null)[]) {
  const rows = summaries.map((summary, index) => ({
    igdbId: index + 1,
    slug: `game-${index + 1}`,
    hashtagKey: `game${index + 1}`,
    name: `Game ${index + 1}`,
    summary,
    lastSyncedAt: new Date(),
  }));
  for (let offset = 0; offset < rows.length; offset += 10) {
    await db.insert(game).values(rows.slice(offset, offset + 10));
  }
}

const read = (locale: "en" | "fr" = "fr") =>
  call(appRouter.game.bySlug, { slug: "game-1", locale }, { context: anonContext });

it("serves French only for the current source and reuses translations on unchanged syncs", async () => {
  await seed(["Explore the world."]);
  expect((await read()).summary).toBe("Explore the world.");
  await translateGameSummaries({
    db,
    afterGameId: 0,
    translate: () => Promise.resolve("Explorez le monde."),
  });
  expect((await read()).summary).toBe("Explorez le monde.");
  expect((await read("en")).summary).toBe("Explore the world.");
  expect(
    (await call(appRouter.game.bySlug, { slug: "game-1" }, { context: anonContext })).summary,
  ).toBe("Explore the world.");
  const replay = await translateGameSummaries({
    db,
    afterGameId: 0,
    translate: () => Promise.reject(new Error("Unchanged summaries must not reach the provider.")),
  });
  expect(replay).toMatchObject({ translated: 0, failed: 0, hasMore: false });

  await db.update(game).set({ summary: "Explore a new world." }).where(eq(game.igdbId, 1));
  expect((await read()).summary).toBe("Explore a new world.");
  await translateGameSummaries({
    db,
    afterGameId: 0,
    translate: () => Promise.resolve("Explorez un nouveau monde."),
  });
  expect((await read()).summary).toBe("Explorez un nouveau monde.");
  await db.update(game).set({ summary: null }).where(eq(game.igdbId, 1));
  expect((await read()).summary).toBeNull();
});

it("refuses a late translation after the English source changes during provider I/O", async () => {
  await seed(["Old description."]);
  const result = await translateGameSummaries({
    db,
    afterGameId: 0,
    translate: async () => {
      await db.update(game).set({ summary: "New description." }).where(eq(game.igdbId, 1));
      await db.insert(gameSummaryTranslation).values({
        gameId: 1,
        locale: "fr",
        sourceSummary: "New description.",
        summary: "Nouvelle description.",
      });
      return "Ancienne description.";
    },
  });
  expect(result.translated).toBe(0);
  expect((await read()).summary).toBe("Nouvelle description.");
});

it("keeps failed and invalid translations pending without starving later pages", async () => {
  await seed([null, "", "   ", ...Array.from({ length: 27 }, (_, i) => `Description ${i}`)]);
  const first = await translateGameSummaries({
    db,
    afterGameId: 0,
    translate: (text) => {
      if (text === "Description 0") return Promise.reject(new Error("Provider unavailable"));
      if (text === "Description 1") return Promise.resolve("   ");
      if (text === "Description 2") return Promise.resolve("x".repeat(4001));
      return Promise.resolve(`Traduction de ${text}`);
    },
  });
  expect(first).toEqual({ translated: 22, failed: 3, afterGameId: 28, hasMore: true });
  const second = await translateGameSummaries({
    db,
    afterGameId: first.afterGameId,
    translate: (text) => Promise.resolve(`Traduction de ${text}`),
  });
  expect(second).toEqual({ translated: 2, failed: 0, afterGameId: 30, hasMore: false });
  const retry = await translateGameSummaries({
    db,
    afterGameId: 0,
    translate: (text) => Promise.resolve(`Traduction de ${text}`),
  });
  expect(retry).toMatchObject({ translated: 3, failed: 0, hasMore: false });
  expect(await db.select().from(gameSummaryTranslation)).toHaveLength(27);
});
