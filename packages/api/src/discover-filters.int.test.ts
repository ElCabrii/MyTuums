import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import { post } from "@my-tuums/db/schema";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertGames, type StagedGameRow } from "./games-sync.js";
import { appRouter } from "./router.js";
import { contextFor, createTestUser, truncateAll, type TestUser } from "./testing/harness.js";

/**
 * Discover's search and game filters (`post.list`'s `q` + `gameSlug`): the
 * global feed narrowed by free text, by game hashtag, or both — newest
 * first, keyset-paginated, repost events included. Unknown game slugs answer
 * an empty page (a stale shared URL renders the empty state, not an error),
 * and the filters refuse the reply/profile/bookmarks modes they would
 * otherwise combine with ambiguously.
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

let viewer: TestUser;
let zeldaPostId: string;
let doomPostId: string;

beforeAll(async () => {
  await truncateAll();
  await upsertGames(
    db,
    [seedRow({ igdbId: 51, slug: "doom", hashtagKey: "doom", name: "DOOM" })],
    now,
  );

  viewer = await createTestUser();
  const marker = randomUUID();
  const inserted = await db
    .insert(post)
    .values([
      { authorId: viewer.id, content: `Exploring Zelda shrines ${marker}` },
      { authorId: viewer.id, content: `Playing #doom all weekend ${marker}` },
      { authorId: viewer.id, content: `Zelda and #doom crossover ${marker}` },
    ])
    .returning({ id: post.id });
  zeldaPostId = inserted[0].id;
  doomPostId = inserted[1].id;

  // A reply containing the query — filtered Discover stays top-level only,
  // so this must never surface through `q` or `gameSlug`.
  const [parent] = await db
    .insert(post)
    .values({ authorId: viewer.id, content: `Parent thread ${marker}` })
    .returning({ id: post.id });
  await db.insert(post).values({
    authorId: viewer.id,
    parentId: parent.id,
    content: `Reply about Zelda ${marker}`,
  });
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("post.list Discover filters", () => {
  it("narrows the global feed by free text, newest first", async () => {
    const page = await call(appRouter.post.list, { q: "Zelda" }, { context: contextFor(viewer) });
    const ids = page.items.map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(zeldaPostId);
  });

  it("narrows the global feed by game hashtag — `#doom` posts only", async () => {
    const page = await call(
      appRouter.post.list,
      { gameSlug: "doom" },
      { context: contextFor(viewer) },
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(doomPostId);
    for (const item of page.items) {
      expect(item.content?.toLowerCase()).toContain("#doom");
    }
  });

  it("ANDs text and game filters together", async () => {
    const page = await call(
      appRouter.post.list,
      { q: "crossover", gameSlug: "doom" },
      { context: contextFor(viewer) },
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].content).toContain("crossover");
  });

  it("answers an empty page for an unknown game slug — never NOT_FOUND", async () => {
    const page = await call(
      appRouter.post.list,
      { gameSlug: "no-such-game" },
      { context: contextFor(viewer) },
    );
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("refuses filters beside reply, profile and bookmarks modes", async () => {
    const context = contextFor(viewer);
    await expect(
      call(appRouter.post.list, { q: "zelda", parentId: doomPostId }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(appRouter.post.list, { gameSlug: "doom", authorId: viewer.id }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(appRouter.post.list, { q: "zelda", feed: "bookmarks" }, { context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
