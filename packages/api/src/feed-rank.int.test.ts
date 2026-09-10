import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import {
  feedRankSnapshot,
  follow,
  followRequest,
  gameFavorite,
  post,
  postBookmark,
  postLike,
  postRepost,
  user,
} from "@my-tuums/db/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEED_RANK_POOL_LIMIT, RANK_SNAPSHOT_INVALID_MESSAGE } from "./constants.js";
import { upsertGames, type StagedGameRow } from "./games-sync.js";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  truncateAll,
  type TestUser,
} from "./testing/harness.js";

/**
 * Ranked feeds (issue #305): the same scorer serves the home For you
 * (global), Following, and Discover feeds over per-scope candidates, paged
 * through frozen per-viewer snapshots.
 *
 * The world below is built so score gaps pin the priorities, not the clock:
 * favorite-game interest beats freshness, like/follow affinity beats it too,
 * reply threads lend topic interest without endorsing their authors, and
 * bookmarks lend nothing at all.
 */

const HOUR = 3_600_000;

function seedGame(overrides: Partial<StagedGameRow> & { igdbId: number }): StagedGameRow {
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

async function makePost(
  authorId: string,
  content: string,
  hoursOld: number,
  opts: { id?: string; isPrivate?: boolean; parentId?: string } = {},
): Promise<string> {
  const values: typeof post.$inferInsert = {
    authorId,
    content,
    createdAt: new Date(Date.now() - hoursOld * HOUR),
    isPrivate: opts.isPrivate ?? false,
    parentId: opts.parentId ?? null,
  };
  if (opts.id) values.id = opts.id;
  const [row] = await db.insert(post).values(values).returning({ id: post.id });
  if (!row) throw new Error("makePost inserted no row");
  return row.id;
}

let viewer: TestUser;
let cold: TestUser;
let followed: TestUser;
let strangerB: TestUser;
let strangerC: TestUser;
let strangerD: TestUser;
let threadAuthor: TestUser;
let topicAuthor: TestUser;
let bookmarkAuthor: TestUser;
let tieStranger: TestUser;
let requestedAuthor: TestUser;
let privateAuthor: TestUser;
let otherViewer: TestUser;
let topicNewcomer: TestUser;
let deepThreadAuthor: TestUser;
let deepTopicAuthor: TestUser;
let ancientAuthor: TestUser;
let privateReposter: TestUser;

let pDoomOld = "";
let pPlainNew = "";
let pFollowOld = "";
let pOwn = "";
let pHades = "";
let pTopic = "";
let pThreadAuthorPlain = "";
let pLikedAuthorNew = "";
let pTieStranger = "";
let pBookmarkAuthorNew = "";
let pDoom2016 = "";
let pRequestedDoom = "";
let pRemoved = "";
let pLikedTopicNew = "";
let pDeepTopic = "";
let pDeepAuthorPlain = "";
let pAncient = "";
let pLikeSeedPost = "";

beforeAll(async () => {
  await truncateAll();
  await upsertGames(
    db,
    [
      seedGame({ igdbId: 51, slug: "doom", hashtagKey: "doom", name: "DOOM" }),
      seedGame({ igdbId: 52, slug: "hades", hashtagKey: "hades", name: "Hades" }),
      seedGame({ igdbId: 53, slug: "celeste", hashtagKey: "celeste", name: "Celeste" }),
    ],
    new Date(),
  );

  viewer = await createTestUser();
  cold = await createTestUser();
  followed = await createTestUser();
  strangerB = await createTestUser();
  strangerC = await createTestUser();
  strangerD = await createTestUser();
  threadAuthor = await createTestUser();
  topicAuthor = await createTestUser();
  bookmarkAuthor = await createTestUser();
  tieStranger = await createTestUser();
  requestedAuthor = await createTestUser();
  privateAuthor = await createTestUser();
  otherViewer = await createTestUser();
  topicNewcomer = await createTestUser();
  deepThreadAuthor = await createTestUser();
  deepTopicAuthor = await createTestUser();
  ancientAuthor = await createTestUser();
  privateReposter = await createTestUser();

  await db.insert(follow).values({ followerId: viewer.id, followingId: followed.id });
  await db.insert(gameFavorite).values({ gameId: 51, userId: viewer.id });

  pDoomOld = await makePost(strangerB.id, "#doom forever", 30);
  pPlainNew = await makePost(strangerC.id, "just had coffee", 1);
  pFollowOld = await makePost(followed.id, "morning run", 50);
  pOwn = await makePost(viewer.id, "my update", 5);
  const likeSeed = await makePost(followed.id, "seed post for likes", 70);
  pLikeSeedPost = likeSeed;
  pHades = await makePost(strangerD.id, "#hades run", 6);

  // The reply thread: the viewer answers a #celeste root (a game they have
  // NOT favorited), so the thread lends celeste-topic interest only.
  const root = await makePost(threadAuthor.id, "#celeste lore", 60);
  await makePost(viewer.id, "agreed with this", 59, { parentId: root });
  pTopic = await makePost(topicAuthor.id, "#celeste build guide", 3);
  pThreadAuthorPlain = await makePost(threadAuthor.id, "plain words here", 3);
  pLikedAuthorNew = await makePost(followed.id, "another run today", 3);

  // A nested reply thread about a non-catalog tag: the generic topic must
  // travel from the root through two hops to the viewer's reply.
  const deepRoot = await makePost(deepThreadAuthor.id, "#stardewvalley mods", 55);
  const deepMid = await makePost(topicAuthor.id, "mid reply", 54, { parentId: deepRoot });
  await makePost(viewer.id, "deep agree", 53, { parentId: deepMid });
  pDeepTopic = await makePost(deepTopicAuthor.id, "#stardewvalley guide", 3);
  pDeepAuthorPlain = await makePost(deepThreadAuthor.id, "plain again", 3);

  // Liked-topic interest: the viewer likes #hades and #celeste posts, so a
  // newcomer's two-topic post can outrank an old followed post.
  pLikedTopicNew = await makePost(topicNewcomer.id, "#hades #celeste guide", 2);

  // A repost-driven ancient original: far outside the authored window, it
  // surfaces only on its recent amplification.
  pAncient = await makePost(ancientAuthor.id, "ancient plain words", 200);
  await db.insert(postRepost).values({ postId: pAncient, userId: followed.id });

  // A private stranger's amplification: never attributable to the viewer.
  await db.update(user).set({ isPrivate: true }).where(eq(user.id, privateReposter.id));
  await db.insert(postRepost).values({ postId: pPlainNew, userId: privateReposter.id });

  // The bookmark tie: same instant, controlled tiebreak ids — the stranger's
  // smaller id wins the tie, unless bookmarks secretly scored.
  const bookmarkSeed = await makePost(bookmarkAuthor.id, "seed bookmark post", 70);
  pBookmarkAuthorNew = await makePost(bookmarkAuthor.id, "more from s2", 4, {
    id: "22222222-2222-2222-8222-222222222222",
  });
  pTieStranger = await makePost(tieStranger.id, "random thought", 4, {
    id: "11111111-1111-1111-8111-111111111111",
  });

  pDoom2016 = await makePost(strangerB.id, "#doom2016 hype", 2);
  pRequestedDoom = await makePost(requestedAuthor.id, "#doom hot take", 4);
  await makePost(privateAuthor.id, "secret words here", 2, { isPrivate: true });
  const deleted = await makePost(strangerC.id, "deleted words", 2);
  pRemoved = await makePost(strangerC.id, "removed words", 2);
  await db.update(post).set({ deletedAt: new Date() }).where(eq(post.id, deleted));
  await db
    .update(post)
    .set({ removedAt: new Date(), removedReason: "test removal" })
    .where(eq(post.id, pRemoved));

  await db.insert(postLike).values({ postId: likeSeed, userId: viewer.id });
  await db.insert(postLike).values({ postId: root, userId: viewer.id });
  await db.insert(postLike).values({ postId: pHades, userId: viewer.id });
  await db.insert(postBookmark).values({ postId: bookmarkSeed, userId: viewer.id });
  // A self-repost (dual-arm dedup case) and a stranger amplification.
  await db.insert(postRepost).values({ postId: pFollowOld, userId: followed.id });
  await db.insert(postRepost).values({ postId: pDoomOld, userId: followed.id });
  await db.insert(followRequest).values({ requesterId: viewer.id, targetId: requestedAuthor.id });
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

function rankedContext(user: TestUser) {
  return contextFor(user);
}

describe("ranked global (For you)", () => {
  it("orders by interest, not chronology, with ranking metadata", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const positions = new Map(page.items.map((item, index) => [item.id, index]));
    // Favorite-game interest beats raw freshness.
    expect(positions.get(pDoomOld)).toBeLessThan(
      positions.get(pPlainNew) ?? Number.MAX_SAFE_INTEGER,
    );
    // Like + follow affinity beats freshness.
    expect(positions.get(pLikedAuthorNew)).toBeLessThan(
      positions.get(pTieStranger) ?? Number.MAX_SAFE_INTEGER,
    );
    // Reply-thread topic interest beats no signal at the same age.
    expect(positions.get(pTopic)).toBeLessThan(
      positions.get(pThreadAuthorPlain) ?? Number.MAX_SAFE_INTEGER,
    );
    // The thread's author earns no endorsement from the reply.
    expect(positions.has(pThreadAuthorPlain)).toBe(true);

    expect(page.ranking).toMatchObject({ hasInterests: true });
    expect(page.ranking?.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(page.ranking?.expiresAt ?? "")).not.toBeNaN();
    expect(page.ranking?.suggestions).toEqual([]);
  });

  it("ranks a newcomer's liked-topic post above an old followed post", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const positions = new Map(page.items.map((item, index) => [item.id, index]));
    // The followed post carries follow plus like-author affinity; the
    // newcomer's two-topic match plus freshness still wins. (pFollowOld is
    // excluded as the comparator: its self-repost refreshes its event.)
    expect(positions.get(pLikedTopicNew)).toBeLessThan(
      positions.get(pLikeSeedPost) ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("carries generic reply topics across a nested thread without endorsing its author", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const positions = new Map(page.items.map((item, index) => [item.id, index]));
    expect(positions.get(pDeepTopic)).toBeLessThan(
      positions.get(pDeepAuthorPlain) ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("gives bookmarks no voice: the bookmarked author's post loses its freshness tie", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const positions = new Map(page.items.map((item, index) => [item.id, index]));
    expect(positions.get(pTieStranger)).toBeLessThan(
      positions.get(pBookmarkAuthorNew) ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("excludes private, deleted, and removed content under a text filter", async () => {
    // Each query matches exactly one hidden post — the private "secret words
    // here", the deleted "deleted words", the removed "removed words" — and
    // every page is empty: invisible text is not probeable through the
    // filter, and a text filter never serves tombstones.
    for (const q of ["secret", "deleted", "removed words"]) {
      const page = await call(
        appRouter.post.list,
        { feed: "global", ranked: true, limit: 20, q },
        { context: rankedContext(viewer) },
      );
      expect(page.items).toEqual([]);
      expect(page.ranking?.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("never serves removed posts on a ranked feed — no stubs", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    expect(page.items.find((item) => item.id === pRemoved)).toBeUndefined();
  });

  it("keeps pages stable across mutations under one snapshot id", async () => {
    const first = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2 },
      { context: rankedContext(viewer) },
    );
    expect(first.nextCursor).not.toBeNull();
    const snapshotId = first.ranking?.snapshotId;
    expect(snapshotId).toBeTruthy();

    // A post that would rank first in a fresh snapshot must not disturb this
    // one. The viewer authors it so Discover's candidate order stays
    // undisturbed for the later tests.
    await makePost(viewer.id, "#doom breaking news", 0);
    const second = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2, cursor: first.nextCursor ?? undefined },
      { context: rankedContext(viewer) },
    );
    expect(second.ranking?.snapshotId).toBe(snapshotId);
    const firstIds = first.items.map((item) => item.id);
    const secondIds = second.items.map((item) => item.id);
    expect(secondIds).toHaveLength(2);
    for (const id of secondIds) expect(firstIds).not.toContain(id);
    for (const item of second.items) {
      expect(item.content).not.toContain("breaking news");
    }
  });

  it("serves repost-driven originals once, attributed to the latest amplification", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const ids = page.items.map((item) => item.id);
    // The ancient post is far outside the authored window: only its recent
    // repost surfaces it.
    const ancient = page.items.find((item) => item.id === pAncient);
    expect(ancient?.repostedBy?.id).toBe(followed.id);
    // Authored and amplified by the network: deduplicated to the latest
    // event, which is the repost.
    const doom = page.items.filter((item) => item.id === pDoomOld);
    expect(doom).toHaveLength(1);
    expect(doom[0]?.repostedBy?.id).toBe(followed.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never reveals a private reposter: the event downgrades to the original", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const plain = page.items.find((item) => item.id === pPlainNew);
    expect(plain?.repostedBy).toBeNull();
  });

  it("resumes the SAME snapshot from the first page on refetch", async () => {
    const first = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2 },
      { context: rankedContext(viewer) },
    );
    const snapshotId = first.ranking?.snapshotId;
    const refetch = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2, snapshotId },
      { context: rankedContext(viewer) },
    );
    expect(refetch.ranking?.snapshotId).toBe(snapshotId);
    expect(refetch.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
  });

  it("advances past newly hidden slices without stranding ranked pagination (#305)", async () => {
    const reader = await createTestUser();
    const author = await createTestUser();
    const q = `pagination-${reader.id}`;
    for (let i = 0; i < 6; i += 1) await makePost(author.id, `${q} ${i}`, i + 1);
    const first = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, q, limit: 6 },
      { context: rankedContext(reader) },
    );
    expect(first.items).toHaveLength(6);
    for (const item of first.items.slice(0, 3)) {
      await db.update(post).set({ isPrivate: true }).where(eq(post.id, item.id));
    }
    const resumed = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, q, limit: 2, snapshotId: first.ranking?.snapshotId },
      { context: rankedContext(reader) },
    );
    expect(resumed.items.map((item) => item.id)).toEqual(
      first.items.slice(3, 5).map((item) => item.id),
    );
    expect(resumed.nextCursor).not.toBeNull();
    const last = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, q, limit: 2, cursor: resumed.nextCursor ?? undefined },
      { context: rankedContext(reader) },
    );
    expect(last.items.map((item) => item.id)).toEqual(first.items.slice(5).map((item) => item.id));
    expect(last.nextCursor).toBeNull();
  });

  it("keeps visible unfamiliar repost attribution outside Following (#305)", async () => {
    const reader = await createTestUser();
    const author = await createTestUser();
    const reposter = await createTestUser();
    const q = `amplification-${reader.id}`;
    const postId = await makePost(author.id, q, 24 * 40);
    await db.insert(postRepost).values({ postId, userId: reposter.id });
    for (const feed of ["global", "discover"] as const) {
      const page = await call(
        appRouter.post.list,
        { feed, ranked: true, q },
        { context: rankedContext(reader) },
      );
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.repostedBy?.id).toBe(reposter.id);
    }
  });
});

