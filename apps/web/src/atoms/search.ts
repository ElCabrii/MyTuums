import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery, atomWithQuery } from "jotai-tanstack-query";
import { SEARCH_PAGE_SIZE } from "@my-tuums/api/constants";
import { orpc, retryUnlessClientError } from "@/lib/orpc";

/** How long a keystroke may sit before its query fires, in milliseconds. */
export const debounceMs = 300;

/** The value shown in the SearchBox input — written on every keystroke. */
export const searchInputAtom = atom("");

/** The value queries actually run against — lags {@link searchInputAtom} by {@link debounceMs}. */
export const debouncedSearchQueryAtom = atom("");

// Module-scoped rather than store-scoped, and safe because exactly one
// SearchBox exists (it lives in the header), so there is at most one pending
// debounce in the app at any time. If a second SearchBox were ever mounted,
// the two would fight over this single timer — the same reasoning that keeps
// `searchInputAtom` itself a module-scoped atom instead of a per-instance
// useState.
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * The one entry point for typing into search. Writes the input box
 * immediately; the debounced copy — and with it every query atom — updates
 * only once the input has been still for {@link debounceMs}.
 */
export const setSearchQueryAtom = atom(null, (_get, set, q: string) => {
  set(searchInputAtom, q);
  // The API trims its validated query before searching. Canonicalising here
  // keeps whitespace-only input disabled (rather than sending a request the
  // server must reject) and makes equivalent queries share one cache key.
  const normalized = q.trim();
  // A later keystroke cancels the earlier one's timer, so a burst of typing
  // issues exactly one query, for the final value.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => set(debouncedSearchQueryAtom, normalized), debounceMs);
});

/** Clears the pending debounce and both search values — SearchBox unmount and the sign-out sweep. */
export const resetSearchAtomsAtom = atom(null, (_get, set) => {
  clearTimeout(debounceTimer);
  set(searchInputAtom, "");
  set(debouncedSearchQueryAtom, "");
});

/**
 * The typeahead query for the current debounced input.
 *
 * A single atom, not a family: the input is one string, so there is nothing
 * to key a family on — `atomWithQuery` re-runs and rebuilds the query key
 * whenever the debounced value changes on its own.
 *
 * `enabled` gates the empty query rather than letting it hit the server: the
 * procedure rejects an empty `q` with BAD_REQUEST, and the box is empty on
 * first render. `retry` is spread after `queryOptions` for the same reason as
 * `profileAtomFamily` — oRPC's trailing spread of `optionsIn` would otherwise
 * clobber it back to its default.
 */
export const typeaheadAtom = atomWithQuery((get) => {
  const q = get(debouncedSearchQueryAtom);
  return {
    ...orpc.search.typeahead.queryOptions({ input: { q } }),
    enabled: q.trim().length > 0,
    retry: retryUnlessClientError,
  };
});

/**
 * One infinite-query atom per search query string, shared by every component
 * reading that query — the same structural-dedup reasoning as
 * `profileAtomFamily`.
 *
 * The key is the bare query string: a single primitive with no structure to
 * pack, so no delimiter encoding like `postFeedFamily`'s `encode` is needed —
 * `atomFamily` keys its internal `Map` on the value directly, and a raw
 * keystroke can't be mistyped the way an encoded composite key can.
 *
 * Deliberately no `setShouldRemove`, matching the other families: it is
 * evaluated lazily at read time and could hand two reads of identical params
 * two different atoms, discarding an in-progress "Load more" scroll-through.
 * Cleanup happens at sign-out instead (`clearSearchFamilies`), where nothing
 * is mounted to split.
 */
export const searchUsersFamily = atomFamily((q: string) =>
  atomWithInfiniteQuery(() => ({
    ...orpc.search.users.infiniteOptions({
      // Conditional spread for `cursor` only, like every other paginated
      // input in this codebase: oRPC embeds the whole input object in the
      // query key, so an absent cursor must stay absent — a `cursor: undefined`
      // on the first page would fork every entry and "Load more" pages would
      // never join it.
      input: (cursor: string | undefined) => ({
        q: q.trim(),
        limit: SEARCH_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    // Same gate as `typeaheadAtom`: an empty query is rejected by the
    // procedure, so the query must not fire until the first keystroke lands.
    enabled: q.trim().length > 0,
  })),
);

/** Same shape as {@link searchUsersFamily}, over `search.posts` results. */
export const searchPostsFamily = atomFamily((q: string) =>
  atomWithInfiniteQuery(() => ({
    ...orpc.search.posts.infiniteOptions({
      input: (cursor: string | undefined) => ({
        q: q.trim(),
        limit: SEARCH_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
    enabled: q.trim().length > 0,
  })),
);

/** The infinite-query atom for one query's user results — components read this, not the family. */
export const searchUsersAtom = (q: string) => searchUsersFamily(q.trim());

/** The infinite-query atom for one query's post results — components read this, not the family. */
export const searchPostsAtom = (q: string) => searchPostsFamily(q.trim());

/**
 * Removes every entry both search families have ever created. Same reasoning
 * as `clearPostFeedFamily`: the families stay behind this narrow, all-or-
 * nothing entry point so no caller can `.remove()` a single key by hand and
 * split an in-progress "Load more". `signOutAtom` (`atoms/auth.ts`) is the
 * only caller, and sign-out is the one moment nothing here is mounted, so a
 * full sweep is safe. Cached search data carries viewer-relative fields
 * (`viewerIsFollowing`, `viewerHasLiked`) under viewer-less query keys, so it
 * must not survive into the next session on this browser.
 */
export function clearSearchFamilies(): void {
  for (const key of [...searchUsersFamily.getParams()]) searchUsersFamily.remove(key);
  for (const key of [...searchPostsFamily.getParams()]) searchPostsFamily.remove(key);
}

/** Whether the typeahead dropdown is open, app-wide — at most one SearchBox exists. */
export const searchPopoverOpenAtom = atom(false);

/** The highlighted suggestion row index, or -1 for none; ArrowUp/ArrowDown move it. */
export const searchHighlightAtom = atom(-1);
