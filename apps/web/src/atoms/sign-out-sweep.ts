import type { QueryClient } from "@tanstack/react-query";
import { profileAtomFamily } from "@/atoms/profile";
import { clearPostFeedFamily } from "@/atoms/post-feed";
import { clearUserListFamily } from "@/atoms/user-list";
import { clearSearchFamilies } from "@/atoms/search";
import { clearLikeFamilies } from "@/atoms/like";
import { clearFollowFamilies } from "@/atoms/follow";
import { clearThreadFamily } from "@/atoms/thread";
import { clearReplyFamilies } from "@/atoms/reply-composer";
import { clearModerationFamilies } from "@/atoms/moderation";

/**
 * The session teardown `signOutAtom` runs, gathered in one module.
 *
 * This used to be a barrel — a shallow re-export of the `clear*` helpers and
 * `profileAtomFamily` — and `signOutAtom` imported nine names from it and
 * orchestrated their order itself. That made the caller the owner of the
 * teardown implementation: it had to know every family that exists, and it
 * had to change whenever a viewer-owned atom family was added. This module
 * now owns that inventory behind one narrow entry point, `clearViewerState`,
 * so a caller just says "clear the viewer's state" and the teardown decides
 * what that means.
 *
 * What it exists for is still chunking: the helpers live alongside the query
 * and mutation machinery they clear (postFeedAtom, the like/follow intent
 * atoms, the thread family), so importing them statically — as `atoms/auth.ts`
 * used to — dragged all of that machinery into the auth module's graph, and
 * from there into the login page's chunks, for the sake of an action only a
 * signed-in user can trigger.
 *
 * Sign-out is also the one moment nothing in the app is mounted against those
 * families, which is what makes sweeping them safe (see `signOutAtom`). It is
 * therefore fetched on demand: `signOutAtom` awaits a dynamic import of this
 * module, and a visitor who never signs out never pays for it.
 */

/** Sweeps every family's `remove()` across all params it has ever created. */
function clearFamily<Param>(family: {
  getParams(): Iterable<Param>;
  remove(p: Param): void;
}): void {
  for (const param of [...family.getParams()]) family.remove(param);
}

/**
 * Clears every piece of viewer-owned client state: the QueryClient and every
 * atom family that carries viewer-relative data.
 *
 * The QueryClient is cleared first — cached rows carry viewer-relative fields
 * (`viewerHasLiked`, `viewerIsFollowing`) under viewer-less keys, so without
 * clearing them here the next visitor on this browser would keep seeing the
 * previous session's follow/like state until each query happened to refetch on
 * its own. The family Maps are then swept so stale atom instances (and stale
 * mutation results) don't outlive the session either.
 *
 * `queryClient` is passed in rather than read from the store so this module
 * stays decoupled from `@/lib/store`; `signOutAtom` hands it
 * `get(queryClientAtom)`.
 */
export function clearViewerState(queryClient: QueryClient): void {
  queryClient.clear();
  clearFamily(profileAtomFamily);
  clearPostFeedFamily();
  clearUserListFamily();
  clearThreadFamily();
  // Reply drafts are per-post and in-memory; they belong to the person who
  // typed them, not to the browser.
  clearReplyFamilies();
  // The like/follow families hold per-entity intent as well as mutation
  // atoms, and intent is viewer-relative — a stale `true` would make the
  // next viewer's first response look superseded and be dropped.
  clearLikeFamilies();
  clearFollowFamilies();
  // Moderation families hold per-case query atoms and the dialogs' form
  // atoms; the data was already wiped by `queryClient.clear()` above, but
  // the family Maps would keep stale atom instances (and stale mutation
  // results) per case ref for the next session.
  clearModerationFamilies();
  // Search families are swept like every other family — results keyed on
  // the previous session's queries shouldn't outlive it. (The debounced
  // query and popover state die with the SearchBox at unmount, which the
  // session gate triggers right after this runs.)
  clearSearchFamilies();
}
