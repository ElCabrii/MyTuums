import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage, type Thread } from "@/lib/orpc";
import {
  readCachedPost,
  restorePosts,
  snapshotPosts,
  updatePostEverywhere,
} from "@/lib/post-cache";

// These helpers are pure `(QueryClient, args) => …` functions, so they are
// exercised against a bare client — no React, no rendering, no session. That
// is deliberate: the component suites that used to cover this behaviour were
// removed ahead of the Jotai migration, and this is the layer where the
// optimistic-update logic actually lives.

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
    parentId: null,
    likeCount: 3,
    replyCount: 0,
    viewerHasLiked: false,
    ...overrides,
  };
}

function makeThread(post: Post, ancestors: Post[] = []): Thread {
  return { post, ancestors, truncated: false };
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
const threadKey = (suffix: string) => [...orpc.post.thread.key(), suffix];

const HOME = feedKey("home");
const PROFILE = feedKey("profile");
const THREAD = threadKey("post-1");

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

  // The permalink-opened-cold case: `/post/<id>` puts a post in the thread
  // cache and in no feed at all, so a reader that only swept `post.list`
  // would report "not cached" and the like button would resolve its
  // direction from a default instead of from the truth on screen.
  it("finds the focused post of a thread when no feed holds it", () => {
    queryClient.setQueryData(THREAD, makeThread(makePost({ id: "post-9", likeCount: 7 })));

    expect(readCachedPost(queryClient, "post-9")?.likeCount).toBe(7);
  });

  it("finds an ancestor of a thread", () => {
    queryClient.setQueryData(
      THREAD,
      makeThread(makePost({ id: "reply-1" }), [makePost({ id: "root-1", likeCount: 5 })]),
    );

    expect(readCachedPost(queryClient, "root-1")?.likeCount).toBe(5);
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

  // A post open at its permalink while also visible in the timeline behind
  // it is the same row in two differently-shaped caches; a like has to move
  // both or navigating back shows the pre-click count.
  it("patches a post held in a feed and in a thread at once", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));
    queryClient.setQueryData(THREAD, makeThread(makePost({ id: "post-1", likeCount: 3 })));

    updatePostEverywhere(queryClient, "post-1", (post) => ({
      ...post,
      likeCount: post.likeCount + 1,
      viewerHasLiked: true,
    }));

    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items[0]?.likeCount,
    ).toBe(4);
    expect(queryClient.getQueryData<Thread>(THREAD)?.post.likeCount).toBe(4);
    expect(queryClient.getQueryData<Thread>(THREAD)?.post.viewerHasLiked).toBe(true);
  });

  it("patches an ancestor without touching the focused post", () => {
    queryClient.setQueryData(
      THREAD,
      makeThread(makePost({ id: "reply-1", likeCount: 1 }), [
        makePost({ id: "root-1", likeCount: 5 }),
      ]),
    );

    updatePostEverywhere(queryClient, "root-1", (post) => ({ ...post, likeCount: 6 }));

    const cached = queryClient.getQueryData<Thread>(THREAD);
    expect(cached?.ancestors[0]?.likeCount).toBe(6);
    expect(cached?.post.likeCount).toBe(1);
  });
});

describe("snapshotPosts / restorePosts", () => {
  it("undoes an optimistic edit across every feed", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));
    queryClient.setQueryData(PROFILE, makePage([makePost({ id: "post-1", likeCount: 3 })]));

    const snapshot = snapshotPosts(queryClient);

    updatePostEverywhere(queryClient, "post-1", (post) => ({
      ...post,
      likeCount: post.likeCount + 1,
      viewerHasLiked: true,
    }));
    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items[0]?.likeCount,
    ).toBe(4);

    restorePosts(queryClient, snapshot);

    for (const key of [HOME, PROFILE]) {
      const cached = queryClient.getQueryData<InfiniteData<PostListPage>>(key);
      expect(cached?.pages[0]?.items[0]?.likeCount).toBe(3);
      expect(cached?.pages[0]?.items[0]?.viewerHasLiked).toBe(false);
    }
  });

  // Rollback has to cover everything the patch touched. A snapshot that only
  // captured feeds would leave a failed like stuck on screen for whichever
  // copy lives in the thread cache — the focused post on a permalink, which
  // is the one the viewer is looking at.
  it("undoes an optimistic edit in the thread cache too", () => {
    queryClient.setQueryData(
      THREAD,
      makeThread(makePost({ id: "post-1", likeCount: 3 }), [
        makePost({ id: "root-1", likeCount: 5 }),
      ]),
    );

    const snapshot = snapshotPosts(queryClient);

    updatePostEverywhere(queryClient, "post-1", (post) => ({
      ...post,
      likeCount: 4,
      viewerHasLiked: true,
    }));
    updatePostEverywhere(queryClient, "root-1", (post) => ({ ...post, likeCount: 6 }));

    restorePosts(queryClient, snapshot);

    const cached = queryClient.getQueryData<Thread>(THREAD);
    expect(cached?.post.likeCount).toBe(3);
    expect(cached?.post.viewerHasLiked).toBe(false);
    expect(cached?.ancestors[0]?.likeCount).toBe(5);
  });

  it("captures the state at snapshot time, not at restore time", () => {
    queryClient.setQueryData(HOME, makePage([makePost({ id: "post-1", likeCount: 3 })]));
    const snapshot = snapshotPosts(queryClient);

    updatePostEverywhere(queryClient, "post-1", (post) => ({ ...post, likeCount: 50 }));
    updatePostEverywhere(queryClient, "post-1", (post) => ({ ...post, likeCount: 51 }));

    restorePosts(queryClient, snapshot);

    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(HOME)?.pages[0]?.items[0]?.likeCount,
    ).toBe(3);
  });
});
