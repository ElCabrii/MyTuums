import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithInfiniteQuery, atomWithQuery } from "jotai-tanstack-query";
import { orpc, retryUnlessClientError, type SearchTypeahead } from "@/lib/orpc";
import { searchPostsQueryOptions, searchUsersQueryOptions } from "@/lib/query-definitions";

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

/** The query options shared by the header and composer mention lookups. */
export function typeaheadQueryOptions(q: string) {
  const normalized = q.trim();
  if (!normalized) {
    // Keep the disabled atom safe for small component tests and signed-out
    // chrome that do not install the full search client. Calling into oRPC to
    // build an unused query would still dereference `search.typeahead` before
    // TanStack Query has a chance to honour `enabled: false`.
    return {
      queryKey: ["search.typeahead", "disabled"],
      queryFn: (): Promise<SearchTypeahead> => Promise.resolve({ users: [], posts: [] }),
      enabled: false,
      retry: false,
    };
  }

  return {
    ...orpc.search.typeahead.queryOptions({ input: { q: normalized } }),
    enabled: normalized.length > 0,
    retry: retryUnlessClientError,
  };
}

/**
 * The header's typeahead query for its debounced input. The input is one
 * string, so this surface remains a single atom for the existing SearchBox.
 */
export const typeaheadAtom = atomWithQuery((get) =>
  typeaheadQueryOptions(get(debouncedSearchQueryAtom)),
);

/**
 * Typeahead queries keyed by a composer token. Unlike the header's atom, this
 * family lets the home and reply composers query independently without
 * sharing their draft text with the global search box.
 */
export const typeaheadQueryAtomFamily = atomFamily((q: string) =>
  atomWithQuery(() => typeaheadQueryOptions(q)),
);

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
  atomWithInfiniteQuery(() => searchUsersQueryOptions(q)),
);

/** Same shape as {@link searchUsersFamily}, over `search.posts` results. */
export const searchPostsFamily = atomFamily((q: string) =>
  atomWithInfiniteQuery(() => searchPostsQueryOptions(q)),
);

/** The infinite-query atom for one query's user results — components read this, not the family. */
export const searchUsersAtom = (q: string) => searchUsersFamily(q.trim());

/** The infinite-query atom for one query's post results — components read this, not the family. */
export const searchPostsAtom = (q: string) => searchPostsFamily(q.trim());

/**
 * Removes every entry both search families have ever created. Same reasoning
 * as `clearPostFeedFamily`: the families stay behind this narrow, all-or-
 * nothing entry point so no caller can `.remove()` a single key by hand and
 * split an in-progress "Load more". `clearViewerState`
 * (`atoms/session-teardown.ts`) is the only caller, and sign-out is the one
 * moment nothing here is mounted, so a full sweep is safe. Cached search data
 * carries viewer-relative fields
 * (`viewerIsFollowing`, `viewerHasLiked`) under viewer-less query keys, so it
 * must not survive into the next session on this browser.
 */
export function clearSearchFamilies(): void {
  for (const key of searchUsersFamily.getParams()) searchUsersFamily.remove(key);
  for (const key of searchPostsFamily.getParams()) searchPostsFamily.remove(key);
  for (const key of typeaheadQueryAtomFamily.getParams()) typeaheadQueryAtomFamily.remove(key);
}

/** Whether the typeahead dropdown is open, app-wide — at most one SearchBox exists. */
export const searchPopoverOpenAtom = atom(false);

/** The highlighted suggestion row index, or -1 for none; ArrowUp/ArrowDown move it. */
export const searchHighlightAtom = atom(-1);