describe("ranked Following", () => {
  it("carries own and followed posts and reposts, deduplicated, nothing else", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "following", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const ids = page.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(pFollowOld);
    expect(ids).toContain(pOwn);
    expect(ids).toContain(pDoomOld);
    expect(ids).not.toContain(pPlainNew);
    expect(ids).not.toContain(pHades);
    // The self-repost deduplicates to one event, attributed to the reposter.
    const followEvent = page.items.find((item) => item.id === pFollowOld);
    expect(followEvent?.repostedBy?.id).toBe(followed.id);
    // The stranger's original arrives only as the followed repost event.
    expect(page.items.find((item) => item.id === pDoomOld)?.repostedBy?.id).toBe(followed.id);
  });

  it("downgrades a withdrawn amplification to the original in place", async () => {
    const first = await call(
      appRouter.post.list,
      { feed: "following", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const snapshotId = first.ranking?.snapshotId;
    const before = first.items.find((item) => item.id === pFollowOld);
    expect(before?.repostedBy?.id).toBe(followed.id);
    const position = first.items.findIndex((item) => item.id === pFollowOld);

    await db
      .delete(postRepost)
      .where(and(eq(postRepost.postId, pFollowOld), eq(postRepost.userId, followed.id)));
    try {
      const resumed = await call(
        appRouter.post.list,
        { feed: "following", ranked: true, limit: 20, snapshotId },
        { context: rankedContext(viewer) },
      );
      expect(resumed.ranking?.snapshotId).toBe(snapshotId);
      // Same frozen position, now the plain original — the order never moves
      // for a withdrawn repost.
      expect(resumed.items[position]?.id).toBe(pFollowOld);
      expect(resumed.items[position]?.repostedBy).toBeNull();
    } finally {
      await db.insert(postRepost).values({ postId: pFollowOld, userId: followed.id });
    }
  });
});

describe("ranked Discover", () => {
  it("includes recent reposts of followed authors whose originals are outside the candidate window", async () => {
    await db.insert(follow).values({ followerId: viewer.id, followingId: ancientAuthor.id });
    try {
      const page = await call(
        appRouter.post.list,
        { feed: "discover", ranked: true, limit: 20 },
        { context: rankedContext(viewer) },
      );
      expect(page.items.find((item) => item.id === pAncient)?.repostedBy?.id).toBe(followed.id);
    } finally {
      await db
        .delete(follow)
        .where(and(eq(follow.followerId, viewer.id), eq(follow.followingId, ancientAuthor.id)));
    }
  });

  it("serves followed and unfollowed originals with top-3 followable suggestions", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "discover", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(pDoomOld);
    expect(ids).toContain(pPlainNew);
    expect(ids).toContain(pAncient);
    expect(ids).not.toContain(pOwn);
    expect(ids).toContain(pFollowOld);
    expect(ids).toContain(pLikedAuthorNew);

    // The ancient original arrives only on its recent amplification.
    expect(page.items.find((item) => item.id === pAncient)?.repostedBy?.id).toBe(followed.id);

    const suggestions = page.ranking?.suggestions ?? [];
    // The frozen top three include the requested and followed authors;
    // both drop from suggestions without refilling from later authors.
    expect(suggestions.map((suggestion) => suggestion.id)).toEqual([strangerB.id]);
    const suggestionIds = suggestions.map((suggestion) => suggestion.id);
    expect(new Set(suggestionIds).size).toBe(suggestionIds.length);
    for (const suggestion of suggestions) {
      expect(suggestion.id).not.toBe(viewer.id);
      expect(suggestion.id).not.toBe(followed.id);
      expect(suggestion.id).not.toBe(requestedAuthor.id);
      expect(suggestion.viewerIsFollowing).toBe(false);
      expect(suggestion.hasRequested).toBe(false);
      expect(suggestion.name).toBeTruthy();
    }
  });

  it("keeps posts after following their author while hiding the follow suggestion", async () => {
    const first = await call(
      appRouter.post.list,
      { feed: "discover", ranked: true, limit: 20 },
      { context: rankedContext(viewer) },
    );
    const top = first.ranking?.suggestions[0];
    expect(top?.id).toBe(strangerB.id);
    await db.insert(follow).values({ followerId: viewer.id, followingId: top?.id ?? "" });
    try {
      const resumed = await call(
        appRouter.post.list,
        { feed: "discover", ranked: true, limit: 20, snapshotId: first.ranking?.snapshotId },
        { context: rankedContext(viewer) },
      );
      // No refill until a new snapshot: the followed author drops and the
      // frozen remainder stands.
      expect(resumed.ranking?.suggestions).toEqual([]);
      expect(resumed.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    } finally {
      await db
        .delete(follow)
        .where(eq(follow.followerId, viewer.id) && eq(follow.followingId, top?.id ?? ""));
    }
  });
});

describe("ranked filters", () => {
  it("applies the game filter with exact token semantics", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20, gameSlug: "doom" },
      { context: rankedContext(viewer) },
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(pDoomOld);
    expect(ids).toContain(pRequestedDoom);
    // `#doom2016` is one token, not a `#doom` match — the SQL prefilter is a
    // superset, the ranker's exact-token pass drops it.
    expect(ids).not.toContain(pDoom2016);
    expect(ids).not.toContain(pPlainNew);
  });

  it("applies the text filter to ranked candidates", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20, q: "coffee" },
      { context: rankedContext(viewer) },
    );
    expect(page.items.map((item) => item.id)).toEqual([pPlainNew]);
  });

  it("serves working empty snapshots for unknown game slugs", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20, gameSlug: "no-such-game" },
      { context: rankedContext(viewer) },
    );
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.ranking?.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.ranking?.suggestions).toEqual([]);
  });
});

