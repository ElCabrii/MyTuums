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

  // Proves the split is on the FIRST "|" only — an authorId is a database
  // id, not a validated slug, so it could contain the delimiter itself.
  // Splitting anywhere else would truncate it.
  it("round-trips an authorId containing the delimiter", () => {
    const params = { feed: "global" as const, authorId: "author|with|pipes" };
    expect(decode(encode(params))).toEqual(params);
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
    expect(global).not.toBe(following);
    expect(global).not.toBe(authored);
  });
});
