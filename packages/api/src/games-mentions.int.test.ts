import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import { post } from "@my-tuums/db/schema";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractHashtagKeys, gameMentionsFor } from "./games.js";
import { upsertGames, type StagedGameRow } from "./games-sync.js";
import { appRouter } from "./router.js";
import { contextFor, createTestUser, truncateAll, type TestUser } from "./testing/harness.js";

/**
 * The hashtag→game resolution map (issue #314, Q16/Q21): every surface that
 * renders post text carries a per-batch `gameMentions` map, and the map is
 * exactly the catalog's answers — resolved keys only, unresolved tags simply
 * absent (Q3: they keep their search link). The extraction helper's pure
 * contract is pinned here too; the module it lives in is integration-scoped
 * by its imports, and these tests need the database either way.
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

let author: TestUser;
let doomPostId: string;
let hadesPostId: string;

beforeAll(async () => {
  await truncateAll();
  await upsertGames(
    db,
    [
      seedRow({ igdbId: 41, slug: "game-doom", hashtagKey: "doom", name: "Doom" }),
      seedRow({ igdbId: 42, slug: "game-hades", hashtagKey: "hades", name: "Hades" }),
    ],
    now,
  );

  author = await createTestUser();
  const inserted = await db
    .insert(post)
    .values([
      // One resolved tag — the map must answer it.
      { authorId: author.id, content: `Playing #doom all weekend ${randomUUID()}` },
      // One resolved, one unresolved — the map carries the first and stays
      // silent on the second.
      { authorId: author.id, content: `Also #hades and #unknownthing ${randomUUID()}` },
    ])
    .returning({ id: post.id });
  doomPostId = inserted[0].id;
  hadesPostId = inserted[1].id;

  // A reply under the DOOM post — thread coverage and the reply mode's own
  // response shape.
  await db.insert(post).values({
    authorId: author.id,
    parentId: doomPostId,
    content: `Re: #doom tip thread ${randomUUID()}`,
  });
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

describe("extractHashtagKeys", () => {
  it("collects the client's canonical tags: lowercased, deduped, nulls skipped", () => {
    expect(extractHashtagKeys(["#Doom and #doom", null, "plain text", "#Hades #hades"])).toEqual([
      "doom",
      "hades",
    ]);
  });

  it("keeps underscored tokens — the client links them; they just match nothing", () => {
    expect(extractHashtagKeys(["#world_of warcraft"])).toEqual(["world_of"]);
  });
});

describe("gameMentionsFor", () => {
  it("maps only the keys the catalog answers", async () => {
    const map = await gameMentionsFor(db, ["#doom!", "no tags here", "#unknownthing #hades"]);
    expect(map).toEqual({ doom: "game-doom", hades: "game-hades" });
    expect("unknownthing" in map).toBe(false);
  });
});

describe("the map on post payloads", () => {
  it("rides post.list: resolved slugs present, unresolved tags absent", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global" },
      { context: contextFor(author) },
    );
    expect(page.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([doomPostId, hadesPostId]),
    );
    expect(page.gameMentions).toEqual({ doom: "game-doom", hades: "game-hades" });
  });

  it("rides post.thread over the focused post", async () => {
    const thread = await call(
      appRouter.post.thread,
      { postId: doomPostId },
      { context: contextFor(author) },
    );
    expect(thread.gameMentions).toEqual({ doom: "game-doom" });
  });

  it("rides the reply mode's response alongside its continuations", async () => {
    const replies = await call(
      appRouter.post.list,
      { parentId: doomPostId },
      { context: contextFor(author) },
    );
    expect(replies.gameMentions).toEqual({ doom: "game-doom" });
  });

  it("rides search.posts", async () => {
    const results = await call(
      appRouter.search.posts,
      { q: "weekend" },
      { context: contextFor(author) },
    );
    expect(results.items.map((item) => item.id)).toContain(doomPostId);
    expect(results.gameMentions).toEqual({ doom: "game-doom" });
  });
});
