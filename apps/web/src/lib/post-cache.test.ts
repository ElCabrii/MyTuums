import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage } from "@/lib/orpc";
import {
  readCachedPost,
  restoreFeeds,
  snapshotFeeds,
  updatePostEverywhere,
} from "@/lib/post-cache";

// These helpers are pure `(QueryClient, args) => …` functions, so they are
// exercised against a bare client — no React, no rendering, no session. That
// is deliberate: the component suites that used to cover this behaviour were
// removed ahead of the Jotai migration (see ../../TESTS-TO-REWRITE.md), and
// this is the layer where the optimistic-update logic actually lives.

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-1",
    content: "clutched a 1v5",
    createdAt: new Date(2026, 7, 20),
    author: {
      id: "author-1",
      name: "Alex Mercer",
      username: "alexmercer",
      displayUsername: "AlexMercer",
      image: null,
    },
    likeCount: 3,
    viewerHasLiked: false,
    ...overrides,
  };
}

function makePage(items: Post[]): InfiniteData<PostListPage> {
  return {
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  };
}

/**
 * A key under the `post.list` prefix. TanStack matches query keys by prefix,
 * so appending a discriminator is enough to stand in for the distinct feeds a
 * post really appears in (home timeline, author profile) without depending on
 * oRPC's internal key shape.
 */
const feedKey = (suffix: string) => [...orpc.post.list.key(), suffix];

const HOME = feedKey("home");
const PROFILE = feedKey("profile");

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe("readCachedPost", () => {
  it("finds a post held in any feed", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-9", likeCount: 7 })]));

    expect(readCachedPost(queryClient, "post-9")?.likeCount).toBe(7);
  });

  it("returns undefined when no feed holds it", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1" })]));

    expect(readCachedPost(queryClient, "absent")).toBeUndefined();
  });

  it("returns undefined against an empty cache", () => {
    expect(readCachedPost(queryClient, "post-1")).toBeUndefined();
  });
});

describe("updatePostEverywhere", () => {
  it("patches the same post in every feed that holds it", () => {
    // The whole reason this sweeps rather than targeting one key: a post is
    // cached in the home timeline and its author's profile at once, and a
    // like has to move both or the two disagree on the next render.
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));
    queryClient.setQueryData(PROFILE, makePage([makePost({ id: "post-1", likeCount: 3 })]));

    updatePostEverywhere(queryClient, "post-1", (post) => ({
      ...post,
      likeCount: post.likeCount + 1,
      viewerHasLiked: true,
    }));

    for (const key of [HOME, PROFILE]) {
      const cached = queryClient.getQueryData<InfiniteData<PostListPage>>(key);
      expect(cached?.pages[0]?.items[0]?.likeCount).toBe(4);
      expect(cached?.pages[0]?.items[0]?.viewerHasLiked).toBe(true);
    }
  });

  it("leaves other posts in the same page untouched", () => {
    queryClient.setQueryData(
      HOME,
      makePage([makePost({ id: "post-1", likeCount: 3 }), makePost({ id: "post-2", likeCount: 9 })]),
    );

    updatePostEverywhere(queryClient, "post-1", (post) => ({ ...post, likeCount: 99 }));

    const items = queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items;
    expect(items?.[0]?.likeCount).toBe(99);
    expect(items?.[1]?.likeCount).toBe(9);
  });

  it("is a no-op for a post no feed holds", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));

    updatePostEverywhere(queryClient, "absent", (post) => ({ ...post, likeCount: 99 }));

    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items[0]?.likeCount,
    ).toBe(3);
  });
});

describe("snapshotFeeds / restoreFeeds", () => {
  it("undoes an optimistic edit across every feed", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));
    queryClient.setQueryData(PROFILE, makePage([makePost({ id: "post-1", likeCount: 3 })]));

    const snapshot = snapshotFeeds(queryClient);

    updatePostEverywhere(queryClient, "post-1", (post) => ({
      ...post,
      likeCount: post.likeCount + 1,
      viewerHasLiked: true,
    }));
    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items[0]?.likeCount,
    ).toBe(4);

    restoreFeeds(queryClient, snapshot);

    for (const key of [HOME, PROFILE]) {
      const cached = queryClient.getQueryData<InfiniteData<PostListPage>>(key);
      expect(cached?.pages[0]?.items[0]?.likeCount).toBe(3);
      expect(cached?.pages[0]?.items[0]?.viewerHasLiked).toBe(false);
    }
  });

  it("captures the state at snapshot time, not at restore time", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));
    const snapshot = snapshotFeeds(queryClient);

    updatePostEverywhere(queryClient, "post-1", (post) => ({ ...post, likeCount: 50 }));
    updatePostEverywhere(queryClient, "post-1", (post) => ({ ...post, likeCount: 51 }));

    restoreFeeds(queryClient, snapshot);

    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items[0]?.likeCount,
    ).toBe(3);
  });
});
