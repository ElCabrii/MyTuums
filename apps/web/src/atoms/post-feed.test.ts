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
    { feed: "following", authorId: "author-1", parentId: "parent-1", includeReplies: true },
  ];

  it.each(cases)("round-trips %o", (params) => {
    expect(decode(encode(params))).toEqual(params);
  });

  // `authorId` is a database id, not a validated slug, so it could contain the
  // "|" delimiter itself. It's kept LAST in the encoding specifically so
  // `decode` can consume just the three leading delimiters and hand back
  // everything else verbatim, instead of splitting on every "|" and
  // truncating the id at the first one.
  it("round-trips an authorId that itself contains the delimiter", () => {
    const params: PostFeedParams = { feed: "global", authorId: "abc|def|ghi" };
    expect(decode(encode(params))).toEqual(params);
  });

  it("decoding a minimal key produces no authorId/parentId/includeReplies keys at all", () => {
    const decoded = decode(encode({ feed: "global" }));
    expect(Object.keys(decoded)).toEqual(["feed"]);
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
