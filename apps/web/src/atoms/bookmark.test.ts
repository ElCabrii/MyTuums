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
import { readCachedPost } from "@/lib/post-cache";
import { clearBookmarkFamilies, toggleBookmarkAtomFamily } from "@/atoms/bookmark";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

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
    removed: false,
    deleted: false,
    removedReason: null,
    attachments: [],
    ...overrides,
  };
}

function feedPage(posts: Post[]): InfiniteData<PostListPage> {
  return { pages: [{ items: posts, nextCursor: null }], pageParams: [undefined] };
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
});

describe("clearBookmarkFamilies", () => {
  it("empties the exported family — the same post id produces a brand new atom afterwards", () => {
    const before = toggleBookmarkAtomFamily("post-x");
    clearBookmarkFamilies();
    expect(toggleBookmarkAtomFamily("post-x")).not.toBe(before);
  });
});
