import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import {
  clearPostFeedFamily,
  decode,
  encode,
  homeFeedScopeAtom,
  postFeedAtom,
} from "@/atoms/post-feed";
import { sessionAtom } from "@/atoms/session";
import { feedScopeAtom } from "@/lib/feed-scope";
import type { PostFeedParams } from "@/atoms/post-feed";

function freshStore() {
  const store = createStore();
  store.set(queryClientAtom, new QueryClient());
  return store;
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
