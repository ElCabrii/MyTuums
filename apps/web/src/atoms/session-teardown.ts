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
 * Everything on this browser that belonged to the viewer, discarded in one
 * call.
 *
 * This module owns the *inventory*: which caches and which atom families hold
 * viewer-owned state, and in what order they go. `signOutAtom` used to hold
 * that list itself, which meant the caller knew the whole teardown
 * implementation and had to be edited every time a viewer-owned family was
 * added anywhere in `src/atoms`. Now adding one is a one-line change here,
 * next to the reasoning for the others.
 *
 * Fetched on demand, and that is load-bearing. The `clear*` helpers live
 * alongside the query and mutation machinery they clear (`postFeedAtom`, the
 * like/follow intent atoms, the thread family, the moderation dialogs), so
 * importing this module statically from `atoms/auth.ts` would drag ~60 KB of
 * that machinery into the login page's chunks — for an action only a
 * signed-in user can trigger. `signOutAtom` therefore awaits a dynamic
 * `import()` of this module, and a visitor who never signs out never pays for
 * it. Keep every import of this module dynamic.
 *
 * What is *not* here: the auth-local flags `signOutAtom` resets
 * (`authErrorAtom`, `twoFactorMethodsAtom`, the two-factor offer). Those are
 * sign-in flow state rather than viewer-owned cache, and two of the three are
 * defined in `atoms/auth.ts` itself — reaching back for them would make this
 * module and its only caller import each other.
 */

/** Sweeps a family's `remove()` across every param it has ever created. */
function clearFamily<Param>(family: {
  getParams(): Iterable<Param>;
  remove(p: Param): void;
}): void {
  for (const param of [...family.getParams()]) family.remove(param);
}

/**
 * Discards every trace of the signed-out viewer: the whole query cache, and
 * every atom family keyed on data they could see.
 *
 * The query cache goes wholesale because cached rows carry viewer-relative
 * fields (`viewerHasLiked`, `viewerIsFollowing`) behind query keys that carry
 * no viewer identity — the next person on this browser would otherwise keep
 * seeing the previous session's follow and like state until each query
 * happened to refetch on its own.
 *
 * The families go because clearing the cache does not empty them: they would
 * keep one stale atom instance per handle, post id, feed key and case ref for
 * the next session, and the like/follow ones additionally hold per-entity
 * *intent*, which is viewer-relative — a stale `true` would make the next
 * viewer's first response look superseded and be dropped.
 *
 * Callers must run this only when nothing is mounted against those families,
 * which sign-out satisfies: it is the one moment the app renders nothing that
 * reads them, so a full sweep cannot hand two live readers of the same param
 * two different atoms. That is exactly the split the families avoid by
 * refusing `setShouldRemove` (see `profileAtomFamily`), and it is why the
 * sweep is safe here and nowhere else.
 *
 * The `QueryClient` is a parameter rather than a module import so the caller's
 * client — the one hydrated into the Jotai store — is unambiguously the one
 * that gets cleared.
 */
export function clearViewerState(queryClient: QueryClient): void {
  queryClient.clear();

  clearFamily(profileAtomFamily);
  clearPostFeedFamily();
  clearThreadFamily();
  clearUserListFamily();
  // Reply drafts are per-post and in-memory; they belong to the person who
  // typed them, not to the browser.
  clearReplyFamilies();
  clearLikeFamilies();
  clearFollowFamilies();
  // Results keyed on the previous session's queries shouldn't outlive it. The
  // debounced query and the popover state die with the SearchBox at unmount,
  // which the session gate triggers right after sign-out.
  clearSearchFamilies();
  clearModerationFamilies();
}
