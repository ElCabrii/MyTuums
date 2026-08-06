import { describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";

const { fakeClient } = vi.hoisted(() => ({
  // The mock mirrors the real client's procedure tree — the post-cache sweep
  // in `updatePostEverywhere` now also walks `orpc.search.posts.key()`, so a
  // missing group here throws inside every like mutation.
  fakeClient: {
    post: { like: vi.fn(), unlike: vi.fn(), list: vi.fn(), thread: vi.fn() },
    search: { typeahead: vi.fn(), users: vi.fn(), posts: vi.fn() },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(fakeClient) };
});

import { orpc, type Post, type PostListPage } from "@/lib/orpc";
import { readCachedPost } from "@/lib/post-cache";
import { clearLikeFamilies, toggleLikeAtomFamily } from "@/atoms/like";

function makePost(overrides: Partial<Post> & { id: string }): Post {
  return {
    content: "hello",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    parentId: null,
    author: { id: "author-1", name: "Author", username: "author", displayUsername: "Author", image: null },
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
  return { pages: [{ items: posts, nextCursor: null }], pageParams: [undefined] };
}

function freshStoreWithPost(post: Post) {
  const store = createStore();
  const queryClient = new QueryClient();
  store.set(queryClientAtom, queryClient);
  queryClient.setQueryData(orpc.post.list.key({ input: { limit: 20 } }), feedPage([post]));
  return { store, queryClient };
}

describe("toggleLikeAtomFamily", () => {
  it("lands the optimistic patch synchronously, before the mutationFn resolves", () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasLiked: false, likeCount: 2 }),
    );
    fakeClient.post.like.mockImplementation(() => new Promise(() => {})); // never resolves in this test

    store.set(toggleLikeAtomFamily("post-1"));

    // `onMutate` is awaited at mutation.ts:222 and the scope queue gate is one
    // line later — calling a (synchronous) function and awaiting its return
    // value still runs the function body synchronously, so the patch below is
    // already in the cache by the time `store.set` returns, not a tick later.
    const patched = readCachedPost(queryClient, "post-1");
    expect(patched?.viewerHasLiked).toBe(true);
    expect(patched?.likeCount).toBe(3);
  });

  // This is the reason the whole rollback design lives on a MUTATION-LEVEL
  // `onError` fed by `onMutate` context, not a per-call `mutate(vars, { onError })`:
  // query-core only fires per-call callbacks when the mutation observer
  // `hasListeners()`, and `atomWithMutation` only subscribes in the RESULT
  // atom's `onMount`. `toggleLikeAtomFamily` is write-only and read with
  // `useSetAtom` in the app, and this test never mounts (`store.sub`) anything
  // either — so a passing rollback here is only possible because `onError`
  // lives on `mutation.options`, which fires regardless of what's mounted.
  it("rolls back a rejected mutation", async () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasLiked: false, likeCount: 2 }),
    );
    fakeClient.post.like.mockRejectedValue(new Error("network down"));

    store.set(toggleLikeAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(true);

    await waitFor(() => {
      expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(false);
    });
    expect(readCachedPost(queryClient, "post-1")?.likeCount).toBe(2);
  });

  it("drops a superseded response instead of flickering the UI back", async () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasLiked: false, likeCount: 2 }),
    );

    let resolveLike!: (value: unknown) => void;
    fakeClient.post.like.mockImplementation(
      () => new Promise((resolve) => { resolveLike = resolve; }),
    );
    fakeClient.post.unlike.mockImplementation(() => new Promise(() => {}));

    // Click like, then click unlike before the first round trip resolves.
    // Both mutations share `scope: { id: "post-like:post-1" }`, so they queue
    // rather than race — the unlike's mutationFn genuinely cannot run until
    // the like's finishes, which is what makes "let the like response
    // resolve last" the only possible order here, not something this test
    // has to force.
    store.set(toggleLikeAtomFamily("post-1"));
    store.set(toggleLikeAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(false);

    // The mutationFn call itself is deferred past a microtask boundary (see
    // the comment on the synchronous-patch test above), so `resolveLike` only
    // exists once the promise executor has actually run.
    await waitFor(() => expect(fakeClient.post.like).toHaveBeenCalled());
    resolveLike({ postId: "post-1", likeCount: 3, viewerHasLiked: true });

    // Once the like settles, the queued unlike is released and its
    // mutationFn finally runs — waiting for that call is a reliable signal
    // that the like's onSuccess has already had its chance to (not) reconcile.
    await waitFor(() => expect(fakeClient.post.unlike).toHaveBeenCalled());
    expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(false);
    expect(readCachedPost(queryClient, "post-1")?.likeCount).toBe(2);
  });

  it("scopes the mutation to the post only, with no viewer identity in it", () => {
    const { store, queryClient } = freshStoreWithPost(makePost({ id: "post-1" }));
    fakeClient.post.like.mockImplementation(() => new Promise(() => {}));

    store.set(toggleLikeAtomFamily("post-1"));

    const scopeIds = queryClient.getMutationCache().getAll().map((m) => m.options.scope?.id);
    expect(scopeIds).toEqual(["post-like:post-1"]);
  });

  it("reads the like direction from the cache, so a burst of clicks alternates", () => {
    const { store, queryClient } = freshStoreWithPost(
      makePost({ id: "post-1", viewerHasLiked: false }),
    );
    fakeClient.post.like.mockImplementation(() => new Promise(() => {}));
    fakeClient.post.unlike.mockImplementation(() => new Promise(() => {}));

    store.set(toggleLikeAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(true);

    store.set(toggleLikeAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(false);

    store.set(toggleLikeAtomFamily("post-1"));
    expect(readCachedPost(queryClient, "post-1")?.viewerHasLiked).toBe(true);
  });
});

describe("clearLikeFamilies", () => {
  it("empties the exported family — the same post id produces a brand new atom afterwards", () => {
    const before = toggleLikeAtomFamily("post-x");
    clearLikeFamilies();
    expect(toggleLikeAtomFamily("post-x")).not.toBe(before);
  });
});
