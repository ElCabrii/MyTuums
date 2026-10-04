import { call } from "@orpc/server";
import { follow, game, post, postRepost, userBlock } from "@my-tuums/db/schema";
import { beforeEach, expect, it } from "vitest";
import { FEED_RANK_POOL_LIMIT } from "./constants.js";
import { appRouter } from "./router.js";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, truncateAll, type TestUser } from "./testing/harness.js";

beforeEach(truncateAll);

async function readAll(viewer: TestUser, feed: "global" | "following" | "discover", limit = 17) {
  const items: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await call(
      appRouter.post.list,
      { feed, ranked: true, limit, cursor },
      { context: contextFor(viewer) },
    );
    items.push(...result.items.map((item) => item.id));
    if (!result.nextCursor) return items;
    cursor = result.nextCursor;
  }
  throw new Error("Feed pagination did not finish");
}

it.each(["global", "following", "discover"] as const)(
  "%s continues beyond the ranked age window without losing or repeating posts",
  async (feed) => {
    const viewer = await createTestUser();
    const author = await createTestUser();
    await db.insert(follow).values({ followerId: viewer.id, followingId: author.id });
    const rows = await db
      .insert(post)
      .values(
        [1, 15, 45].map((daysOld) => ({
          authorId: author.id,
          content: `Post from ${daysOld} days ago`,
          createdAt: new Date(Date.now() - daysOld * 86_400_000),
        })),
      )
      .returning({ id: post.id });
    expect((await readAll(viewer, feed, 1)).sort()).toEqual(rows.map((row) => row.id).sort());
  },
);

it.each([
  { recentCount: 50, daysOld: 15 },
  { recentCount: FEED_RANK_POOL_LIMIT, daysOld: 1 },
])("continues after $recentCount recent candidates", async ({ recentCount, daysOld }) => {
  const viewer = await createTestUser();
  const author = await createTestUser();
  const now = Date.now();
  const rows = Array.from({ length: recentCount + 2 }, (_, index) => ({
    id: crypto.randomUUID(),
    authorId: author.id,
    content: `Pagination post ${index}`,
    createdAt: new Date(now - (index < recentCount ? 1 : daysOld) * 86_400_000),
  }));
  for (let offset = 0; offset < rows.length; offset += 50) {
    const [first, ...rest] = rows
      .slice(offset, offset + 50)
      .map((row) => db.insert(post).values(row));
    await db.batch([first, ...rest]);
  }
  expect((await readAll(viewer, "global")).sort()).toEqual(rows.map((row) => row.id).sort());
});

it("continues an empty ranking through followed reposts without repeating their originals", async () => {
  const viewer = await createTestUser();
  const followed = await createTestUser();
  const stranger = await createTestUser();
  await db.insert(follow).values({ followerId: viewer.id, followingId: followed.id });
  const [shared, authored] = await db
    .insert(post)
    .values([
      { authorId: stranger.id, content: "Old shared post", createdAt: new Date("2020-01-01") },
      { authorId: followed.id, content: "Old followed post", createdAt: new Date("2020-01-02") },
    ])
    .returning({ id: post.id });
  await db.insert(postRepost).values([
    { postId: shared.id, userId: followed.id, createdAt: new Date("2020-02-03") },
    { postId: shared.id, userId: viewer.id, createdAt: new Date("2020-02-02") },
    { postId: authored.id, userId: followed.id, createdAt: new Date("2020-02-01") },
  ]);
  expect(await readAll(viewer, "following", 1)).toEqual([shared.id, authored.id]);
});

it("keeps new posts out while paging the continuation of a frozen snapshot", async () => {
  const viewer = await createTestUser();
  const author = await createTestUser();
  const [recent, older, oldest] = await db
    .insert(post)
    .values([
      { authorId: author.id, content: "Ranked first" },
      { authorId: author.id, content: "Older", createdAt: new Date("2020-02-01") },
      { authorId: author.id, content: "Oldest", createdAt: new Date("2020-01-01") },
    ])
    .returning({ id: post.id });
  const context = contextFor(viewer);
  const input = { feed: "global", ranked: true, limit: 1 } as const;
  const first = await call(appRouter.post.list, input, { context });
  expect(first.items.map((item) => item.id)).toEqual([recent.id]);
  const second = await call(
    appRouter.post.list,
    { ...input, cursor: first.nextCursor ?? undefined },
    { context },
  );
  expect(second.items.map((item) => item.id)).toEqual([older.id]);
  await db.insert(post).values({ authorId: author.id, content: "Arrived after snapshot" });
  const last = await call(
    appRouter.post.list,
    { ...input, cursor: second.nextCursor ?? undefined },
    { context },
  );
  expect(last.items.map((item) => item.id)).toEqual([oldest.id]);
  expect(last.nextCursor).toBeNull();
});

it("keeps Discover's exact filters and live visibility through the continuation", async () => {
  const viewer = await createTestUser();
  const author = await createTestUser();
  const blocked = await createTestUser();
  await db.insert(game).values({
    igdbId: 1,
    slug: "doom",
    hashtagKey: "doom",
    name: "Doom",
    lastSyncedAt: new Date(),
  });
  const [recent, older, oldest] = await db
    .insert(post)
    .values([
      { authorId: author.id, content: "needle #doom" },
      { authorId: author.id, content: "needle #doom older", createdAt: new Date("2020-02-01") },
      { authorId: author.id, content: "needle #DOOM oldest", createdAt: new Date("2020-01-01") },
    ])
    .returning({ id: post.id });
  const base = {
    authorId: author.id,
    createdAt: new Date("2020-03-01"),
    content: "needle #doom hidden",
  };
  await db.insert(post).values([
    { ...base, authorId: viewer.id },
    { ...base, authorId: blocked.id },
    { ...base, isPrivate: true },
    { ...base, removedAt: new Date() },
    { ...base, deletedAt: new Date() },
    { ...base, content: "needle #doom2016" },
    { ...base, content: "other topic #doom" },
  ]);
  const context = contextFor(viewer);
  const input = {
    feed: "discover",
    ranked: true,
    limit: 1,
    q: "needle",
    gameSlug: "doom",
  } as const;
  const first = await call(appRouter.post.list, input, { context });
  expect(first.items.map((item) => item.id)).toEqual([recent.id]);
  await db.insert(userBlock).values({ blockerId: viewer.id, blockedId: blocked.id });
  const second = await call(
    appRouter.post.list,
    { ...input, cursor: first.nextCursor ?? undefined },
    { context },
  );
  expect(second.items.map((item) => item.id)).toEqual([older.id]);
  const last = await call(
    appRouter.post.list,
    { ...input, cursor: second.nextCursor ?? undefined },
    { context },
  );
  expect(last.items.map((item) => item.id)).toEqual([oldest.id]);
  expect(last.nextCursor).toBeNull();
  const unknown = await call(appRouter.post.list, { ...input, gameSlug: "unknown" }, { context });
  expect(unknown.items).toEqual([]);
  expect(unknown.nextCursor).toBeNull();
});
