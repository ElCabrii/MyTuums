import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { RANK_SNAPSHOT_INVALID_MESSAGE } from "@my-tuums/api/constants";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc, type PostListPage } from "@/lib/orpc";

const fakeClient = { post: { list: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  fakeClient.post.list.mockReset();
});

import {
  clearPostFeedFamily,
  decode,
  encode,
  homeFeedScopeAtom,
  postFeedAtom,
  postFeedKey,
  refreshRankedFeedAtomFamily,
} from "@/atoms/post-feed";
import { sessionAtom } from "@/atoms/session";
import { feedScopeAtom } from "@/lib/feed-scope";
import { postListQueryOptions } from "@/lib/query-definitions";
import type { PostFeedParams } from "@/atoms/post-feed";
import { makePost, makePostListPage, makeRanking } from "@/test/factories";

function freshStore() {
  const store = createStore();
  store.set(queryClientAtom, new QueryClient());
  return store;
}

function freshStoreWithClient() {
  const store = createStore();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  store.set(queryClientAtom, queryClient);
  return { store, queryClient };
}

describe("post-feed key encode/decode", () => {
  const cases: PostFeedParams[] = [
    { feed: "global" },
    { feed: "following" },
    { feed: "global", authorId: "author-1" },
    { feed: "global", parentId: "parent-1" },
    { feed: "global", includeReplies: true },
    { feed: "global", kind: "posts" },
    { feed: "global", kind: "replies" },
    { feed: "global", kind: "both" },
    { feed: "following", authorId: "author-1", parentId: "parent-1", includeReplies: true },
    { feed: "global", includeReposts: true },
    { feed: "global", authorId: "author-1", kind: "posts", includeReposts: true },
    {
      feed: "global",
      authorId: "author-1",
      includeReplies: true,
      includeReposts: true,
    },
    { feed: "global", q: "zelda" },
    { feed: "global", gameSlug: "hades" },
    { feed: "global", q: "co-op | speedrun", gameSlug: "elden-ring" },
  ];

  it.each(cases)("round-trips %o", (params) => {
    expect(decode(encode(params))).toEqual(params);
  });

  // `authorId` is a database id, not a validated slug, so it could contain the
  // "|" delimiter itself — and so can a Discover `q`. Both ride
  // `encodeURIComponent`, so `decode` can split on every delimiter and decode
  // each part back verbatim instead of truncating at the first one.
  it("round-trips an authorId and a query that themselves contain the delimiter", () => {
    const params: PostFeedParams = { feed: "global", authorId: "abc|def|ghi", q: "a|b|c" };
    expect(decode(encode(params))).toEqual(params);
  });

  it("decoding a minimal key produces no authorId/parentId/includeReplies keys at all", () => {
    const decoded = decode(encode({ feed: "global" }));
    expect(Object.keys(decoded)).toEqual(["feed"]);
  });

  it("pins the Both key — a tripwire against accidental key-layout drift", () => {
    expect(encode({ feed: "global", includeReplies: true })).toBe("global|r|||||");
  });

  it("keeps every unranked key on the seven-segment layout", () => {
    expect(encode({ feed: "global" })).toBe("global||||||");
    expect(encode({ feed: "following" })).toBe("following||||||");
    expect(encode({ feed: "bookmarks" })).toBe("bookmarks||||||");
  });
});

describe("post-feed ranked keys (issue #305)", () => {
  const rankedCases: PostFeedParams[] = [
    { feed: "global", ranked: true },
    { feed: "following", ranked: true },
    { feed: "discover", ranked: true },
    { feed: "discover", ranked: true, q: "zelda" },
    { feed: "discover", ranked: true, gameSlug: "hades" },
    { feed: "discover", ranked: true, q: "co-op | speedrun", gameSlug: "elden-ring" },
  ];

  it.each(rankedCases)("round-trips %o", (params) => {
    expect(decode(encode(params))).toEqual(params);
  });

  it("keys a ranked feed apart from its chronological twin", () => {
    expect(encode({ feed: "global", ranked: true })).not.toBe(encode({ feed: "global" }));
    expect(encode({ feed: "following", ranked: true })).not.toBe(encode({ feed: "following" }));
  });

  it("forces Discover ranked — a bare discover param keys as ranked", () => {
    expect(postFeedKey({ feed: "discover" })).toBe(encode({ feed: "discover", ranked: true }));
  });

  it("drops a ranked flag beside author scoping — the contract never ranks it", () => {
    expect(postFeedKey({ feed: "global", authorId: "author-1", ranked: true })).toBe(
      encode({ feed: "global", authorId: "author-1" }),
    );
  });
});

