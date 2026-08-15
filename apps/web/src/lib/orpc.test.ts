import { describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/client";
import { partialMatchKey } from "@tanstack/react-query";
import { orpc, retryUnlessClientError } from "@/lib/orpc";

describe("retryUnlessClientError", () => {
  it("does not retry a 4xx ORPCError — a handle that doesn't exist won't start existing", () => {
    expect(retryUnlessClientError(0, new ORPCError("NOT_FOUND"))).toBe(false);
    expect(retryUnlessClientError(0, new ORPCError("BAD_REQUEST"))).toBe(false);
  });

  it("retries a 5xx ORPCError", () => {
    expect(retryUnlessClientError(0, new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(true);
  });

  it("retries a plain network Error", () => {
    expect(retryUnlessClientError(0, new Error("network down"))).toBe(true);
  });

  it("stops retrying once failureCount reaches 2, even for a retryable error", () => {
    expect(retryUnlessClientError(2, new Error("still down"))).toBe(false);
    expect(retryUnlessClientError(3, new Error("still down"))).toBe(false);
    expect(retryUnlessClientError(1, new Error("still down"))).toBe(true);
  });
});

/**
 * oRPC embeds the whole input object in the query key, so an "always pass
 * `feed: 'global'`" cleanup would silently fork every cache entry the
 * optimistic-like sweeps in `lib/post-cache.ts` depend on (see CONTEXT.md).
 * These pin the exact shapes the conditional spreads in `atoms/post-feed.ts`
 * and `atoms/user-list.ts` are protecting.
 */
describe("query key shapes", () => {
  it("the global feed input carries no feed key at all", () => {
    const key = orpc.post.list.key({ input: { limit: 20 } });
    const [, state] = key as [unknown, { input?: { feed?: unknown } }];
    expect(state.input).not.toHaveProperty("feed");
  });

  it("global, following, and author-scoped feeds are different keys", () => {
    const global = orpc.post.list.key({ input: { limit: 20 } });
    const following = orpc.post.list.key({ input: { limit: 20, feed: "following" } });
    const byAuthor = orpc.post.list.key({ input: { limit: 20, authorId: "author-1" } });

    expect(global).not.toEqual(following);
    expect(global).not.toEqual(byAuthor);
    expect(following).not.toEqual(byAuthor);
  });

  // The prefix relationship is what every optimistic sweep in `lib/post-cache.ts`
  // and `lib/follow-cache.ts` depends on: `getQueriesData({ queryKey: prefix })`
  // uses this exact partial-match algorithm, not a literal array `startsWith`.
  it("orpc.post.list.key() with no input is a partial-match prefix of every scoped variant", () => {
    const prefix = orpc.post.list.key();
    const global = orpc.post.list.key({ input: { limit: 20 } });
    const following = orpc.post.list.key({ input: { limit: 20, feed: "following" } });
    const byAuthor = orpc.post.list.key({ input: { limit: 20, authorId: "author-1" } });

    expect(partialMatchKey(global, prefix)).toBe(true);
    expect(partialMatchKey(following, prefix)).toBe(true);
    expect(partialMatchKey(byAuthor, prefix)).toBe(true);

    // Not reflexive by accident — a more specific key is not a prefix of a
    // less specific one.
    expect(partialMatchKey(prefix, global)).toBe(false);
  });

  it("the same relationship holds for user.followers/user.following keys", () => {
    const prefix = orpc.user.followers.key();
    const scoped = orpc.user.followers.key({ input: { username: "alice" } });
    expect(partialMatchKey(scoped, prefix)).toBe(true);
  });
});
