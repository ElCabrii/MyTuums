import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";

// Mirrors the real client's procedure tree the post-cache sweep walks, plus
// the repost pair this suite exercises.
const fakeClient = {
  post: {
    like: vi.fn(),
    unlike: vi.fn(),
    repost: vi.fn(),
    unrepost: vi.fn(),
    list: vi.fn(),
    thread: vi.fn(),
  },
  search: { typeahead: vi.fn(), users: vi.fn(), posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { orpc, type Post, type PostListPage } from "@/lib/orpc";
import { readCachedPost } from "@/lib/post-cache";
import { clearRepostFamilies, toggleRepostAtomFamily } from "@/atoms/repost";
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

describe("toggleRepostAtomFamily", () => {
  it("lands the optimistic patch synchronously, before the mutationFn resolves", () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasReposted: false, repostCount: 4 }),
    );
    fakeClient.post.repost.mockImplementation(() => new Promise(() => {}));

    store.set(toggleRepostAtomFamily("post-1"));

    const patched = readCachedPost(queryClient, "post-1");
    expect(patched?.viewerHasReposted).toBe(true);
    expect(patched?.repostCount).toBe(5);
  });

  it("rolls back a rejected mutation — mutation-level onError, same contract as like", async () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasReposted: false, repostCount: 4 }),
    );
    fakeClient.post.repost.mockRejectedValue(new Error("network down"));

    store.set(toggleRepostAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasReposted).toBe(true);

    await vi.waitFor(() => {
      expect(readCachedPost(queryClient, "post-1")?.viewerHasReposted).toBe(false);
    });
    expect(readCachedPost(queryClient, "post-1")?.repostCount).toBe(4);
  });

  it("reads the repost direction from the cache, so a burst of clicks alternates", () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasReposted: false }),
    );
    fakeClient.post.repost.mockImplementation(() => new Promise(() => {}));
    fakeClient.post.unrepost.mockImplementation(() => new Promise(() => {}));

    store.set(toggleRepostAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasReposted).toBe(true);

    store.set(toggleRepostAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasReposted).toBe(false);
  });

  it("reconciles from the response and refetches the feed lists — the event's position is server-ordered", async () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasReposted: false, repostCount: 1 }),
    );
    fakeClient.post.repost.mockResolvedValue({
      postId: "post-1",
      repostCount: 7,
      viewerHasReposted: true,
    });

    store.set(toggleRepostAtomFamily("post-1"));

    await vi.waitFor(() => {
      expect(readCachedPost(queryClient, "post-1")?.repostCount).toBe(7);
    });

    // A repost event belongs at the top of the home feeds at its own
    // timestamp; success invalidates rather than splices.
    await vi.waitFor(() => {
      expect(queryClient.isFetching({ queryKey: orpc.post.list.key() })).toBeGreaterThanOrEqual(0);
    });
    const listKey = orpc.post.list.key({ input: { limit: 20 } });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  // A repost is a feed event in both directions: an unrepost removes an
  // event (the primary flow unreposts from the "You reposted" card at the
  // top of the viewer's own home feed), and no cached page knows it is gone
  // until the same server-ordered refetch runs. Without this, the stale
  // event card sat in the feed until an unrelated refetch landed.
  it("invalidates the feed lists after an unrepost too — the removed event is server-ordered out of the feed", async () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasReposted: true, repostCount: 5 }),
    );
    fakeClient.post.unrepost.mockResolvedValue({
      postId: "post-1",
      repostCount: 3,
      viewerHasReposted: false,
    });

    store.set(toggleRepostAtomFamily("post-1"));

    // 3 is a value only the reconcile can write — the optimistic patch
    // alone produces 4 (5 minus one), so this waits for onSuccess.
    await vi.waitFor(() => {
      expect(readCachedPost(queryClient, "post-1")?.repostCount).toBe(3);
    });

    const listKey = orpc.post.list.key({ input: { limit: 20 } });
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it("scopes the mutation to the post only, shared by both directions", () => {
    const { store, queryClient } = freshStoreWithPost(makePost({ id: "post-1" }));
    fakeClient.post.repost.mockImplementation(() => new Promise(() => {}));

    store.set(toggleRepostAtomFamily("post-1"));

    const scopeIds = queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.options.scope?.id);
    expect(scopeIds).toEqual(["post-repost:post-1"]);
  });
});

describe("clearRepostFamilies", () => {
  it("empties the exported family — the same post id produces a brand new atom afterwards", () => {
    const before = toggleRepostAtomFamily("post-x");
    clearRepostFamilies();
    expect(toggleRepostAtomFamily("post-x")).not.toBe(before);
  });
});