describe("ranked snapshot continuity (issue #305)", () => {
  interface ListInput {
    cursor?: string;
    snapshotId?: string;
  }

  it("resumes the cached first page's snapshot on refetch instead of minting a new order", async () => {
    const { store, queryClient } = freshStoreWithClient();
    const params: PostFeedParams = { feed: "global", ranked: true };
    const seenInputs: ListInput[] = [];
    fakeClient.post.list.mockImplementation((input: ListInput) => {
      seenInputs.push(input);
      if (input.cursor) {
        return Promise.resolve(
          makePostListPage({
            nextCursor: null,
            ranking: makeRanking({ snapshotId: "snapshot-1", suggestions: [] }),
          }),
        );
      }
      if (input.snapshotId === "snapshot-1") {
        return Promise.resolve(
          makePostListPage({
            items: [makePost({ content: "same order" })],
            nextCursor: null,
            ranking: makeRanking({ snapshotId: "snapshot-1", suggestions: [] }),
          }),
        );
      }
      return Promise.resolve(
        makePostListPage({
          items: [makePost({ content: "first order" })],
          nextCursor: null,
          ranking: makeRanking({ snapshotId: "snapshot-1", suggestions: [] }),
        }),
      );
    });

    const atom = postFeedAtom(params);
    const unsub = store.sub(atom, () => {});
    await vi.waitFor(() => {
      expect(store.get(atom).data?.pages[0]?.items[0]?.content).toBe("first order");
    });
    expect(fakeClient.post.list).toHaveBeenCalledTimes(1);
    // The first request carries no snapshot — the server mints the order.
    expect(seenInputs[0]?.snapshotId).toBeUndefined();

    await store.get(atom).refetch();
    await vi.waitFor(() => {
      expect(store.get(atom).data?.pages[0]?.items[0]?.content).toBe("same order");
    });
    expect(fakeClient.post.list).toHaveBeenCalledTimes(2);
    expect(seenInputs[1]?.snapshotId).toBe("snapshot-1");
    // The resume reused the same cache entry — no forked second query.
    expect(
      queryClient.getQueryCache().findAll({ queryKey: postListQueryOptions(params).queryKey }),
    ).toHaveLength(1);

    unsub();
  });

  // Refresh on a MOUNTED feed (issue #305 hardening): the observer stays
  // subscribed throughout, a second page is mid-flight when Refresh lands,
  // and the new ranking must arrive unmixed — verified against the
  // query-core source, where `reset` destroys (silently cancelling the
  // in-flight fetch, whose late resolution the retryer then discards) and
  // `refetchQueries(active)` restarts the still-mounted observer.
  it("Refresh on a mounted feed fetches a fresh snapshot with no S1/S2 mixing, even with an old request in flight", async () => {
    const { store, queryClient } = freshStoreWithClient();
    const params: PostFeedParams = { feed: "global", ranked: true };
    const key = postFeedKey(params);
    const seenInputs: ListInput[] = [];
    let resolveStalePage2!: (page: PostListPage) => void;
    let mintedSnapshots = 0;
    fakeClient.post.list.mockImplementation((input: ListInput) => {
      seenInputs.push(input);
      if (input.cursor) {
        return new Promise<PostListPage>((resolve) => {
          resolveStalePage2 = resolve;
        });
      }
      mintedSnapshots += 1;
      const snapshotId = input.snapshotId ?? `snapshot-${mintedSnapshots}`;
      const content = input.snapshotId ? "resumed" : mintedSnapshots === 1 ? "s1a" : "s2a";
      return Promise.resolve(
        makePostListPage({
          items: [makePost({ content })],
          nextCursor: mintedSnapshots === 1 && !input.snapshotId ? "c1" : null,
          ranking: makeRanking({ snapshotId, suggestions: [] }),
        }),
      );
    });

    const atom = postFeedAtom(params);
    const unsub = store.sub(atom, () => {});
    await vi.waitFor(() => {
      expect(store.get(atom).data?.pages[0]?.items[0]?.content).toBe("s1a");
    });

    // Page two of the old snapshot starts loading and stays in flight.
    void store.get(atom).fetchNextPage?.();
    await vi.waitFor(() => {
      expect(seenInputs.some((seen) => seen.cursor === "c1")).toBe(true);
    });

    // A neighbouring feed is seeded so Refresh must prove its scope: only
    // this feed's pages go, everything else stays.
    const neighbourParams: PostFeedParams = { feed: "following", ranked: true };
    const neighbourKey = postListQueryOptions(neighbourParams).queryKey;
    queryClient.setQueryData(neighbourKey, {
      pages: [makePostListPage({ items: [makePost({ content: "neighbour" })] })],
      pageParams: [undefined],
    });

    store.set(refreshRankedFeedAtomFamily(key));

    // The mounted observer restarts on the same key with no snapshot — a
    // fresh mint, never a resume.
    await vi.waitFor(() => {
      expect(store.get(atom).data?.pages[0]?.items[0]?.content).toBe("s2a");
    });
    expect(seenInputs.at(-1)?.snapshotId).toBeUndefined();
    expect(store.get(atom).data?.pages).toHaveLength(1);
    expect(
      queryClient.getQueryData<InfiniteData<PostListPage>>(neighbourKey)?.pages[0]?.items[0]
        ?.content,
    ).toBe("neighbour");

    // The stale page-two response lands after the new ranking: discarded,
    // never appended or mixed in.
    resolveStalePage2(
      makePostListPage({
        items: [makePost({ content: "s1b" })],
        nextCursor: null,
        ranking: makeRanking({ snapshotId: "snapshot-1", suggestions: [] }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get(atom).data?.pages).toHaveLength(1);
    expect(store.get(atom).data?.pages[0]?.items[0]?.content).toBe("s2a");

    unsub();
  });

  // An expired snapshot is a BAD_REQUEST the server will refuse again —
  // retrying resends the same id, so Refresh (a new snapshot) owns recovery.
  // The client forces `retry: 3` because TanStack defaults to no retries on
  // the server (this `node`-project test has no `window`), which would make
  // a missing `retry` rule pass by accident instead of by contract.
  it("does not retry an expired snapshot BAD_REQUEST", async () => {
    fakeClient.post.list.mockRejectedValue(
      new ORPCError("BAD_REQUEST", { message: RANK_SNAPSHOT_INVALID_MESSAGE }),
    );

    const store = createStore();
    store.set(
      queryClientAtom,
      new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } }),
    );
    const atom = postFeedAtom({ feed: "global", ranked: true });
    const unsub = store.sub(atom, () => {});

    await vi.waitFor(() => expect(store.get(atom).isError).toBe(true));
    expect(fakeClient.post.list).toHaveBeenCalledTimes(1);

    unsub();
  });
});

