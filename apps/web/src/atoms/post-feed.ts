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
  /** Set to list one post's direct replies — the thread page's reply list. */
  parentId?: string;
  /** Replies are excluded unless this is set; a profile feed opts in. */
  includeReplies?: boolean;
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
 * principle contain "|". It is therefore kept LAST and `decode` consumes only
 * the three leading delimiters, treating everything after them as the id —
 * so the round trip stays total instead of silently truncating one. The three
 * fields ahead of it are all constrained (an enum, a flag, a uuid) and cannot
 * contain a delimiter.
 */
/** Encodes feed params into the family key string — layout described above. */
export const encode = (p: PostFeedParams): string =>
  `${p.feed}|${p.includeReplies ? "r" : ""}|${p.parentId ?? ""}|${p.authorId ?? ""}`;

/** Decodes a family key string back into feed params — the inverse of {@link encode}. */
export const decode = (key: string): PostFeedParams => {
  const [feed = "", replies = "", parentId = ""] = key.split("|", 3);
  // Everything past the third delimiter, however many more it contains.
  const authorId = key.slice(feed.length + replies.length + parentId.length + 3);

  return {
    feed: feed as FeedScope,
    ...(authorId ? { authorId } : {}),
    ...(parentId ? { parentId } : {}),
    ...(replies === "r" ? { includeReplies: true } : {}),
  };
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
    const { authorId, feed: scope, parentId, includeReplies } = decode(key);
    return orpc.post.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: POST_PAGE_SIZE,
        ...(authorId ? { authorId } : {}),
        // Conditional for the same reason as every other input here: oRPC
        // embeds the whole object in the query key, so unconditionally
        // sending `parentId: undefined` / `includeReplies: false` gives the
        // home timeline a different key than the one it has always used. The
        // prefix sweeps in `lib/post-cache.ts` would still match both, which
        // is the trap — nothing errors, the feed is simply cached twice and
        // the copy a patch lands on need not be the copy on screen.
        ...(parentId ? { parentId } : {}),
        ...(includeReplies ? { includeReplies } : {}),
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

/** The infinite-query atom for one (scope, author, parent) feed — components read this, not the family. */
export const postFeedAtom = (p: PostFeedParams) => postFeedFamily(encode(p));

/**
 * Removes every entry `postFeedFamily` has ever created. The family itself
 * stays private to this module — same reasoning as keeping it un-exported in
 * the first place, just extended to cleanup: callers that want to clear it
 * shouldn't be able to reach in and `.remove()` a single key by hand, which
 * would split an in-progress "Load more" scroll-through the same way a lazy
 * `setShouldRemove` would. `signOutAtom` (`atoms/auth.ts`) is the only
 * caller, and sign-out is the one moment nothing here is mounted, so a full
 * sweep is safe.
 */
export function clearPostFeedFamily(): void {
  for (const key of [...postFeedFamily.getParams()]) postFeedFamily.remove(key);
}

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