describe("ranked contract guards", () => {
  const context = () => rankedContext(viewer);

  it("rejects non-ranked discover and ranked scoping filters", async () => {
    await expect(
      call(appRouter.post.list, { feed: "discover" }, { context: context() }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, authorId: viewer.id },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(appRouter.post.list, { feed: "bookmarks", ranked: true }, { context: context() }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, includeReplies: true },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, kind: "all" },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses ranked reads without a session", async () => {
    await expect(
      call(appRouter.post.list, { feed: "global", ranked: true }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses foreign, cross-scope, mismatched-cursor, and malformed resumes explicitly", async () => {
    const first = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2 },
      { context: rankedContext(viewer) },
    );
    const snapshotId = first.ranking?.snapshotId ?? "";
    const cursor = first.nextCursor ?? "";

    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, snapshotId },
        { context: rankedContext(otherViewer) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: RANK_SNAPSHOT_INVALID_MESSAGE });

    await expect(
      call(
        appRouter.post.list,
        { feed: "discover", ranked: true, snapshotId },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: RANK_SNAPSHOT_INVALID_MESSAGE });

    const other = await call(
      appRouter.post.list,
      { feed: "following", ranked: true, limit: 2 },
      { context: context() },
    );
    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, cursor, snapshotId: other.ranking?.snapshotId },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, cursor: "not-a-cursor" },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Malformed pagination cursor." });

    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, cursor, q: "coffee", snapshotId },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: RANK_SNAPSHOT_INVALID_MESSAGE });
  });

  it("refuses expired snapshots and cleans them up boundedly", async () => {
    const first = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2 },
      { context: rankedContext(viewer) },
    );
    const snapshotId = first.ranking?.snapshotId ?? "";
    await db
      .update(feedRankSnapshot)
      .set({ expiresAt: new Date(Date.now() - HOUR) })
      .where(eq(feedRankSnapshot.id, snapshotId));

    await expect(
      call(
        appRouter.post.list,
        { feed: "global", ranked: true, snapshotId },
        { context: context() },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: RANK_SNAPSHOT_INVALID_MESSAGE });

    const rebuilt = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 2 },
      { context: context() },
    );
    expect(rebuilt.ranking?.snapshotId).not.toBe(snapshotId);
    const [expired] = await db
      .select({ id: feedRankSnapshot.id })
      .from(feedRankSnapshot)
      .where(eq(feedRankSnapshot.id, snapshotId));
    expect(expired).toBeUndefined();
  });

  it("bounds live snapshots per viewer", async () => {
    for (let i = 0; i < 12; i += 1) {
      await call(
        appRouter.post.list,
        { feed: "global", ranked: true, limit: 1 },
        { context: context() },
      );
    }
    const rows = await db
      .select({ id: feedRankSnapshot.id })
      .from(feedRankSnapshot)
      .where(eq(feedRankSnapshot.viewerId, viewer.id));
    expect(rows.length).toBeLessThanOrEqual(10);
  });
});

