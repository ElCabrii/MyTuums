import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";

// The mock mirrors the real client's procedure tree — the post-cache sweep in
// `updatePostEverywhere` walks `orpc.post.list`/`orpc.search.posts` keys, so a
// missing group here throws inside every bookmark mutation.
const fakeClient = {
  post: {
    bookmark: vi.fn(),
    unbookmark: vi.fn(),
    like: vi.fn(),
    unlike: vi.fn(),
    list: vi.fn(),
    thread: vi.fn(),
  },
  search: { typeahead: vi.fn(), users: vi.fn(), posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { orpc, type Post, type PostListPage } from "@/lib/orpc";
import { postListQueryOptions } from "@/lib/query-definitions";
import { readCachedPost } from "@/lib/post-cache";
import { clearBookmarkFamilies, toggleBookmarkAtomFamily } from "@/atoms/bookmark";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

function makePost(overrides: Partial<Post> & { id: string }): Post {
  return {
    content: "hello",
    translation: null,
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
    quotedPostId: null,
    quoted: null,
    repostCount: 0,
    viewerHasReposted: false,
    repostedBy: null,
    viewerHasBookmarked: false,
    removed: false,
    deleted: false,
    removedReason: null,
    editedAt: null,
    unavailable: false,
    private: false,
    parentPrivate: false,
    quotedPrivate: false,
    attachments: [],
    ...overrides,
  };
}

function feedPage(posts: Post[]): InfiniteData<PostListPage> {
  return { pages: [{ items: posts, nextCursor: null, gameMentions: {} }], pageParams: [undefined] };
}

function freshStoreWithPost(post: Post) {
  const store = createStore();
  const queryClient = new QueryClient();
  store.set(queryClientAtom, queryClient);
  queryClient.setQueryData(orpc.post.list.key({ input: { limit: 20 } }), feedPage([post]));
  return { store, queryClient };
}

describe("toggleBookmarkAtomFamily", () => {
  it("lands the optimistic patch synchronously, before the mutationFn resolves, and touches only the bookmark flag", () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasBookmarked: false, likeCount: 4 }),
    );
    fakeClient.post.bookmark.mockImplementation(() => new Promise(() => {}));

    store.set(toggleBookmarkAtomFamily("post-1"));

    // A bookmark is private state: the patch flips the viewer's own flag and
    // must leave the public count alone — there is no bookmark count to derive.
    const patched = readCachedPost(queryClient, "post-1");
    expect(patched?.viewerHasBookmarked).toBe(true);
    expect(patched?.likeCount).toBe(4);
  });

  // Rollback lives on a MUTATION-LEVEL `onError`, not a per-call callback —
  // the full reasoning is in `atoms/like.ts`; this test never mounts
  // (`store.sub`) anything, so a passing rollback is only possible because
  // the callback fires regardless of what is mounted.
  it("rolls back a rejected mutation", async () => {
    const { store, queryClient } = freshStoreWithPost(makePost({ id: "post-1" }));
    fakeClient.post.bookmark.mockRejectedValue(new Error("network down"));

    store.set(toggleBookmarkAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasBookmarked).toBe(true);

    await vi.waitFor(() => {
      expect(readCachedPost(queryClient, "post-1")?.viewerHasBookmarked).toBe(false);
    });
  });

  it("drops a superseded response instead of flickering the UI back", async () => {
    const { store, queryClient } = freshStoreWithPost(makePost({ id: "post-1" }));

    let resolveBookmark!: (value: { postId: string; viewerHasBookmarked: boolean }) => void;
    fakeClient.post.bookmark.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBookmark = resolve;
        }),
    );
    fakeClient.post.unbookmark.mockImplementation(() => new Promise(() => {}));

    // Click bookmark, then unbookmark before the first round trip resolves.
    // Both share `scope: { id: "post-bookmark:post-1" }`, so they queue; the
    // bookmark response resolving last is the only possible order here.
    store.set(toggleBookmarkAtomFamily("post-1"));
    store.set(toggleBookmarkAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasBookmarked).toBe(false);

    await vi.waitFor(() => expect(fakeClient.post.bookmark).toHaveBeenCalled());
    resolveBookmark({ postId: "post-1", viewerHasBookmarked: true });

    await vi.waitFor(() => expect(fakeClient.post.unbookmark).toHaveBeenCalled());
    expect(readCachedPost(queryClient, "post-1")?.viewerHasBookmarked).toBe(false);
  });

  it("reads the direction from the cache, so a burst of clicks alternates", () => {
    const { store, queryClient } = freshStoreWithPost(makePost({ id: "post-1" }));
    fakeClient.post.bookmark.mockImplementation(() => new Promise(() => {}));
    fakeClient.post.unbookmark.mockImplementation(() => new Promise(() => {}));

    store.set(toggleBookmarkAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasBookmarked).toBe(true);

    store.set(toggleBookmarkAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasBookmarked).toBe(false);
  });

  // The saved page's own cleanup half: a confirmed un-bookmark drops the row
  // from the bookmarks feed's cached pages on the click itself, instead of
  // leaving it there until some unrelated refetch. Only that feed's entry
  // loses the row — everywhere else the post keeps rendering, with its flag
  // confirmed false.
  it("a confirmed unbookmark drops the row from the bookmarks feed's cache only", async () => {
    const store = createStore();
    const queryClient = new QueryClient();
    store.set(queryClientAtom, queryClient);
    const saved = makePost({ id: "post-1", viewerHasBookmarked: true });
    // Seeded through the production query-options helper — oRPC stamps
    // infinite queries with a `type: "infinite"` discriminator the bare
    // `.key()` form lacks, and the row removal matches exactly the key the
    // bookmarks page's atom registers.
    const bookmarksKey = postListQueryOptions({ feed: "bookmarks" }).queryKey;
    const homeKey = orpc.post.list.key({ input: { limit: 20 } });
    // Seeded as a literal: the options-typed key carries the exact page-param
    // type, which the `feedPage` helper's wider annotation does not satisfy.
    queryClient.setQueryData(bookmarksKey, {
      pages: [{ items: [saved], nextCursor: null, gameMentions: {} }],
      pageParams: [undefined],
    });
    queryClient.setQueryData(homeKey, feedPage([saved]));

    fakeClient.post.unbookmark.mockResolvedValue({ postId: "post-1", viewerHasBookmarked: false });

    store.set(toggleBookmarkAtomFamily("post-1"));

    // Wait on the outcome, not on the mock's call: `mockResolvedValue`
    // settles a microtask after the call, and the row drop happens in
    // `onSuccess` — after that settlement.
    await vi.waitFor(() => {
      const bookmarks = queryClient.getQueryData<InfiniteData<PostListPage>>(bookmarksKey);
      expect(bookmarks?.pages[0]?.items).toEqual([]);
    });

    const home = queryClient.getQueryData<InfiniteData<PostListPage>>(homeKey);
    expect(home?.pages[0]?.items[0]?.id).toBe("post-1");
    expect(home?.pages[0]?.items[0]?.viewerHasBookmarked).toBe(false);
  });

  // The other side of that coin: the row-drop keys off the RESPONSE value, so
  // a confirmed bookmark — whose response is true — removes nothing.
  it("a confirmed bookmark keeps the row in the bookmarks feed's cache", async () => {
    const store = createStore();
    const queryClient = new QueryClient();
    store.set(queryClientAtom, queryClient);
    const bookmarksKey = postListQueryOptions({ feed: "bookmarks" }).queryKey;
    queryClient.setQueryData(bookmarksKey, {
      pages: [
        {
          items: [makePost({ id: "post-1", viewerHasBookmarked: false })],
          nextCursor: null,
          gameMentions: {},
        },
      ],
      pageParams: [undefined],
    });

    fakeClient.post.bookmark.mockResolvedValue({ postId: "post-1", viewerHasBookmarked: true });

    store.set(toggleBookmarkAtomFamily("post-1"));

    // Let the confirmation settle before asserting the row survived it.
    await vi.waitFor(() =>
      expect(
        queryClient
          .getMutationCache()
          .getAll()
          .some((m) => m.state.status === "success"),
      ).toBe(true),
    );
    const bookmarks = queryClient.getQueryData<InfiniteData<PostListPage>>(bookmarksKey);
    expect(bookmarks?.pages[0]?.items.map((post) => post.id)).toEqual(["post-1"]);
    expect(bookmarks?.pages[0]?.items[0]?.viewerHasBookmarked).toBe(true);
  });
});

describe("clearBookmarkFamilies", () => {
  it("empties the exported family — the same post id produces a brand new atom afterwards", () => {
    const before = toggleBookmarkAtomFamily("post-x");
    clearBookmarkFamilies();
    expect(toggleBookmarkAtomFamily("post-x")).not.toBe(before);
  });
});
