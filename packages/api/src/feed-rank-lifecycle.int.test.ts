import { call } from "@orpc/server";
import { feedRankSnapshot, post, postLike, postRepost } from "@my-tuums/db/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import {
  FEED_RANK_HISTORY_LIMIT,
  FEED_RANK_SNAPSHOT_TTL_MS,
  SEARCH_QUERY_MAX_LENGTH,
} from "./constants.js";
import { appRouter } from "./router.js";
import { db, closeDb } from "./testing/runtime.js";
import { contextFor, createTestUser, truncateAll } from "./testing/harness.js";

beforeEach(truncateAll);
afterAll(closeDb);

it("rolls back snapshot creation and the global sweep if the viewer's trim fails", async () => {
  const viewer = await createTestUser();
  const other = await createTestUser();
  const stale = Array.from({ length: 103 }, () => ({
    id: crypto.randomUUID(),
    viewerId: other.id,
    scope: "global",
    expiresAt: new Date(Date.now() - 3600000),
  }));
  const live = Array.from({ length: 10 }, () => ({
    id: crypto.randomUUID(),
    viewerId: viewer.id,
    scope: "global",
    expiresAt: new Date(Date.now() + 3600000),
  }));
  const seeds = [...stale, ...live];
  for (let offset = 0; offset < seeds.length; offset += 50) {
    const [first, ...rest] = seeds
      .slice(offset, offset + 50)
      .map((row) => db.insert(feedRankSnapshot).values(row));
    await db.batch([first, ...rest]);
  }
  const build = () =>
    call(appRouter.post.list, { feed: "global", ranked: true }, { context: contextFor(viewer) });
  // Abort after the batch has inserted its snapshot and swept other viewers.
  await db.run(sql`create trigger reject_snapshot_trim_test before delete on feed_rank_snapshot
    when old.expires_at > cast(unixepoch('subsec') * 1000 as integer)
    begin select raise(abort, 'injected snapshot trim failure'); end`);
  try {
    await expect(build()).rejects.toThrow();
  } finally {
    await db.run(sql`drop trigger reject_snapshot_trim_test`);
  }
  const unchanged = await db.select({ id: feedRankSnapshot.id }).from(feedRankSnapshot);
  expect(unchanged.map((row) => row.id).sort()).toEqual(seeds.map((row) => row.id).sort());

  const built = await build();
  const kept = await db.select().from(feedRankSnapshot);
  expect(kept.filter((row) => row.viewerId === other.id)).toHaveLength(3);
  expect(kept.filter((row) => row.viewerId === viewer.id)).toHaveLength(10);
  const fresh = kept.find((row) => row.id === built.ranking?.snapshotId);
  expect(fresh).toBeDefined();
  expect(fresh!.expiresAt.getTime() - fresh!.createdAt.getTime()).toBe(FEED_RANK_SNAPSHOT_TTL_MS);
});

it("enforces the viewer cap across simultaneous D1 snapshot builds", async () => {
  const viewer = await createTestUser();
  const results = await Promise.all(
    Array.from({ length: 16 }, () =>
      call(appRouter.post.list, { feed: "global", ranked: true }, { context: contextFor(viewer) }),
    ),
  );
  const builtIds = new Set(results.map((result) => result.ranking?.snapshotId));
  expect(builtIds.size).toBe(16);
  const kept = await db.select().from(feedRankSnapshot);
  expect(kept).toHaveLength(10);
  expect(kept.every((row) => row.viewerId === viewer.id && builtIds.has(row.id))).toBe(true);
});

const longQuery = "àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ".repeat(4).slice(0, SEARCH_QUERY_MAX_LENGTH);
it.each([
  { query: "ος straße k", content: "ΟΣ STRAẞE Kelvin" },
  { query: "àáâãäåæ", content: "ÀÁÂÃÄÅÆ" },
  { query: longQuery, content: longQuery.toUpperCase() },
])(
  "keeps Unicode filtering consistent across ranked and chronological reads: $query",
  async ({ query, content }) => {
    const viewer = await createTestUser();
    const author = await createTestUser();
    const [authored, reposted] = await db
      .insert(post)
      .values([
        { authorId: author.id, content },
        { authorId: author.id, content, createdAt: new Date(Date.now() - 40 * 86400000) },
      ])
      .returning({ id: post.id });
    await db.insert(postRepost).values({ postId: reposted.id, userId: viewer.id });
    const context = contextFor(viewer);
    const first = await call(
      appRouter.post.list,
      { feed: "discover", ranked: true, q: query },
      { context },
    );
    expect(first.items.map((row) => row.id).sort()).toEqual([authored.id, reposted.id].sort());
    expect(first.ranking?.suggestions.map((row) => row.id)).toEqual([author.id]);
    const chronological = await call(
      appRouter.post.list,
      { feed: "global", q: query },
      { context },
    );
    // Chronological feeds retain the original and its repost as separate events.
    expect(chronological.items.map((row) => row.id).sort()).toEqual(
      [authored.id, reposted.id, reposted.id].sort(),
    );

    await db
      .update(post)
      .set({ content: "The filter no longer matches" })
      .where(eq(post.authorId, author.id));
    const resumed = await call(
      appRouter.post.list,
      { feed: "discover", ranked: true, q: query, snapshotId: first.ranking?.snapshotId },
      { context },
    );
    expect(resumed.items).toEqual([]);
    expect(resumed.ranking?.suggestions).toEqual([]);
  },
);

it("reads the full 200-row like and reply history within D1's binding limit", async () => {
  const viewer = await createTestUser();
  const author = await createTestUser();
  const roots = Array.from({ length: FEED_RANK_HISTORY_LIMIT }, () => ({
    id: crypto.randomUUID(),
    authorId: author.id,
    content: "A topic #thread",
  }));
  for (let offset = 0; offset < roots.length; offset += 25) {
    const [first, ...rest] = roots
      .slice(offset, offset + 25)
      .flatMap((row) => [
        db.insert(post).values(row),
        db.insert(post).values({ authorId: viewer.id, parentId: row.id, content: "A reply" }),
        db.insert(postLike).values({ postId: row.id, userId: viewer.id }),
      ]);
    await db.batch([first, ...rest]);
  }
  const page = await call(
    appRouter.post.list,
    { feed: "global", ranked: true, limit: 1 },
    { context: contextFor(viewer) },
  );
  expect(page.ranking?.hasInterests).toBe(true);
  const [snapshot] = await db.select().from(feedRankSnapshot);
  expect(snapshot.items).toHaveLength(FEED_RANK_HISTORY_LIMIT);
  expect(new Set(snapshot.items.map((item) => item.postId))).toEqual(
    new Set(roots.map((row) => row.id)),
  );
});
