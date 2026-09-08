import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery, queryClientAtom } from "jotai-tanstack-query";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { isSignedInAtom, sessionPendingAtom } from "@/atoms/session";
import { protectedProductReadyAtom, publicReadReadyAtom } from "@/atoms/query-readiness";
import { feedScopeAtom, type FeedScope } from "@/lib/feed-scope";
import {
  isRankableFeedParams,
  postListQueryOptions,
  type PostFeedParams,
  type PostListScope,
} from "@/lib/query-definitions";
import { getPageRanking } from "@/lib/ranking";
import type { PostListPage } from "@/lib/orpc";

export type { PostFeedParams } from "@/lib/query-definitions";

/**
 * `atomFamily` keys off this string rather than the params object — same
 * reasoning as `profileAtomFamily` in `atoms/profile.ts`: an object param
 * would force an `areEqual` comparator, which degrades the family's internal
 * `Map` lookup to a linear scan over every param it has ever created, on
 * every single read. A 50-card feed re-rendering against 300 accumulated
 * feed/author combinations is 15,000 comparator calls per render instead of
 * one hash lookup.
 *
 * Free-text fields ride `encodeURIComponent` so a `|` inside a Discover query
 * or an id never splits the key: the four leading fields are constrained
 * (an enum, two mode flags, a uuid) and the trailing three are encoded, so
 * `decode` can split on every delimiter and decode each part back verbatim.
 * `q` stays LAST — it is the only unbounded field — and `gameSlug` ahead of
 * it is slug-charset by construction but encoded anyway, so the layout never
 * depends on that assumption.
 *
 * Ranked feeds (issue #305) append an eighth `|k` segment. Unranked keys keep
 * the exact seven-segment layout they always had — the `Both` pin below
 * guards it — so every existing cache entry, fixture key and optimistic
 * sweep keeps matching. `decode` accepts both shapes.
 */
/** Encodes feed params into the family key string — layout described above. */
export const encode = (p: PostFeedParams): string => {
  const q = p.q?.trim() ? encodeURIComponent(p.q.trim()) : "";
  const gameSlug = p.gameSlug?.trim() ? encodeURIComponent(p.gameSlug.trim()) : "";
  const authorId = p.authorId ? encodeURIComponent(p.authorId) : "";
  const parentId = p.parentId ? encodeURIComponent(p.parentId ?? "") : "";
  const base = `${p.feed}|${encodeKind(p)}|${p.includeReposts ? "t" : ""}|${parentId}|${authorId}|${gameSlug}|${q}`;
  return isRankableFeedParams(p) ? `${base}|k` : base;
};

function encodeKind(p: PostFeedParams): string {
  if (p.kind === "posts") return "p";
  if (p.kind === "replies") return "q";
  if (p.kind === "both") return "a";
  if (p.kind === "shares") return "s";
  return p.includeReplies ? "r" : "";
}

/** Decodes a family key string back into feed params — the inverse of {@link encode}. */
export const decode = (key: string): PostFeedParams => {
  const [
    feed = "",
    replies = "",
    reposts = "",
    parentId = "",
    authorId = "",
    gameSlug = "",
    q = "",
    ranked = "",
  ] = key.split("|");

  const params: PostFeedParams = {
    // SAFETY: encode only ever writes one of the four literal list scopes —
    // the two home feeds, Discover, and the bookmarks page.
    feed: feed as PostListScope,
  };
  const decodedAuthor = authorId ? decodeURIComponent(authorId) : "";
  const decodedParent = parentId ? decodeURIComponent(parentId) : "";
  const decodedGame = gameSlug ? decodeURIComponent(gameSlug) : "";
  const decodedQ = q ? decodeURIComponent(q) : "";
  if (decodedAuthor) params.authorId = decodedAuthor;
  if (decodedParent) params.parentId = decodedParent;
  if (decodedGame) params.gameSlug = decodedGame;
  if (decodedQ) params.q = decodedQ;
  if (replies === "r") params.includeReplies = true;
  if (reposts === "t") params.includeReposts = true;
  if (replies === "p") params.kind = "posts";
  if (replies === "q") params.kind = "replies";
  if (replies === "a") params.kind = "both";
  if (replies === "s") params.kind = "shares";
  if (ranked === "k") params.ranked = true;
  return params;
};

/**
 * The browsing snapshot a ranked feed's cached first page pinned (issue
 * #305). Read at fetch time — never subscribed — so pinning never rebuilds
 * the options or forks the query key: focus and mutation invalidations keep
 * their rendered rows while the refetch resumes the same order in the
 * background. Once Refresh clears the pages there is no first page to read,
 * so the next fetch mints a fresh snapshot.
 */
