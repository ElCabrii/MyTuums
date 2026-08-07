import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage, type SearchPostsPage, type Thread } from "@/lib/orpc";
import {
  readCachedPost,
  restorePosts,
  snapshotPosts,
  updatePostEverywhere,
} from "@/lib/post-cache";

function makePost(overrides: Partial<Post> & { id: string }): Post {
  return {
    content: "hello",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    parentId: null,
    author: {
      id: "author-1",
      name: "Author",
      username: "author",
      displayUsername: "Author",
      image: null,
    },
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
    // The tombstone fields (issue #38): never removed by default.
    removed: false,
    removedReason: null,
    ...overrides,
  };
}

function feedPage(posts: Post[]): InfiniteData<PostListPage> {
  return {
    pages: [{ items: posts, nextCursor: null }],
    pageParams: [undefined],
  };
}

function searchPage(posts: Post[]): InfiniteData<SearchPostsPage> {
  return {
    pages: [{ items: posts, nextCursor: null }],
    pageParams: [undefined],
  };
}

describe("post-cache", () => {
  describe("updatePostEverywhere", () => {
    it("patches a post cached in three different feed entries at once", () => {
      const queryClient = new QueryClient();
      const target = makePost({ id: "multi-1", likeCount: 3, viewerHasLiked: false });
      const other = makePost({ id: "other-1" });

      // Home timeline: the global feed passes no `feed` input key at all.
      const homeKey = orpc.post.list.key({ input: { limit: 20 } });
      // The post's author's own profile feed.
      const authorFeedKey = orpc.post.list.key({
        input: { limit: 20, authorId: "author-1", includeReplies: true },
      });
      // The reply list under whatever this post replies to.
      const replyListKey = orpc.post.list.key({ input: { limit: 20, parentId: "parent-1" } });
      // An unrelated feed entry that must stay untouched.
      const unrelatedKey = orpc.post.list.key({ input: { limit: 20, authorId: "someone-else" } });

      queryClient.setQueryData(homeKey, feedPage([target]));
      queryClient.setQueryData(authorFeedKey, feedPage([target]));
      queryClient.setQueryData(replyListKey, feedPage([other, target]));
      queryClient.setQueryData(unrelatedKey, feedPage([other]));

      updatePostEverywhere(queryClient, "multi-1", (post) => ({
        ...post,
        likeCount: post.likeCount + 1,
        viewerHasLiked: true,
      }));

      for (const key of [homeKey, authorFeedKey, replyListKey]) {
        const data = queryClient.getQueryData<InfiniteData<PostListPage>>(key);
        const patched = data?.pages[0]?.items.find((p) => p.id === "multi-1");
        expect(patched?.likeCount).toBe(4);
        expect(patched?.viewerHasLiked).toBe(true);
      }

      // The reply list's other item, and the unrelated feed, must be untouched.
      const replyListData = queryClient.getQueryData<InfiniteData<PostListPage>>(replyListKey);
      expect(replyListData?.pages[0]?.items.find((p) => p.id === "other-1")?.likeCount).toBe(0);
      const unrelatedData = queryClient.getQueryData<InfiniteData<PostListPage>>(unrelatedKey);
      expect(unrelatedData?.pages[0]?.items[0]?.likeCount).toBe(0);
    });

    it("patches a post cached under a search.posts result too", () => {
      const queryClient = new QueryClient();
      const target = makePost({ id: "search-1", likeCount: 3, viewerHasLiked: false });
      const searchKey = orpc.search.posts.key({ input: { q: "hello", limit: 20 } });
      queryClient.setQueryData(searchKey, searchPage([target]));

      updatePostEverywhere(queryClient, "search-1", (post) => ({
        ...post,
        likeCount: post.likeCount + 1,
        viewerHasLiked: true,
      }));

      const data = queryClient.getQueryData<InfiniteData<SearchPostsPage>>(searchKey);
      expect(data?.pages[0]?.items.find((p) => p.id === "search-1")?.likeCount).toBe(4);
      expect(data?.pages[0]?.items.find((p) => p.id === "search-1")?.viewerHasLiked).toBe(true);
    });

    it("patches the same post inside a post.thread entry as both data.post and an ancestor", () => {
      const queryClient = new QueryClient();
      const shared = makePost({ id: "shared-1", likeCount: 1, viewerHasLiked: false });
      const reply = makePost({ id: "reply-1", likeCount: 0, parentId: "shared-1" });

      // Thread A: "shared-1" is the focused post.
      const focusedThreadKey = orpc.post.thread.key({ input: { postId: "shared-1" } });
      queryClient.setQueryData<Thread>(focusedThreadKey, {
        post: shared,
        ancestors: [],
        truncated: false,
      });

      // Thread B: "shared-1" shows up as an ancestor of a different focused post.
      const replyThreadKey = orpc.post.thread.key({ input: { postId: "reply-1" } });
      queryClient.setQueryData<Thread>(replyThreadKey, {
        post: reply,
        ancestors: [shared],
        truncated: false,
      });

      updatePostEverywhere(queryClient, "shared-1", (post) => ({
        ...post,
        likeCount: post.likeCount + 1,
        viewerHasLiked: true,
      }));

      const focused = queryClient.getQueryData<Thread>(focusedThreadKey);
      expect(focused?.post.likeCount).toBe(2);
      expect(focused?.post.viewerHasLiked).toBe(true);

      const withAncestor = queryClient.getQueryData<Thread>(replyThreadKey);
      expect(withAncestor?.ancestors[0]?.likeCount).toBe(2);
      expect(withAncestor?.ancestors[0]?.viewerHasLiked).toBe(true);
      // The focused post of thread B is a different id and must be untouched.
      expect(withAncestor?.post.likeCount).toBe(0);
    });
  });

  describe("readCachedPost", () => {
    // Opening `/post/<id>` cold seeds only `post.thread`, not any `post.list`
    // entry — the post isn't in the home feed, a profile feed, or a reply
    // list. If `readCachedPost` only checked feeds, the like button on that
    // page would find nothing to optimistically patch and would just sit
    // there doing nothing until a refetch happened to land.
    it("finds a post that exists only in a thread cache and in no feed", () => {
      const queryClient = new QueryClient();
      const post = makePost({ id: "cold-1" });
      const key = orpc.post.thread.key({ input: { postId: "cold-1" } });
      queryClient.setQueryData<Thread>(key, { post, ancestors: [], truncated: false });

      expect(readCachedPost(queryClient, "cold-1")).toEqual(post);
    });

    it("returns undefined for an id that isn't cached anywhere", () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(
        orpc.post.list.key({ input: { limit: 20 } }),
        feedPage([makePost({ id: "known-1" })]),
      );

      expect(readCachedPost(queryClient, "unknown-id")).toBeUndefined();
    });

    // A post can live ONLY in a search result: the search page is the one
    // screen that holds rows that were never part of a feed or a thread. If
    // `readCachedPost` only scanned feeds and threads, the like button on a
    // search result would compute its direction from "nothing cached" and
    // re-send `like` for an already-liked post.
    it("finds a post that exists only in a search.posts result", () => {
      const queryClient = new QueryClient();
      const post = makePost({ id: "search-only-1", viewerHasLiked: true, likeCount: 9 });
      queryClient.setQueryData(
        orpc.search.posts.key({ input: { q: "hello", limit: 20 } }),
        searchPage([post]),
      );

      expect(readCachedPost(queryClient, "search-only-1")).toEqual(post);
    });

    it("tolerates a registered query whose data is still undefined", () => {
      const queryClient = new QueryClient();
      // A query can be registered in the cache (e.g. mid-fetch) before it has
      // any data. `getQueriesData` then returns `[key, undefined]`, and every
      // reader here has to survive that rather than throwing on `data.pages`.
      queryClient.getQueryCache().build(queryClient, {
        queryKey: orpc.post.list.key({ input: { limit: 20 } }),
      });
      queryClient.getQueryCache().build(queryClient, {
        queryKey: orpc.post.thread.key({ input: { postId: "pending-1" } }),
      });

      expect(() => readCachedPost(queryClient, "pending-1")).not.toThrow();
      expect(readCachedPost(queryClient, "pending-1")).toBeUndefined();
    });
  });

  describe("snapshot / restore round trip", () => {
    it("restorePosts undoes an updatePostEverywhere edit", () => {
      const queryClient = new QueryClient();
      const post = makePost({ id: "round-trip-1", likeCount: 5, viewerHasLiked: false });
      const feedKey = orpc.post.list.key({ input: { limit: 20 } });
      const threadKey = orpc.post.thread.key({ input: { postId: "round-trip-1" } });

      queryClient.setQueryData(feedKey, feedPage([post]));
      queryClient.setQueryData<Thread>(threadKey, { post, ancestors: [], truncated: false });

      const before = {
        feed: queryClient.getQueryData(feedKey),
        thread: queryClient.getQueryData(threadKey),
      };

      const snapshot = snapshotPosts(queryClient, "round-trip-1");
      updatePostEverywhere(queryClient, "round-trip-1", (p) => ({
        ...p,
        likeCount: p.likeCount + 1,
        viewerHasLiked: true,
      }));

      // Sanity: the mutation actually changed something before restoring.
      expect(queryClient.getQueryData<InfiniteData<PostListPage>>(feedKey)?.pages[0]?.items[0]?.likeCount).toBe(6);

      restorePosts(queryClient, snapshot!);

      expect(queryClient.getQueryData(feedKey)).toEqual(before.feed);
      expect(queryClient.getQueryData(threadKey)).toEqual(before.thread);
    });

    it("restorePosts undoes an edit to a post cached only under search.posts", () => {
      const queryClient = new QueryClient();
      const post = makePost({ id: "round-trip-search-1", likeCount: 5, viewerHasLiked: false });
      const searchKey = orpc.search.posts.key({ input: { q: "hello", limit: 20 } });
      queryClient.setQueryData(searchKey, searchPage([post]));

      const snapshot = snapshotPosts(queryClient, "round-trip-search-1");
      updatePostEverywhere(queryClient, "round-trip-search-1", (p) => ({
        ...p,
        likeCount: p.likeCount + 1,
        viewerHasLiked: true,
      }));

      // Sanity: the edit actually landed in the search cache before restoring.
      expect(
        queryClient.getQueryData<InfiniteData<SearchPostsPage>>(searchKey)?.pages[0]?.items[0]
          ?.likeCount,
      ).toBe(6);

      restorePosts(queryClient, snapshot!);

      expect(
        queryClient.getQueryData<InfiniteData<SearchPostsPage>>(searchKey)?.pages[0]?.items[0]
          ?.likeCount,
      ).toBe(5);
    });

    it("returns no snapshot for a post that isn't cached anywhere", () => {
      const queryClient = new QueryClient();

      expect(snapshotPosts(queryClient, "nothing-cached")).toBeUndefined();
      expect(() => {
        updatePostEverywhere(queryClient, "nothing-cached", (p) => p);
        readCachedPost(queryClient, "nothing-cached");
      }).not.toThrow();
    });

    // Issue #53: the rollback helpers used to snapshot and restore EVERY
    // cached entry, so a failed like on post A silently reverted a concurrent
    // — possibly already-confirmed — like on post B. A and B share one feed
    // entry here, the exact case a whole-cache replay gets wrong.
    it("rollback for one post leaves another post's confirmed state untouched, even in the same feed entry", () => {
      const queryClient = new QueryClient();
      const postA = makePost({ id: "post-a", likeCount: 5, viewerHasLiked: false });
      const postB = makePost({ id: "post-b", likeCount: 10, viewerHasLiked: false });
      const feedKey = orpc.post.list.key({ input: { limit: 20 } });
      queryClient.setQueryData(feedKey, feedPage([postA, postB]));

      // Like A: snapshot, then optimistic patch.
      const snapshotA = snapshotPosts(queryClient, "post-a");
      updatePostEverywhere(queryClient, "post-a", (p) => ({
        ...p,
        likeCount: p.likeCount + 1,
        viewerHasLiked: true,
      }));

      // Like B concurrently: optimistic patch, then the server confirms with
      // an authoritative count.
      updatePostEverywhere(queryClient, "post-b", (p) => ({
        ...p,
        likeCount: p.likeCount + 1,
        viewerHasLiked: true,
      }));
      updatePostEverywhere(queryClient, "post-b", (p) => ({ ...p, likeCount: 42 }));

      // A's request fails: the rollback must undo A's patch only.
      restorePosts(queryClient, snapshotA!);

      const items = queryClient.getQueryData<InfiniteData<PostListPage>>(feedKey)?.pages[0]?.items;
      expect(items?.find((p) => p.id === "post-a")?.likeCount).toBe(5);
      expect(items?.find((p) => p.id === "post-a")?.viewerHasLiked).toBe(false);
      expect(items?.find((p) => p.id === "post-b")?.likeCount).toBe(42);
      expect(items?.find((p) => p.id === "post-b")?.viewerHasLiked).toBe(true);
    });
  });
});
