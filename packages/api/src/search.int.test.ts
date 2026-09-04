import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { closeDb, db } from "@my-tuums/db";
import { post, user } from "@my-tuums/db/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEARCH_PAGE_SIZE, SEARCH_QUERY_MAX_LENGTH } from "./constants.js";
import type { Context } from "./context.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { upsertGames } from "./games-sync.js";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  setUserRole,
  truncateAll,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

// testing/harness.ts registers its own beforeEach that gives every test in
// this file a fresh, isolated RateLimiter automatically (see the comment on
// `currentTestRateLimiter` there) — that is what lets the budget-exhaustion
// test below start from a clean slate. Within one `it()`, every call still
// shares that same instance, so the accumulation it relies on works.

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/** A user promoted to moderator through the row, re-fetched so the session carries the role (no cookieCache). */
async function moderatorUser() {
  const user = await createTestUser();
  await setUserRole(user.id, "moderator");
  return freshSessionFor(user);
}

/** A tag unique to the calling test, so its queries can't match rows another test seeded. */
function uniqueTag(): string {
  return `z${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Direct inserts for content-controlled post fixtures — the same idea as
 * `seedPosts` in testing/harness.ts, but with caller-chosen content, which
 * the search procedures match against (seedPosts' content is hardcoded).
 * `createdAt`/`parentId` are omitted from the insert (rather than passed as
 * `undefined`) when not given, so the column's own defaults apply.
 *
 * Goes through `anonContext.db` — a raw drizzle handle, not a rate-limited
 * procedure call — so this stays unaffected by search now requiring a
 * session (issue #36).
 */
async function seedPostContent(
  authorId: string,
  content: string,
  opts: { createdAt?: Date; parentId?: string } = {},
): Promise<{ id: string; createdAt: Date }> {
  const row: typeof post.$inferInsert = { authorId, content };
  if (opts.parentId) row.parentId = opts.parentId;
  if (opts.createdAt) row.createdAt = opts.createdAt;
  const [inserted] = await anonContext.db
    .insert(post)
    .values(row)
    .returning({ id: post.id, createdAt: post.createdAt });
  return inserted;
}

/** Bulk version of `seedPostContent`, for the pagination fixtures. */
async function seedPostContentMany(
  authorId: string,
  count: number,
  content: string,
  createdAt: Date | ((index: number) => Date),
): Promise<{ id: string; createdAt: Date }[]> {
  const rows: (typeof post.$inferInsert)[] = Array.from({ length: count }, (_, i) => ({
    authorId,
    content,
    createdAt: createdAt instanceof Date ? createdAt : createdAt(i),
  }));
  return anonContext.db
    .insert(post)
    .values(rows)
    .returning({ id: post.id, createdAt: post.createdAt });
}

/**
 * Direct inserts for user fixtures where `createTestUser` gets in the way —
 * mostly so `createdAt` can be controlled precisely, which sign-up has no way
 * to do at all and the tie-breaking tests need. Columns the search procedures
 * read are set; the rest are left to defaults, the same way `seedPosts` leaves
 * post columns alone.
 */
async function seedUsers(
  rows: Array<{ username: string; name?: string; createdAt?: Date }>,
): Promise<{ id: string; username: string | null; createdAt: Date }[]> {
  const values: (typeof user.$inferInsert)[] = rows.map((row) => {
    const value: typeof user.$inferInsert = {
      id: randomUUID(),
      name: row.name ?? "Seed User",
      email: `seed+${randomUUID()}@example.com`,
      username: row.username,
      displayUsername: row.username,
    };
    if (row.createdAt) value.createdAt = row.createdAt;
    return value;
  });
  return anonContext.db
    .insert(user)
    .values(values)
    .returning({ id: user.id, username: user.username, createdAt: user.createdAt });
}

interface SearchPageInput {
  q: string;
  cursor?: string;
  limit?: number;
}

/** Walks `search.users` to exhaustion via `nextCursor`, collecting every id it returns. */
async function walkAllUserPages(q: string, context: Context, limit?: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const input: SearchPageInput = { q, cursor };
    if (limit) input.limit = limit;
    const page = await call(appRouter.search.users, input, { context });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) {
      throw new Error("walkAllUserPages: exceeded 500 pages — pagination looks like it's looping.");
    }
  } while (cursor);

  return ids;
}

/** Walks `search.posts` to exhaustion via `nextCursor`, collecting every id it returns. */
async function walkAllPostPages(q: string, context: Context, limit?: number): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const input: SearchPageInput = { q, cursor };
    if (limit) input.limit = limit;
    const page = await call(appRouter.search.posts, input, { context });
    ids.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    if (pages > 500) {
      throw new Error("walkAllPostPages: exceeded 500 pages — pagination looks like it's looping.");
    }
  } while (cursor);

  return ids;
}

describe("search requires authentication", () => {
  it("rejects an anonymous caller on all three procedures", async () => {
    await expect(
      call(appRouter.search.typeahead, { q: "al" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.search.users, { q: "al" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(appRouter.search.posts, { q: "al" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("search input validation", () => {
  it("rejects an empty query", async () => {
    const viewer = await createTestUser();
    await expect(
      call(appRouter.search.typeahead, { q: "" }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a whitespace-only query — trimming first is what makes min(1) catch this", async () => {
    const viewer = await createTestUser();
    await expect(
      call(appRouter.search.typeahead, { q: "   \n\t  " }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a query one character over SEARCH_QUERY_MAX_LENGTH, and accepts exactly at it", async () => {
    const viewer = await createTestUser();
    const result = await call(
      appRouter.search.typeahead,
      { q: "a".repeat(SEARCH_QUERY_MAX_LENGTH) },
      { context: contextFor(viewer) },
    );
    expect(result.users).toEqual([]);

    await expect(
      call(
        appRouter.search.typeahead,
        { q: "a".repeat(SEARCH_QUERY_MAX_LENGTH + 1) },
        { context: contextFor(viewer) },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("search.typeahead", () => {
  it("ranks username prefix matches above substring-only matches — even a newer one — and breaks ties deterministically", async () => {
    const viewer = await createTestUser();
    // Direct inserts so the tie-break is fully controlled: alpha and albert
    // share one instant (both prefix matches for "al"); beta matches only
    // via its name (a substring) but is NEWER — ranking must still put it
    // last, or the case expression isn't doing its job.
    const old = new Date("2025-06-01T12:00:00.000Z");
    const newer = new Date("2025-06-02T12:00:00.000Z");
    const seeded = await seedUsers([
      { username: "alpha", name: "Alpha", createdAt: old },
      { username: "albert", name: "Albert", createdAt: old },
      { username: "beta", name: "Alpha Fan", createdAt: newer },
    ]);

    const result = await call(
      appRouter.search.typeahead,
      { q: "al" },
      { context: contextFor(viewer) },
    );

    // alpha/albert tie on the timestamp, so the id is the whole tie-break.
    const prefixUsers = [seeded[0], seeded[1]].sort((a, b) => b.id.localeCompare(a.id));
    // `posts` is retained as an empty compatibility field so an older SPA
    // remains safe while the server rolls forward independently; `games` is
    // the issue-#314 widening.
    expect(Object.keys(result)).toEqual(["users", "games", "posts"]);
    expect(result.posts).toEqual([]);
    expect(result.users.map((u) => u.id)).toEqual([...prefixUsers.map((u) => u.id), seeded[2].id]);
  }, 20_000);

  it("caps users at 5 even when more match — the newest five win", async () => {
    const viewer = await createTestUser();
    const seeded = await seedUsers(
      Array.from({ length: 6 }, (_, i) => ({
        username: `cap${i}`,
        createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)),
      })),
    );

    const result = await call(
      appRouter.search.typeahead,
      { q: "cap" },
      { context: contextFor(viewer) },
    );

    expect(result.users).toHaveLength(5);
    // cap0 is the oldest — excluded by the cap, not by the filter.
    const expected = seeded.slice(1).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    expect(result.users.map((u) => u.id)).toEqual(expected.map((u) => u.id));
  });

  it("matches case-insensitively — aLice finds the alice username and the Alice name", async () => {
    const alice = await createTestUser({ username: "Alice", name: "Alice" });
    const viewer = await createTestUser();

    const result = await call(
      appRouter.search.typeahead,
      { q: "aLiCe" },
      { context: contextFor(viewer) },
    );
    const ids = result.users.map((u) => u.id);

    // She matches on both axes — the prefix match on the normalised username
    // is what ranks her first, ahead of any substring-only matches.
    expect(ids).toContain(alice.id);
    expect(ids[0]).toBe(alice.id);
  });

  it("treats % in a query as a literal — 100% finds only posts that contain a percent sign", async () => {
    const author = await createTestUser();
    const battery = await seedPostContent(author.id, "battery at 100%");
    await seedPostContent(author.id, "one hundred percent");
    await seedPostContent(author.id, "101 ways to win");

    const byLiteral = await call(
      appRouter.search.posts,
      { q: "100%" },
      { context: contextFor(author) },
    );
    expect(byLiteral.items.map((p) => p.id)).toEqual([battery.id]);

    // A bare % must not become a match-everything wildcard either — it finds
    // only content with a literal percent sign in it.
    const byPercent = await call(
      appRouter.search.posts,
      { q: "%" },
      { context: contextFor(author) },
    );
    expect(byPercent.items.map((p) => p.id)).toEqual([battery.id]);
  });

  it("excludes replies from post search results, mirroring the global feed", async () => {
    const author = await createTestUser();
    const tag = uniqueTag();
    const root = await seedPostContent(author.id, `${tag} root`);
    await seedPostContent(author.id, `${tag} reply`, { parentId: root.id });

    const posts = await call(appRouter.search.posts, { q: tag }, { context: contextFor(author) });
    expect(posts.items.map((p) => p.id)).toEqual([root.id]);
  });
});

describe("search.users", () => {
  it("keyset walk never repeats or skips a row across every page", async () => {
    const viewer = await createTestUser();
    const tag = uniqueTag();
    const count = SEARCH_PAGE_SIZE * 2 + 7; // guarantees at least 3 pages at the default page size
    const base = Date.now();
    const seeded = await seedUsers(
      Array.from({ length: count }, (_, i) => ({
        username: `${tag}${i}`,
        createdAt: new Date(base + i * 17),
      })),
    );

    const ids = await walkAllUserPages(tag, contextFor(viewer));

    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count); // no duplicates
    expect(new Set(ids)).toEqual(new Set(seeded.map((u) => u.id))); // exactly the seeded set
  }, 20_000);

  it("rows sharing a millisecond are still traversed exactly once — the silent-skip hazard posts.int.test.ts pins for posts, here on BetterAuth's text-id tie-break", async () => {
    const viewer = await createTestUser();
    const tag = uniqueTag();
    const tiedAt = new Date("2025-06-01T12:00:00.000Z");
    const tieCount = SEARCH_PAGE_SIZE + 5; // more than a small page, all sharing one createdAt
    const seeded = await seedUsers(
      Array.from({ length: tieCount }, (_, i) => ({
        username: `${tag}${i}`,
        createdAt: tiedAt,
      })),
    );

    // A small explicit limit forces the walk to cross the tied-timestamp
    // boundary several times, which is where a lost fractional-millisecond
    // cursor would silently drop every row in the current window.
    const ids = await walkAllUserPages(tag, contextFor(viewer), 10);

    expect(ids).toHaveLength(tieCount);
    expect(new Set(ids).size).toBe(tieCount);
    expect(new Set(ids)).toEqual(new Set(seeded.map((u) => u.id)));
  }, 20_000);

  it("items pin the publicUserColumns key set — no email, and no auth-reconnaissance columns", async () => {
    const author = await createTestUser();
    const viewer = await createTestUser();

    const result = await call(
      appRouter.search.users,
      { q: author.session.user.username! },
      { context: contextFor(viewer) },
    );
    const item = result.items.find((u) => u.id === author.id);

    expect(item).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual(
      [
        "id",
        "name",
        "username",
        "displayUsername",
        "image",
        "bio",
        "bannerImage",
        "createdAt",
        "viewerIsFollowing",
      ].sort(),
    );
    expect(item).not.toHaveProperty("email");
    expect(item).not.toHaveProperty("emailVerified");
    // Reconnaissance, not profile: which accounts a stolen password alone would
    // open, and which provider to phish.
    expect(item).not.toHaveProperty("twoFactorEnabled");
    expect(item).not.toHaveProperty("lastLoginMethod");
    expect(item).not.toHaveProperty("themePreference");
    expect(item).not.toHaveProperty("localePreference");
    expect(item).not.toHaveProperty("dateOfBirth");
  });
});

describe("search.posts", () => {
  it("keyset walk never repeats or skips a row across every page", async () => {
    const author = await createTestUser();
    const tag = uniqueTag();
    const count = SEARCH_PAGE_SIZE * 2 + 7;
    const base = Date.now();
    const seeded = await seedPostContentMany(author.id, count, tag, (i) => new Date(base + i * 17));

    const ids = await walkAllPostPages(tag, contextFor(author));

    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count);
    expect(new Set(ids)).toEqual(new Set(seeded.map((p) => p.id)));
  }, 20_000);

  it("a row inserted mid-walk never duplicates or drops a seeded row — the cursor is a position, not a snapshot", async () => {
    const author = await createTestUser();
    const tag = uniqueTag();
    const count = SEARCH_PAGE_SIZE * 2 + 7;
    const base = Date.now();
    const seeded = await seedPostContentMany(author.id, count, tag, (i) => new Date(base + i * 17));

    // First page at a small limit, then a matching row lands strictly
    // *between* that page's boundary row and the rows the next page will
    // return — the worst case for a cursor that had already walked past
    // this point.
    await call(appRouter.search.posts, { q: tag, limit: 10 }, { context: contextFor(author) });
    const midWalk = await seedPostContent(author.id, `${tag} mid-walk`, {
      createdAt: new Date(base + (count - 10) * 17 - 8),
    });

    const ids = await walkAllPostPages(tag, contextFor(author), 10);

    // The mid-walk row sorts inside the not-yet-visited range, so the walk
    // must pick it up without disturbing the seeded rows.
    expect(ids).toHaveLength(count + 1);
    expect(new Set(ids).size).toBe(count + 1);
    expect(new Set(ids)).toEqual(new Set([...seeded.map((p) => p.id), midWalk.id]));
  }, 20_000);

  it("items match post.list's projection exactly — proof both go through postSelection", async () => {
    const author = await createTestUser();
    const tag = uniqueTag();
    const target = await seedPostContent(author.id, `${tag} needle`);
    await seedPostContent(author.id, `${tag} other`);

    const searchResult = await call(
      appRouter.search.posts,
      { q: tag },
      { context: contextFor(author) },
    );
    const listResult = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(author) },
    );
    const searchRow = searchResult.items.find((p) => p.id === target.id);
    const listRow = listResult.items.find((p) => p.id === target.id);

    expect(listRow).toBeDefined();
    expect(searchRow).toEqual(listRow);
  });

  it("finds a tagged post through the `#tag` query a hashtag link issues — case-folded, and not the bare word", async () => {
    // The hashtag tokenizer linkifies `#Tag` to post search with the
    // lowercased, hash-prefixed query `#tag` (apps/web linked-text.tsx). This
    // pins the server half of that contract: `ilike` folds the case the client
    // folded, and the `#` keeps posts that merely contain the word out of what
    // is presented as "posts tagged #tag".
    const author = await createTestUser();
    const tag = uniqueTag();
    const tagged = await seedPostContent(author.id, `loving #${tag.toUpperCase()} today`);
    await seedPostContent(author.id, `just saying ${tag} without a hash`);

    const posts = await call(
      appRouter.search.posts,
      { q: `#${tag}` },
      { context: contextFor(author) },
    );
    expect(posts.items.map((p) => p.id)).toEqual([tagged.id]);
  });

  it("a removed post's content is not matchable by a third party, while the feed still shows the stub", async () => {
    const author = await createTestUser();
    const mod = await moderatorUser();
    const stranger = await createTestUser();
    const tag = uniqueTag();
    const removed = await seedPostContent(author.id, `hello ${tag} world`);

    await call(
      appRouter.moderation.removePost,
      { postId: removed.id, reason: "classified content" },
      { context: contextFor(mod) },
    );

    // The phrase exists ONLY in the removed post — a result here would prove
    // the searcher can probe removed content (the substring oracle).
    const posts = await call(appRouter.search.posts, { q: tag }, { context: contextFor(stranger) });
    expect(posts.items).toEqual([]);

    // The same post still shows in the feed as a bare stub — search is
    // different in kind from the feed, and this pins the distinction. The
    // feed is scoped to the author rather than the global timeline: earlier
    // pagination tests seed posts with future-dated `createdAt` values, so
    // the global first page is not guaranteed to contain this post and the
    // assertion would flake on it.
    const feed = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(stranger) },
    );
    const stub = feed.items.find((p) => p.id === removed.id);
    expect(stub?.removed).toBe(true);
    expect(stub?.content).toBeNull();
  });

  it("an author-deleted post is absent from both search and fresh feeds", async () => {
    const author = await createTestUser();
    const stranger = await createTestUser();
    const tag = uniqueTag();
    const deleted = await seedPostContent(author.id, `hello ${tag} world`);

    await call(appRouter.post.delete, { postId: deleted.id }, { context: contextFor(author) });

    // The same substring oracle the removal test above closes: search matches
    // the raw `content` column, which no projection touches, so a deleted
    // post's text must be unreachable rather than merely unrendered.
    const posts = await call(appRouter.search.posts, { q: tag }, { context: contextFor(stranger) });
    expect(posts.items).toEqual([]);

    const feed = await call(
      appRouter.post.list,
      { authorId: author.id },
      { context: contextFor(stranger) },
    );
    expect(feed.items.some((item) => item.id === deleted.id)).toBe(false);
  });
});

