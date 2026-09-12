import { afterAll, beforeEach, expect, it } from "vitest";
import { call } from "@orpc/server";
import { game, post } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";
import { SEARCH_QUERY_MAX_LENGTH } from "./constants.js";

beforeEach(truncateAll);
afterAll(truncateAll);

it("Unicode matching reaches user, post and game callers, including one-character queries", async () => {
  const author = await createTestUser({ name: "ÉLÈNE" });
  const viewer = await createTestUser({ name: "Bob", username: "bob" });
  const context = contextFor(viewer);
  const [written] = await db
    .insert(post)
    .values({ authorId: author.id, content: "ÉTOILE 東京" })
    .returning();
  await db.insert(game).values({
    igdbId: 990001,
    name: "ÉTOILE 東京",
    slug: "etoile-tokyo",
    hashtagKey: "etoiletokyo",
    lastSyncedAt: new Date(),
  });
  const profiles = await call(appRouter.search.users, { q: "él" }, { context });
  expect(profiles.items.map((item) => item.id)).toEqual([author.id]);
  const posts = await call(appRouter.search.posts, { q: "é" }, { context });
  expect(posts.items.map((item) => item.id)).toEqual([written.id]);
  const suggestions = await call(appRouter.search.typeahead, { q: "é" }, { context });
  expect(suggestions.users.map((item) => item.id)).toEqual([author.id]);
  expect(suggestions.games.map((item) => item.slug)).toEqual(["etoile-tokyo"]);
  const games = await call(appRouter.game.list, { q: "京" }, { context });
  expect(games.items.map((item) => item.slug)).toEqual(["etoile-tokyo"]);

  await call(
    appRouter.post.edit,
    { postId: written.id, content: "ДМИТРИЙ" },
    { context: contextFor(author) },
  );
  expect((await call(appRouter.search.posts, { q: "é" }, { context })).items).toEqual([]);
  expect(
    (await call(appRouter.search.posts, { q: "дм" }, { context })).items.map((item) => item.id),
  ).toEqual([written.id]);
});

it("accepts a full-length Unicode query without losing contiguity or exceeding D1 limits", async () => {
  const author = await createTestUser();
  const alphabet = "àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ";
  const query = alphabet.repeat(4).slice(0, SEARCH_QUERY_MAX_LENGTH);
  const content = query.toUpperCase();
  const [target] = await db.insert(post).values({ authorId: author.id, content }).returning();
  await db
    .insert(post)
    .values({ authorId: author.id, content: `${content.slice(0, 50)}:${content.slice(50)}` });
  const context = contextFor(author);
  const result = await call(appRouter.search.posts, { q: query }, { context });
  expect(result.items.map((item) => item.id)).toEqual([target.id]);
  expect((await call(appRouter.search.typeahead, { q: query }, { context })).users).toEqual([]);
  expect((await call(appRouter.search.users, { q: query }, { context })).items).toEqual([]);

  // Exercise the direct-replacement boundary through the full post projection,
  // whose viewer-relative fields also consume bound parameters.
  expect(
    (await call(appRouter.search.posts, { q: alphabet.slice(0, 7) }, { context })).items,
  ).toHaveLength(2);
});