describe("homeFeedScopeAtom", () => {
  it("is null while the session is pending, regardless of what's stored", () => {
    const store = freshStore();
    store.set(feedScopeAtom, "following");
    // SAFETY: partial session fixture — only the pending flag matters here.
    store.set(sessionAtom, { data: null, isPending: true } as never);

    expect(store.get(homeFeedScopeAtom)).toBeNull();
  });

  it("is global when signed out even if 'following' is stored — the server rejects an anonymous Following request", () => {
    const store = freshStore();
    store.set(feedScopeAtom, "following");
    // SAFETY: partial session fixture — only the signed-out shape matters here.
    store.set(sessionAtom, { data: null, isPending: false } as never);

    expect(store.get(homeFeedScopeAtom)).toBe("global");
  });

  it("is the stored scope when signed in", () => {
    const store = freshStore();
    // SAFETY: partial session fixture — the scope atom reads only the viewer id.
    store.set(sessionAtom, {
      data: { user: { id: "viewer-1" } },
      isPending: false,
    } as never);

    store.set(feedScopeAtom, "following");
    expect(store.get(homeFeedScopeAtom)).toBe("following");

    store.set(feedScopeAtom, "global");
    expect(store.get(homeFeedScopeAtom)).toBe("global");
  });
});

describe("clearPostFeedFamily", () => {
  it("empties the family — the same params produce a brand new atom afterwards", () => {
    const before = postFeedAtom({ feed: "global" });
    clearPostFeedFamily();
    const after = postFeedAtom({ feed: "global" });

    expect(after).not.toBe(before);
  });
});