describe("search viewer context", () => {
  it("a signed-in viewer sees their follow and like reflected; a viewer with no relationship to the same query sees neither", async () => {
    const viewer = await createTestUser();
    const stranger = await createTestUser();
    const tag = uniqueTag();
    const author = await createTestUser({ username: tag });
    const targetPost = await seedPostContent(author.id, `${tag} content`);

    await call(appRouter.user.follow, { userId: author.id }, { context: contextFor(viewer) });
    await call(appRouter.post.like, { postId: targetPost.id }, { context: contextFor(viewer) });

    const asViewer = await call(
      appRouter.search.typeahead,
      { q: tag },
      { context: contextFor(viewer) },
    );
    expect(asViewer.users.find((u) => u.id === author.id)?.viewerIsFollowing).toBe(true);
    const viewerPosts = await call(
      appRouter.search.posts,
      { q: tag },
      { context: contextFor(viewer) },
    );
    expect(viewerPosts.items.find((p) => p.id === targetPost.id)?.viewerHasLiked).toBe(true);

    const asStranger = await call(
      appRouter.search.typeahead,
      { q: tag },
      { context: contextFor(stranger) },
    );
    expect(asStranger.users.find((u) => u.id === author.id)?.viewerIsFollowing).toBe(false);
    const strangerPosts = await call(
      appRouter.search.posts,
      { q: tag },
      { context: contextFor(stranger) },
    );
    expect(strangerPosts.items.find((p) => p.id === targetPost.id)?.viewerHasLiked).toBe(false);
  });
});

