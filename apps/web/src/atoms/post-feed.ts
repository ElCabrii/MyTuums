import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery } from "jotai-tanstack-query";
import { isSignedInAtom, sessionPendingAtom } from "@/atoms/session";
import { feedScopeAtom, type FeedScope } from "@/lib/feed-scope";
import {
  postListQueryOptions,
  type PostFeedParams,
  type PostListScope,
} from "@/lib/query-definitions";

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
 */
/** Encodes feed params into the family key string — layout described above. */
export const encode = (p: PostFeedParams): string => {
  const q = p.q?.trim() ? encodeURIComponent(p.q.trim()) : "";
  const gameSlug = p.gameSlug?.trim() ? encodeURIComponent(p.gameSlug.trim()) : "";
  const authorId = p.authorId ? encodeURIComponent(p.authorId) : "";
  const parentId = p.parentId ? encodeURIComponent(p.parentId ?? "") : "";
  return `${p.feed}|${encodeKind(p)}|${p.includeReposts ? "t" : ""}|${parentId}|${authorId}|${gameSlug}|${q}`;
};

function encodeKind(p: PostFeedParams): string {
  if (p.kind === "posts") return "p";
  if (p.kind === "replies") return "q";
  if (p.kind === "both") return "a";
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
  ] = key.split("|");

  const params: PostFeedParams = {
    // SAFETY: encode only ever writes one of the three literal list scopes —
    // the two home feeds and the bookmarks page.
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
  return params;
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
  atomWithInfiniteQuery(() => postListQueryOptions(decode(key))),
);

/** The infinite-query atom for one (scope, author, parent) feed — components read this, not the family. */
export const postFeedAtom = (p: PostFeedParams) => postFeedFamily(encode(p));

/**
 * Removes every entry `postFeedFamily` has ever created. The family itself
 * stays private to this module — same reasoning as keeping it un-exported in
 * the first place, just extended to cleanup: callers that want to clear it
 * shouldn't be able to reach in and `.remove()` a single key by hand, which
 * would split an in-progress "Load more" scroll-through the same way a lazy
 * `setShouldRemove` would. `clearViewerState` (`atoms/session-teardown.ts`)
 * is the only caller, and sign-out is the one moment nothing here is mounted,
 * so a full sweep is safe.
 */
export function clearPostFeedFamily(): void {
  for (const key of postFeedFamily.getParams()) postFeedFamily.remove(key);
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
