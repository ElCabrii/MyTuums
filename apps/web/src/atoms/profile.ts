import { atomFamily } from "jotai-family";
import { atomWithQuery } from "jotai-tanstack-query";
import { orpc, retryUnlessClientError } from "@/lib/orpc";

/**
 * One query atom per handle, shared by every component that reads that
 * handle's profile. `ProfileLayout` and `ProfilePosts` both need
 * `user.byUsername`; before this they issued the query independently and
 * relied on TanStack's key-based dedup to collapse them into one request.
 * That worked, but it was incidental — two components that happen to build
 * the same query key. Reading `profileAtomFamily(username)` from both makes
 * them read the *same atom object*, so the dedup is structural: there is
 * only ever one observer for a given handle, not two observers that happen
 * to agree.
 *
 * The family takes a bare `username` string, not `{ username }`. Keep it
 * that way — a primitive param lets `atomFamily` key its internal `Map` on
 * the value directly. An object param would need an `areEqual` comparator,
 * and passing one switches the family from a `Map` lookup to a linear scan
 * over every param it has ever created, on every single read.
 *
 * Deliberately no `setShouldRemove` here. It's evaluated lazily, at read
 * time, so it can't know whether an atom is currently mounted — it can fire
 * between `ProfileLayout`'s read and `ProfilePosts`'s read of the same
 * username and hand the second one a freshly-created atom instead of the
 * first one's. That would split the very observer this family exists to
 * share, and defeat the structural dedup above for no benefit. Cleanup
 * instead happens at sign-out, where nothing is mounted to split.
 */
export const profileAtomFamily = atomFamily((username: string) =>
  atomWithQuery(() => ({
    // oRPC's `queryOptions` returns `{ queryFn, ...optionsIn, queryKey }` —
    // `retry` must be spread in after it, or that trailing spread of
    // `optionsIn` would clobber it back to oRPC's default. This is what
    // stops a 404'd handle from being retried.
    ...orpc.user.byUsername.queryOptions({ input: { username } }),
    retry: retryUnlessClientError,
  })),
);
