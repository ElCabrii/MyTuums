import type { QueryClient } from "@tanstack/react-query";

/**
 * Everything on this browser that belonged to the viewer, discarded in one
 * call.
 *
 * This module owns the *inventory*: which caches and which atom families hold
 * viewer-owned state. `signOutAtom` used to hold that list itself, which meant
 * the caller knew the whole teardown implementation and had to be edited every
 * time a viewer-owned family was added anywhere in `src/atoms`. Now adding one
 * is a one-line change here, next to the reasoning for the others.
 *
 * The coordinator is small enough to import statically; the family modules are
 * not. Their `clear*` helpers live alongside the feed/query machinery they
 * clear, so the dynamic imports inside `clearViewerState` keep that machinery
 * out of the login page's initial chunks. The QueryClient is cleared before
 * those imports start, and each family sweep is independent and best-effort,
 * so a missing lazy chunk cannot delay the privacy boundary, prevent the
 * server sign-out request that precedes it, or block the other families.
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
  for (const param of family.getParams()) family.remove(param);
}

/** Loads and clears one independent family without making sign-out wait on its chunk. */
function sweepFamily<Module>(
  name: string,
  load: () => Promise<Module>,
  clear: (loaded: Module) => void,
): void {
  void load()
    .then(clear)
    .catch((error) => {
      console.error(`Failed to clear ${name} state after sign-out`, error);
    });
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

  sweepFamily(
    "profile",
    () => import("@/atoms/profile"),
    ({ profileAtomFamily }) => {
      clearFamily(profileAtomFamily);
    },
  );
  sweepFamily(
    "post feed",
    () => import("@/atoms/post-feed"),
    ({ clearPostFeedFamily }) => {
      clearPostFeedFamily();
    },
  );
  sweepFamily(
    "user list",
    () => import("@/atoms/user-list"),
    ({ clearUserListFamily }) => {
      clearUserListFamily();
    },
  );
  sweepFamily(
    "thread",
    () => import("@/atoms/thread"),
    ({ clearThreadFamily }) => {
      clearThreadFamily();
    },
  );
  sweepFamily(
    "reply continuation",
    () => import("@/atoms/reply-continuation"),
    ({ clearReplyContinuationFamily }) => {
      clearReplyContinuationFamily();
    },
  );
  // Reply drafts are per-post and in-memory; they belong to the person who
  // typed them, not to the browser.
  sweepFamily(
    "reply",
    () => import("@/atoms/reply-composer"),
    ({ clearReplyFamilies }) => {
      clearReplyFamilies();
    },
  );
  sweepFamily(
    "post composer",
    () => import("@/atoms/composer"),
    ({ clearComposerAttachments }) => {
      clearComposerAttachments();
    },
  );
  sweepFamily(
    "like",
    () => import("@/atoms/like"),
    ({ clearLikeFamilies }) => {
      clearLikeFamilies();
    },
  );
  sweepFamily(
    "bookmark",
    () => import("@/atoms/bookmark"),
    ({ clearBookmarkFamilies }) => {
      clearBookmarkFamilies();
    },
  );
  sweepFamily(
    "follow",
    () => import("@/atoms/follow"),
    ({ clearFollowFamilies }) => {
      clearFollowFamilies();
    },
  );
  sweepFamily(
    "moderation",
    () => import("@/atoms/moderation"),
    ({ clearModerationFamilies }) => {
      clearModerationFamilies();
    },
  );
  // Results keyed on the previous session's queries shouldn't outlive it. The
  // debounced query and the popover state die with the SearchBox at unmount,
  // which the session gate triggers right after sign-out.
  sweepFamily(
    "search",
    () => import("@/atoms/search"),
    ({ clearSearchFamilies }) => {
      clearSearchFamilies();
    },
  );
  sweepFamily(
    "composer mention",
    () => import("@/atoms/composer-mentions"),
    ({ clearComposerMentionFamilies }) => {
      clearComposerMentionFamilies();
    },
  );
}