describe("ranked cold start", () => {
  it("serves freshness-ordered pages with hasInterests false", async () => {
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, limit: 20 },
      { context: rankedContext(cold) },
    );
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.ranking?.hasInterests).toBe(false);
    expect(page.ranking?.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ranked candidate limits (#356)", () => {
  it.each(["authored", "reposts"] as const)(
    "finds exact game matches beyond a full batch of %s false positives",
    async (arm) => {
      const reader = await createTestUser();
      const author = await createTestUser();
      const q = `game-limit-${reader.id}`;
      const createdAt = new Date(Date.now() - (arm === "authored" ? 1 : 24 * 40) * HOUR);
      const noise = await db
        .insert(post)
        .values(
          Array.from({ length: FEED_RANK_POOL_LIMIT }, () => ({
            authorId: author.id,
            content: `${q} #doom2016`,
            createdAt,
          })),
        )
        .returning({ id: post.id });
      const exactId = await makePost(author.id, `${q} #DOOM!`, arm === "authored" ? 2 : 24 * 41);
      if (arm === "reposts") {
        await db.insert(postRepost).values([
          ...noise.map(({ id }) => ({
            postId: id,
            userId: reader.id,
            createdAt: new Date(Date.now() - HOUR),
          })),
          { postId: exactId, userId: reader.id, createdAt: new Date(Date.now() - 2 * HOUR) },
        ]);
      }
      const page = await call(
        appRouter.post.list,
        { feed: "global", ranked: true, q, gameSlug: "doom" },
        { context: rankedContext(reader) },
      );
      expect(page.items.map((item) => item.id)).toEqual([exactId]);
      expect(page.items[0]?.repostedBy?.id ?? null).toBe(arm === "reposts" ? reader.id : null);
    },
  );

  it("counts distinct originals rather than a viral post's repost events", async () => {
    const reader = await createTestUser();
    const author = await createTestUser();
    const q = `repost-limit-${reader.id}`;
    const viralId = await makePost(author.id, `${q} viral`, 24 * 40);
    const otherId = await makePost(author.id, `${q} other`, 24 * 40);
    // These actors need no sessions; bulk seeding keeps the 500-event regression cheap.
    const actors = await db
      .insert(user)
      .values(
        Array.from({ length: FEED_RANK_POOL_LIMIT }, (_, i) => ({
          id: `${reader.id}-reposter-${i}`,
          name: `Reposter ${i}`,
          email: `${reader.id}-reposter-${i}@example.com`,
        })),
      )
      .returning({ id: user.id });
    await db.insert(postRepost).values([
      ...actors.map(({ id }, i) => ({
        postId: viralId,
        userId: id,
        createdAt: new Date(Date.now() - HOUR - i * 1000),
      })),
      { postId: otherId, userId: reader.id, createdAt: new Date(Date.now() - 2 * HOUR) },
      { postId: viralId, userId: privateReposter.id, createdAt: new Date() },
    ]);
    const page = await call(
      appRouter.post.list,
      { feed: "global", ranked: true, q },
      { context: rankedContext(reader) },
    );
    expect(page.items.map((item) => item.id).sort()).toEqual([viralId, otherId].sort());
    expect(page.items.find((item) => item.id === viralId)?.repostedBy?.id).toBe(actors[0]?.id);
  });
});
