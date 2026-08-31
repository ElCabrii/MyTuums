import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage, type SearchPostsPage, type Thread } from "@/lib/orpc";
import { postListQueryOptions } from "@/lib/query-definitions";
import {
  readCachedPost,
  removePostFromBookmarksFeed,
  restorePosts,
  snapshotPosts,
  updatePostEverywhere,
} from "@/lib/post-cache";

function makePost(overrides: Partial<Post> & { id: string }): Post {
  return {
    content: "hello",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    parentId: null,
    parent: null,
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
    viewerHasBookmarked: false,
    // The tombstone fields (issue #38, plus #148): never removed or deleted
    // by default.
    removed: false,
    deleted: false,
    removedReason: null,
    attachments: [],
    ...overrides,
  };
}

function feedPage(posts: Post[]): InfiniteData<PostListPage> {
  return {
    pages: [{ items: posts, nextCursor: null }],
    pageParams: [undefined],
  };
}

function replyPage(directReply: Post, continuation: Post): InfiniteData<PostListPage> {
  return {
    pages: [
      {
        items: [directReply],
        nextCursor: null,
        continuations: [
          {
            rootPostId: directReply.id,
            items: [continuation],
            nextCursor: null,
          },
        ],
      },
    ],
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

    it("patches a post embedded in a direct reply's continuation", () => {
      const queryClient = new QueryClient();
      const directReply = makePost({ id: "direct-1" });
      const continuation = makePost({
        id: "continuation-1",
        parentId: directReply.id,
        likeCount: 2,
      });
      const key = orpc.post.list.key({ input: { limit: 20, parentId: "focused-1" } });
      queryClient.setQueryData(key, replyPage(directReply, continuation));

      updatePostEverywhere(queryClient, continuation.id, (post) => ({
        ...post,
        likeCount: post.likeCount + 1,
        viewerHasLiked: true,
      }));

      const page = queryClient.getQueryData<InfiniteData<PostListPage>>(key)?.pages[0];
      if (!page || !("continuations" in page)) throw new Error("Missing continuation fixture");
      expect(page.continuations[0]?.items[0]).toMatchObject({
        likeCount: 3,
        viewerHasLiked: true,
      });
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

    it("finds a post that exists only inside an embedded reply continuation", () => {
      const queryClient = new QueryClient();
      const directReply = makePost({ id: "direct-only-1" });
      const continuation = makePost({ id: "embedded-only-1", parentId: directReply.id });
      queryClient.setQueryData(
        orpc.post.list.key({ input: { limit: 20, parentId: "focused-1" } }),
        replyPage(directReply, continuation),
      );

      expect(readCachedPost(queryClient, continuation.id)).toEqual(continuation);
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

      const snapshot = snapshotPosts(queryClient, "round-trip-1", "like");
      updatePostEverywhere(queryClient, "round-trip-1", (p) => ({
        ...p,
        likeCount: p.likeCount + 1,
        viewerHasLiked: true,
      }));

      // Sanity: the mutation actually changed something before restoring.
      expect(
        queryClient.getQueryData<InfiniteData<PostListPage>>(feedKey)?.pages[0]?.items[0]
          ?.likeCount,
      ).toBe(6);

      restorePosts(queryClient, snapshot!);

      expect(queryClient.getQueryData(feedKey)).toEqual(before.feed);
      expect(queryClient.getQueryData(threadKey)).toEqual(before.thread);
    });

    it("restorePosts undoes an edit to a post cached only under search.posts", () => {
      const queryClient = new QueryClient();
      const post = makePost({ id: "round-trip-search-1", likeCount: 5, viewerHasLiked: false });
      const searchKey = orpc.search.posts.key({ input: { q: "hello", limit: 20 } });
      queryClient.setQueryData(searchKey, searchPage([post]));

      const snapshot = snapshotPosts(queryClient, "round-trip-search-1", "like");
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

      expect(snapshotPosts(queryClient, "nothing-cached", "like")).toBeUndefined();
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
      const snapshotA = snapshotPosts(queryClient, "post-a", "like");
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

    // The within-row twin of the issue #53 case: like and bookmark mutate the
    // same cached row under different mutation scopes (`post-like:{id}` vs
    // `post-bookmark:{id}`), so like's snapshot can be taken, bookmark's
    // optimistic flip can land, and only then can like's request fail. A
    // whole-ROW rollback would silently revert the bookmark flip until a
    // refetch; the snapshot's scope keeps the rollback field-scoped.
    it("a failed like's rollback leaves a bookmark flip on the same post's row standing", () => {
      const queryClient = new QueryClient();
      const post = makePost({
        id: "interleaved-1",
        likeCount: 5,
        viewerHasLiked: false,
        viewerHasBookmarked: false,
      });
      const feedKey = orpc.post.list.key({ input: { limit: 20 } });
      queryClient.setQueryData(feedKey, feedPage([post]));

      // Like: snapshot (bookmark state happens to be false), then patch.
      const likeSnapshot = snapshotPosts(queryClient, "interleaved-1", "like");
      updatePostEverywhere(queryClient, "interleaved-1", (p) => ({
        ...p,
        viewerHasLiked: true,
        likeCount: p.likeCount + 1,
      }));

      // Bookmark flips the same row while the like is in flight.
      updatePostEverywhere(queryClient, "interleaved-1", (p) => ({
        ...p,
        viewerHasBookmarked: true,
      }));

      // The like fails: its rollback must undo the like and nothing else.
      restorePosts(queryClient, likeSnapshot!);

      const rolled =
        queryClient.getQueryData<InfiniteData<PostListPage>>(feedKey)?.pages[0]?.items[0];
      expect(rolled?.viewerHasLiked).toBe(false);
      expect(rolled?.likeCount).toBe(5);
      expect(rolled?.viewerHasBookmarked).toBe(true);
    });

    // …and the mirror image: a failed bookmark's rollback leaves a concurrent
    // like's optimistic state alone.
    it("a failed bookmark's rollback leaves a like's optimistic state on the same row standing", () => {
      const queryClient = new QueryClient();
      const post = makePost({
        id: "interleaved-2",
        likeCount: 5,
        viewerHasLiked: false,
        viewerHasBookmarked: false,
      });
      const feedKey = orpc.post.list.key({ input: { limit: 20 } });
      queryClient.setQueryData(feedKey, feedPage([post]));

      const bookmarkSnapshot = snapshotPosts(queryClient, "interleaved-2", "bookmark");
      updatePostEverywhere(queryClient, "interleaved-2", (p) => ({
        ...p,
        viewerHasBookmarked: true,
      }));

      updatePostEverywhere(queryClient, "interleaved-2", (p) => ({
        ...p,
        viewerHasLiked: true,
        likeCount: p.likeCount + 1,
      }));

      restorePosts(queryClient, bookmarkSnapshot!);

      const rolled =
        queryClient.getQueryData<InfiniteData<PostListPage>>(feedKey)?.pages[0]?.items[0];
      expect(rolled?.viewerHasBookmarked).toBe(false);
      expect(rolled?.viewerHasLiked).toBe(true);
      expect(rolled?.likeCount).toBe(6);
    });
  });

  describe("removePostFromBookmarksFeed", () => {
    // The bookmarks page's cache is one `post.list` entry narrowed by the
    // `feed: "bookmarks"` input — the same prefix every other feed shares.
    // The removal must hit that entry alone: an un-bookmark is not a
    // deletion, and the post keeps rendering everywhere else it is cached.
    it("drops the row from the bookmarks feed's pages only, leaving every other cache untouched", () => {
      const queryClient = new QueryClient();
      const target = makePost({ id: "saved-1", viewerHasBookmarked: true });
      const neighbour = makePost({ id: "saved-2", viewerHasBookmarked: true });
      // The bookmarks entry is seeded through the production query-options
      // helper: oRPC stamps infinite queries with a `type: "infinite"`
      // discriminator the bare `.key()` form lacks, and the removal matches
      // exactly the key the bookmarks page's atom registers.
      const bookmarksKey = postListQueryOptions({ feed: "bookmarks" }).queryKey;
      const homeKey = orpc.post.list.key({ input: { limit: 20 } });
      const authorKey = orpc.post.list.key({
        input: { limit: 20, authorId: "author-1", includeReplies: true },
      });
      const followingKey = orpc.post.list.key({ input: { limit: 20, feed: "following" } });
      const searchKey = orpc.search.posts.key({ input: { q: "hello", limit: 20 } });

      queryClient.setQueryData(bookmarksKey, {
        pages: [{ items: [target, neighbour], nextCursor: null }],
        pageParams: [undefined],
      });
      queryClient.setQueryData(homeKey, feedPage([target]));
      queryClient.setQueryData(authorKey, feedPage([target]));
      queryClient.setQueryData(followingKey, feedPage([target]));
      queryClient.setQueryData(searchKey, searchPage([target]));

      removePostFromBookmarksFeed(queryClient, "saved-1");

      const bookmarks = queryClient.getQueryData<InfiniteData<PostListPage>>(bookmarksKey);
      expect(bookmarks?.pages[0]?.items.map((p) => p.id)).toEqual(["saved-2"]);

      // Every other home for the row keeps it.
      expect(
        queryClient.getQueryData<InfiniteData<PostListPage>>(homeKey)?.pages[0]?.items[0]?.id,
      ).toBe("saved-1");
      expect(
        queryClient.getQueryData<InfiniteData<PostListPage>>(authorKey)?.pages[0]?.items[0]?.id,
      ).toBe("saved-1");
      expect(
        queryClient.getQueryData<InfiniteData<PostListPage>>(followingKey)?.pages[0]?.items[0]?.id,
      ).toBe("saved-1");
      expect(
        queryClient.getQueryData<InfiniteData<SearchPostsPage>>(searchKey)?.pages[0]?.items[0]?.id,
      ).toBe("saved-1");
    });

    // Row removal is pagination-safe because `getNextPageParam` reads the
    // stored per-page `nextCursor`, not anything derived from the rows the
    // client holds. Removing an item must leave every page's cursor exactly
    // where the server put it.
    it("keeps each page's nextCursor, so a later Load more cannot skip or repeat", () => {
      const queryClient = new QueryClient();
      const first = makePost({ id: "page-1-post", viewerHasBookmarked: true });
      const second = makePost({ id: "page-2-post", viewerHasBookmarked: true });
      const bookmarksKey = postListQueryOptions({ feed: "bookmarks" }).queryKey;

      queryClient.setQueryData(bookmarksKey, {
        pages: [
          { items: [first], nextCursor: "cursor-1" },
          { items: [second], nextCursor: null },
        ],
        pageParams: [undefined, "cursor-1"],
      });

      removePostFromBookmarksFeed(queryClient, "page-1-post");

      const data = queryClient.getQueryData<InfiniteData<PostListPage>>(bookmarksKey);
      expect(data?.pages.map((page) => page.nextCursor)).toEqual(["cursor-1", null]);
      expect(data?.pageParams).toEqual([undefined, "cursor-1"]);
      expect(data?.pages[1]?.items.map((p) => p.id)).toEqual(["page-2-post"]);
    });
  });
});
