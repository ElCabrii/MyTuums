import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import type { useSession } from "@/lib/auth-client";
import { isSignedInAtom, sessionAtom } from "@/atoms/session";
import { feedScopeAtom } from "@/lib/feed-scope";
import { decode, encode, homeFeedScopeAtom, postFeedAtom } from "@/atoms/post-feed";

// Session fixtures matching the shape asserted in atoms/session.test.ts —
// kept minimal here (cast rather than fully populated) since only
// `.data`/`.isPending` feed into homeFeedScopeAtom, via
// sessionPendingAtom/isSignedInAtom.
type Session = ReturnType<typeof useSession>;

const PENDING: Session = {
  data: null,
  error: null,
  isPending: true,
  isRefetching: false,
  refetch: async () => {},
};

const SIGNED_OUT: Session = {
  data: null,
  error: null,
  isPending: false,
  isRefetching: false,
  refetch: async () => {},
};

const SIGNED_IN = {
  data: { session: {}, user: { id: "viewer-1" } },
  error: null,
  isPending: false,
  isRefetching: false,
  refetch: async () => {},
} as unknown as Session;

describe("encode/decode", () => {
  it("round-trips a global feed with no author", () => {
    const params = { feed: "global" as const };
    expect(decode(encode(params))).toEqual(params);
  });

  it("round-trips a following feed with no author", () => {
    const params = { feed: "following" as const };
    expect(decode(encode(params))).toEqual(params);
  });

  it("round-trips an authorId", () => {
    const params = { feed: "global" as const, authorId: "author-1" };
    expect(decode(encode(params))).toEqual(params);
  });

  it("round-trips a parentId", () => {
    const params = { feed: "global" as const, parentId: "11111111-2222-3333-4444-555555555555" };
    expect(decode(encode(params))).toEqual(params);
  });

  it("round-trips includeReplies", () => {
    const params = { feed: "global" as const, authorId: "author-1", includeReplies: true };
    expect(decode(encode(params))).toEqual(params);
  });

  it("round-trips every field at once", () => {
    const params = {
      feed: "following" as const,
      authorId: "author-1",
      parentId: "11111111-2222-3333-4444-555555555555",
      includeReplies: true,
    };
    expect(decode(encode(params))).toEqual(params);
  });

  // Proves `authorId` is read as everything past the third "|" — it is a
  // database id, not a validated slug, so it could contain the delimiter
  // itself, and splitting on every occurrence would truncate it. The three
  // fields encoded ahead of it are all constrained and cannot.
  it("round-trips an authorId containing the delimiter", () => {
    const params = { feed: "global" as const, authorId: "author|with|pipes" };
    expect(decode(encode(params))).toEqual(params);
  });

  it("round-trips an authorId containing the delimiter alongside every other field", () => {
    const params = {
      feed: "following" as const,
      authorId: "author|with|pipes",
      parentId: "11111111-2222-3333-4444-555555555555",
      includeReplies: true,
    };
    expect(decode(encode(params))).toEqual(params);
  });

  it("keeps distinct params on distinct keys", () => {
    // `includeReplies` and `parentId` occupy their own segments, so a value
    // in one can never be read as the other — the failure mode if they were
    // packed into a single optional segment.
    expect(encode({ feed: "global", parentId: "p" })).not.toBe(
      encode({ feed: "global", includeReplies: true }),
    );
    expect(encode({ feed: "global", authorId: "a" })).not.toBe(
      encode({ feed: "global", parentId: "a" }),
    );
  });
});

describe("homeFeedScopeAtom", () => {
  it("is null while the session is pending", () => {
    const store = createStore();
    store.set(sessionAtom, PENDING);
    store.set(feedScopeAtom, "following");
    expect(store.get(homeFeedScopeAtom)).toBeNull();
  });

  it("is global when signed out, even if the stored scope is following", () => {
    const store = createStore();
    store.set(sessionAtom, SIGNED_OUT);
    store.set(feedScopeAtom, "following");
    expect(store.get(isSignedInAtom)).toBe(false);
    expect(store.get(homeFeedScopeAtom)).toBe("global");
  });

  it("follows the stored scope when signed in", () => {
    const store = createStore();
    store.set(sessionAtom, SIGNED_IN);
    store.set(feedScopeAtom, "following");
    expect(store.get(homeFeedScopeAtom)).toBe("following");

    store.set(feedScopeAtom, "global");
    expect(store.get(homeFeedScopeAtom)).toBe("global");
  });
});

describe("postFeedAtom", () => {
  it("returns the same atom instance for equal params", () => {
    const a = postFeedAtom({ feed: "global", authorId: "author-1" });
    const b = postFeedAtom({ feed: "global", authorId: "author-1" });
    expect(a).toBe(b);
  });

  it("returns a different atom instance for different params", () => {
    const global = postFeedAtom({ feed: "global" });
    const following = postFeedAtom({ feed: "following" });
    const authored = postFeedAtom({ feed: "global", authorId: "author-1" });
    const replies = postFeedAtom({ feed: "global", parentId: "parent-1" });
    expect(global).not.toBe(following);
    expect(global).not.toBe(authored);
    expect(global).not.toBe(replies);
  });

  it("shares one atom between the two reads of a reply list", () => {
    // The thread page's PostFeed and anything else reading the same parent
    // must land on the same family entry, or they split the observer the
    // family exists to share.
    expect(postFeedAtom({ feed: "global", parentId: "parent-1" })).toBe(
      postFeedAtom({ feed: "global", parentId: "parent-1" }),
    );
  });
});

describe("query input shape", () => {
  // The atom spreads exactly the decoded fields into `post.list`'s input, and
  // oRPC embeds that whole object in the query key. A plain global feed must
  // therefore decode to *only* `{ feed }` — if a future "cleanup" drops the
  // conditional spreads and always sends `parentId: undefined` /
  // `includeReplies: false`, the home timeline moves to a different key than
  // the one it has always used, and the cache entry the optimistic like
  // patches is no longer the entry the component reads.
  it("decodes a plain global feed to no extra keys", () => {
    expect(Object.keys(decode(encode({ feed: "global" })))).toEqual(["feed"]);
  });

  it("decodes a profile feed to feed + authorId + includeReplies only", () => {
    const keys = Object.keys(
      decode(encode({ feed: "global", authorId: "author-1", includeReplies: true })),
    ).sort();
    expect(keys).toEqual(["authorId", "feed", "includeReplies"]);
  });

  it("decodes a reply list to feed + parentId only", () => {
    const keys = Object.keys(decode(encode({ feed: "global", parentId: "parent-1" }))).sort();
    expect(keys).toEqual(["feed", "parentId"]);
  });
});