describe("search rate limiting", () => {
  it("exhausting the search budget rejects further search calls while post.list still succeeds — namespaces don't share", async () => {
    const viewer = await createTestUser();
    const tag = uniqueTag();
    await seedPostContent(viewer.id, `${tag} content`);

    // The whole search budget, burned through `search.users` — the cheapest
    // of the three procedures, and proof that all three share one namespace.
    const attempts = Array.from({ length: RATE_LIMITS.search.limit }, () =>
      call(appRouter.search.users, { q: tag }, { context: contextFor(viewer) }),
    );
    await Promise.all(attempts);

    await expect(
      call(appRouter.search.users, { q: tag }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(
      call(appRouter.search.typeahead, { q: tag }, { context: contextFor(viewer) }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // The read tier is a different namespace: a search abuser must not be
    // able to take the feeds down with them.
    const list = await call(appRouter.post.list, {}, { context: contextFor(viewer) });
    expect(list.items).toBeDefined();
  }, 20_000);
});

describe("search.games", () => {
  // Four games seeded for these tests: two matching "world" via NAME, one
  // matching only via its HASHTAG KEY (the resolution half of the matcher),
  // one not matching at all. Ranks chosen so the popularity order differs
  // from the seed order.
  const SEEDED = [
    {
      igdbId: 910_001,
      slug: "world-at-war",
      hashtagKey: "worldatwar",
      name: "World at War",
      popularityRank: 2,
      firstReleaseYear: 2008,
    },
    {
      igdbId: 910_002,
      slug: "other-world",
      hashtagKey: "otherworld",
      name: "Other World",
      popularityRank: 1,
      firstReleaseYear: 2019,
    },
    {
      igdbId: 910_003,
      slug: "wow-classic",
      hashtagKey: "worldofwarcraft",
      name: "Unrelated Title",
      popularityRank: 3,
      firstReleaseYear: 2019,
    },
    {
      igdbId: 910_004,
      slug: "hades",
      hashtagKey: "hades",
      name: "Hades",
      popularityRank: 4,
      firstReleaseYear: 2020,
    },
  ];

  beforeAll(async () => {
    await upsertGames(
      db,
      SEEDED.map(({ igdbId, slug, hashtagKey, name, popularityRank, firstReleaseYear }) => ({
        igdbId,
        slug,
        hashtagKey,
        name,
        summary: null,
        coverMediaPath: null,
        coverImageId: null,
        firstReleaseYear,
        genres: [],
        platforms: [],
        popularityRank,
      })),
      new Date(),
    );
  });

  it("typeahead offers games by name and by hashtag key, popularity-first, capped at 3", async () => {
    const viewer = await createTestUser();
    const result = await call(
      appRouter.search.typeahead,
      { q: "world" },
      { context: contextFor(viewer) },
    );

    // Other World (rank 1) leads World at War (rank 2); the hashtag-key-only
    // match joins them; Hades matches nothing.
    expect(result.games.map((game) => game.slug)).toEqual([
      "other-world",
      "world-at-war",
      "wow-classic",
    ]);

    // The exact hashtag key matches too — the composer's `#worldofwarcraft`
    // recommendation path (issue Q4) is this same matcher.
    const byKey = await call(
      appRouter.search.typeahead,
      { q: "worldofwarcraft" },
      { context: contextFor(viewer) },
    );
    expect(byKey.games.map((game) => game.slug)).toEqual(["wow-classic"]);
  });
});
