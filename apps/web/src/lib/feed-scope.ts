import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export type FeedScope = "following" | "global";

const STORAGE_KEY = "my-tuums.feed-scope";

const isFeedScope = (value: unknown): value is FeedScope =>
  value === "following" || value === "global";

/**
 * The raw persisted value. Typed `unknown` on purpose: `localStorage` is
 * user-editable and outlives deploys, so nothing read back out of it is
 * trustworthy — `feedScopeAtom` below is the only sanctioned way in.
 *
 * `getOnInit` is load-bearing. Without it the atom yields the initial value on
 * the first render and the stored one only afterwards, which would mount the
 * global feed, fire a request, then flip to Following and fire a second — the
 * same double-fetch the session guard in `home-page.tsx` exists to avoid. The
 * app is a client-rendered SPA, so there is no hydration pass to mismatch.
 */
const storedFeedScopeAtom = atomWithStorage<unknown>(STORAGE_KEY, "global", undefined, {
  getOnInit: true,
});

/**
 * Which home feed the viewer picked last, remembered across visits.
 *
 * Deliberately *not* in the URL — `/` stays `/`. The trade that buys: the
 * choice sticks between visits and there is no search param to validate, at
 * the cost of a feed link nobody can share or bookmark and a Back button that
 * no longer undoes a switch.
 *
 * Reads collapse anything unrecognised to `"global"` (a hand-edited key, or a
 * value written by a future version of the app) rather than letting it reach
 * the query; writes are typed, so only the two real scopes are ever stored.
 */
export const feedScopeAtom = atom(
  (get): FeedScope => {
    const stored = get(storedFeedScopeAtom);
    return isFeedScope(stored) ? stored : "global";
  },
  (_get, set, next: FeedScope) => {
    set(storedFeedScopeAtom, next);
  },
);
