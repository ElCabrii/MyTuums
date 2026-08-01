import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery } from "jotai-tanstack-query";
import { POST_PAGE_SIZE } from "@my-tuums/api/constants";
import { isSignedInAtom, sessionPendingAtom } from "@/atoms/session";
import { feedScopeAtom, type FeedScope } from "@/lib/feed-scope";
import { orpc } from "@/lib/orpc";

export type PostFeedParams = {
  /** Omit for the global timeline; set to scope the feed to one author. */
  authorId?: string;
  /** "following" requires a signed-in viewer; the server rejects it otherwise. */
  feed: FeedScope;
};

/**
 * `atomFamily` keys off this string rather than the params object — same
 * reasoning as `profileAtomFamily` in `atoms/profile.ts`: an object param
 * would force an `areEqual` comparator, which degrades the family's internal
 * `Map` lookup to a linear scan over every param it has ever created, on
 * every single read. A 50-card feed re-rendering against 300 accumulated
 * feed/author combinations is 15,000 comparator calls per render instead of
 * one hash lookup.
 *
 * `authorId` is a database id, not a validated slug, so it could in
 * principle contain "|" — `decode` below splits on the FIRST delimiter only
 * so the round trip stays total instead of silently truncating one.
 */
export const encode = (p: PostFeedParams): string => `${p.feed}|${p.authorId ?? ""}`;

export const decode = (key: string): PostFeedParams => {
  const separator = key.indexOf("|");
  const feed = key.slice(0, separator) as FeedScope;
  const authorId = key.slice(separator + 1);
  return authorId ? { feed, authorId } : { feed };
};

/**
 * One infinite-query atom per (feed scope, author) pair, shared by every
 * component that reads that pair — the same structural-dedup reasoning as
 * `profileAtomFamily`: two components building the same query key used to
 * rely on TanStack's incidental dedup, whereas reading the same family entry
 * makes them share one observer structurally.
 *
 * Deliberately no `setShouldRemove`, for the same reason as
 * `profileAtomFamily`: it's evaluated lazily at read time, so it can hand
 * two components reading identical params two different atoms mid-route,
 * splitting an in-progress "Load more" scroll-through. Cleanup happens at
 * sign-out instead, where nothing is mounted to split.
 */
const postFeedFamily = atomFamily((key: string) =>
  atomWithInfiniteQuery(() => {
    const { authorId, feed: scope } = decode(key);
    return orpc.post.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: POST_PAGE_SIZE,
        ...(authorId ? { authorId } : {}),
        // Conditional spread, like `authorId` above: keeps `feed` out of the
        // query key for the global timeline, so the cache entries the
        // `orpc.post.list.key()` prefix sweeps in `lib/post-cache.ts` depend
        // on for optimistic likes are unchanged, and the server's own
        // `.default("global")` stays the single source of that default. Do
        // not "clean up" by always passing `feed: scope` — oRPC embeds the
        // whole input object in the query key, so that would fork every
        // cache entry silently.
        ...(scope === "following" ? { feed: scope } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    });
  }),
);

export const postFeedAtom = (p: PostFeedParams) => postFeedFamily(encode(p));

/**
 * Which scope the *home* feed should render, folding in two pieces of
 * reasoning that used to live directly in `home-page.tsx`:
 *
 * - `null` while the session is pending. `sessionAtom` starts pending with
 *   `data: null`, so resolving a scope immediately would mount the global
 *   feed, fire a request, then flip to Following a tick later and fire a
 *   second. `home-page.tsx` renders the same loading spinner it always did
 *   for this case — the guard just lives here now instead of in the
 *   component.
 * - Signed-out visitors always get "global", regardless of what's stored.
 *   The server rejects an anonymous Following request, so honouring a
 *   stored "following" here would render an error card instead of a usable
 *   page. The stored choice is overridden, not cleared, so it comes back
 *   once the visitor signs in.
 */
export const homeFeedScopeAtom = atom<FeedScope | null>((get) => {
  if (get(sessionPendingAtom)) return null;
  return get(isSignedInAtom) ? get(feedScopeAtom) : "global";
});