function cachedSnapshotId(
  queryClient: QueryClient,
  stableKey: readonly unknown[],
): string | undefined {
  const cached = queryClient.getQueryData<InfiniteData<PostListPage>>(stableKey);
  const first = cached?.pages[0];
  return first ? getPageRanking(first)?.snapshotId : undefined;
}

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
 *
 * Ranked feeds resume their snapshot through the live reader above: the
 * input builder sends the cached first page's snapshot on every fetch
 * (first page and cursor pages alike — the cursor carries the same id, and
 * the server refuses a mismatch rather than silently re-ranking), while the
 * query key stays snapshot-free so the optimistic sweeps keep matching on
 * their exact prefixes. Deliberately no `staleTime`: live counts and
 * visibility arrive through the same focus and mutation refetches every
 * other surface lives by, and each of those re-reads the pinned snapshot
 * instead of minting a new order.
 */
const postFeedFamily = atomFamily((key: string) =>
  atomWithInfiniteQuery((get) => {
    const params = decode(key);
    // Public threads use the reply mode of this otherwise protected feed.
    // Reply scopes are already normalized to unranked by postFeedAtom.
    const anonymousReplyList = Boolean(params.parentId) && params.feed !== "bookmarks";
    const ready = anonymousReplyList ? get(publicReadReadyAtom) : get(protectedProductReadyAtom);
    if (!isRankableFeedParams(params)) return { ...postListQueryOptions(params), enabled: ready };
    const queryClient = get(queryClientAtom);
    const stableKey = postListQueryOptions(params).queryKey;
    const aware = postListQueryOptions(params, {
      getSnapshotId: () => cachedSnapshotId(queryClient, stableKey),
    });
    return { ...aware, queryKey: stableKey, enabled: ready };
  }),
);

/**
 * The infinite-query atom for one (scope, author, parent) feed — components read this, not the family.
 *
 * `feed: "discover"` always ranks (it is the ranked out-of-network surface,
 * never a chronological one), and any `ranked` flag beside author, reply,
 * repost or activity scoping is dropped: the contract ranks only the three
 * top-level scopes, so keeping the flag in the key would fork a second cache
 * entry that fetches the same chronological data.
 */
export const postFeedAtom = (p: PostFeedParams) => {
  const params: PostFeedParams =
    p.feed === "discover"
      ? { ...p, ranked: true }
      : isRankableFeedParams(p)
        ? p
        : { ...p, ranked: undefined };
  return postFeedFamily(encode(params));
};

/** The family key behind one feed's atom — what Refresh reads without forking an observer. */
export const postFeedKey = (p: PostFeedParams): string => {
  const params: PostFeedParams =
    p.feed === "discover"
      ? { ...p, ranked: true }
      : isRankableFeedParams(p)
        ? p
        : { ...p, ranked: undefined };
  return encode(params);
};

/**
 * Starts a new ranking for one feed key (issue #305): `resetQueries` drops
 * the query to its initial state and refetches while mounted, so the next
 * fetch mints a fresh snapshot. Scoped by the feed's stable query key:
 * every other feed, and every non-feed cache, is untouched.
 *
 * `resetQueries` rather than `removeQueries` on purpose, verified against
 * the query-core source (`@tanstack/query-core@5`): `remove` destroys the
 * query but never detaches the mounted observer, so nothing refetches until
 * some unrelated rerender rebuilds the options. `reset` destroys too —
 * which silently cancels the in-flight fetch (the retryer discards its late
 * resolution, and oRPC forwards the abort signal) so an old snapshot's
 * pages can never mix into the new order — then `refetchQueries(active)`
 * restarts the still-mounted observer on the same key. The intentional
 * skeleton between reset and first page is the explicit-refresh affordance,
 * not a flash to avoid.
 */
export const refreshRankedFeedAtomFamily = atomFamily((key: string) =>
  atom(null, (get) => {
    const queryClient = get(queryClientAtom);
    void queryClient.resetQueries({
      queryKey: postListQueryOptions(decode(key)).queryKey,
      exact: true,
    });
  }),
);

/**
 * Removes every entry `postFeedFamily` has ever created. The family itself
 * stays private to this module — same reasoning as keeping it un-exported in
 * the first place, just extended to cleanup: callers that want to clear it
 * shouldn't be able to reach in and `.remove()` a single key by hand, which
 * would split an in-progress "Load more" scroll-through the same way a lazy
 * `setShouldRemove` would. `clearViewerState` (`atoms/session-teardown.ts`)
 * is the only caller, and sign-out is the one moment nothing here is mounted,
 * so a full sweep is safe. The pinned snapshots need no separate sweep: they
 * live in the cached first pages `queryClient.clear()` already drops.
 */
export function clearPostFeedFamily(): void {
  for (const key of postFeedFamily.getParams()) postFeedFamily.remove(key);
  for (const key of refreshRankedFeedAtomFamily.getParams())
    refreshRankedFeedAtomFamily.remove(key);
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
