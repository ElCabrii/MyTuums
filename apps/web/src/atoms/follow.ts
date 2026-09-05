import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { viewerIdAtom } from "@/atoms/session";
import { postListQueryOptions } from "@/lib/query-definitions";
import { store } from "@/lib/store";
import {
  beginFollowPatch,
  readCachedIsFollowing,
  reconcileFollow,
  restoreFollowCaches,
  type FollowResult,
  type FollowSnapshot,
} from "@/lib/follow-cache";
import { orpc } from "@/lib/orpc";

/** Per-person equivalent of `intentFamily` in `atoms/like.ts` — same purpose. */
const intentFamily = atomFamily<string, PrimitiveAtom<boolean | null>>(() =>
  atom<boolean | null>(null),
);

interface FollowContext {
  snapshot: FollowSnapshot;
}

interface FollowVariables {
  userId: string;
}

/**
 * The same shape as `atoms/like.ts`: scoped mutations so follow and unfollow
 * can't land out of order, a per-person intent atom so a response for a
 * superseded click is dropped, and rollback on a mutation-level `onError` fed
 * by `onMutate` context (see that file for why per-call callbacks can't be
 * used from a write-only action atom).
 *
 * It differs in *which* caches it sweeps — see `lib/follow-cache.ts`. A
 * person's follow state is cached in three shapes at once: their profile (a
 * flat object) and any follower/following list they appear in (paginated).
 * All three are patched locally. The Following *feed* is the fourth and the
 * one that can't be patched, so it is invalidated in `onSettled`.
 */
function toggleMutationAtom(userId: string, direction: "follow" | "unfollow") {
  // Explicit type parameters: inference does not flow the variables/context
  // types back out through the spread of oRPC's `mutationOptions()`.
  return atomWithMutation<FollowResult, FollowVariables, Error, FollowContext>((get) => {
    const queryClient = get(queryClientAtom);
    // Captured at factory time on purpose: this rebuilds the options when the
    // viewer changes, which is rare and correct. `scope` below deliberately
    // does NOT include it — putting viewer identity in the scope id would fork
    // the serialisation queue on sign-in.
    const viewerId = get(viewerIdAtom);
    const procedure = direction === "follow" ? orpc.user.follow : orpc.user.unfollow;
    const following = direction === "follow";

    return {
      ...procedure.mutationOptions(),

      scope: { id: `follow:${userId}` },

      onMutate: (): FollowContext => {
        // `beginFollowPatch` owns its key inventory (lib/follow-cache.ts): it
        // cancels exactly the four caches it is about to write — profile,
        // follower and following lists, and search results — before capturing
        // the snapshot and applying the patch (issue #127). Cancellation is
        // fire-and-forget; the snapshot and patch run back-to-back with no
        // await, so a refetch can't land between them to poison the rollback.
        // The rollback itself is scoped to this person (issue #53):
        // follow/unfollow of two different people are genuinely concurrent, so
        // it must not replay state the other's mutation — or confirmation —
        // has since written into the same entries.
        const snapshot = beginFollowPatch(queryClient, { userId, viewerId, following });
        return { snapshot };
      },

      onSuccess: (result: FollowResult) => {
        // Read at callback time, not via the factory's `get` — see the note in
        // `atoms/like.ts`; a dependency here would rebuild options per click.
        const intent = store.get(intentFamily(userId));
        // A private-target follow answers `{ viewerIsFollowing: false,
        // requested: true }` for a follow intent — the request IS the
        // fulfilment, so it matches `intent === true` (issue #328). Without
        // this the guard drops every private follow and `reconcileFollow`
        // never corrects the optimistic Following flip to Requested. The
        // match must stay two-sided: a stale requested response must NOT match
        // a later unfollow intent (both share `viewerIsFollowing: false`).
        const isFollowingResponse = result.viewerIsFollowing === true;
        const isRequestedResponse = result.viewerIsFollowing === false && result.requested === true;
        const isUnfollowedResponse =
          result.viewerIsFollowing === false && result.requested !== true;
        const matches =
          intent === null ||
          (intent === true && (isFollowingResponse || isRequestedResponse)) ||
          (intent === false && isUnfollowedResponse);
        if (!matches) return;
        reconcileFollow(queryClient, result);
      },

      onError: (_error: Error, _variables: FollowVariables, context: FollowContext | undefined) => {
        if (context) restoreFollowCaches(queryClient, context.snapshot);
      },

      // Following someone changes *which posts belong in the Following feed*,
      // and there is no way to synthesise their posts client-side — so unlike
      // every other cache here, this one has to be refetched. Invalidation
      // keeps its rendered rows in place while an active feed refreshes in the
      // background; resetting would recreate the skeleton flash this path is
      // meant to avoid. A failed follow never changed the membership, so the
      // error path skips the invalidation.
      onSettled: (data, error) => {
        if (error) return;
        // A request response changes no membership — the Following feed has
        // no new posts to fetch until the request is accepted (issue #328).
        if (data?.requested) return;
        // Only the Following feed derives membership from this relationship.
        // The global timeline, profile feeds and reply lists remain valid and
        // should keep their rendered rows rather than flashing to skeletons.
        void queryClient.invalidateQueries({
          queryKey: postListQueryOptions({ feed: "following" }).queryKey,
          exact: true,
        });
      },
    };
  });
}

const followFamily = atomFamily((userId: string) => toggleMutationAtom(userId, "follow"));
const unfollowFamily = atomFamily((userId: string) => toggleMutationAtom(userId, "unfollow"));

/**
 * Write-only, so `FollowButton` never subscribes to mutation status — it
 * deliberately renders no pending or disabled state, because the optimistic
 * flip is the feedback and disabling for the round trip would block a fast
 * undo.
 */
export const toggleFollowAtomFamily = atomFamily((userId: string) =>
  atom(null, (get) => {
    const queryClient = get(queryClientAtom);
    const following = !readCachedIsFollowing(queryClient, userId);
    store.set(intentFamily(userId), following);

    get(following ? followFamily(userId) : unfollowFamily(userId)).mutate({ userId });
  }),
);

/** Drops every entry these families have created. See `clearPostFeedFamily`. */
export function clearFollowFamilies(): void {
  for (const key of followFamily.getParams()) followFamily.remove(key);
  for (const key of unfollowFamily.getParams()) unfollowFamily.remove(key);
  for (const key of intentFamily.getParams()) intentFamily.remove(key);
  for (const key of toggleFollowAtomFamily.getParams()) toggleFollowAtomFamily.remove(key);
}
