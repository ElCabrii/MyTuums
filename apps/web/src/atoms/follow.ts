import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { viewerIdAtom } from "@/atoms/session";
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
 * one that can't be patched, so it is reset in `onSettled`.
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
        // the snapshot and applying the patch, so the cancel list can't drift
        // from the write list (issue #127). Snapshot and patch run back-to-back
        // with no await, so a refetch can't land between them to poison the
        // rollback either. The rollback itself is scoped to this person (issue
        // #53): follow/unfollow of two different people are genuinely
        // concurrent, so it must not replay state the other's mutation — or
        // confirmation — has since written into the same entries.
        const snapshot = beginFollowPatch(queryClient, { userId, viewerId, following });
        return { snapshot };
      },

      onSuccess: (result: FollowResult) => {
        // Read at callback time, not via the factory's `get` — see the note in
        // `atoms/like.ts`; a dependency here would rebuild options per click.
        const intent = store.get(intentFamily(userId));
        if (intent !== null && result.viewerIsFollowing !== intent) return;
        reconcileFollow(queryClient, result);
      },

      onError: (_error: Error, _variables: FollowVariables, context: FollowContext | undefined) => {
        if (context) restoreFollowCaches(queryClient, context.snapshot);
      },

      // Following someone changes *which posts belong in the Following feed*,
      // and there is no way to synthesise their posts client-side — so unlike
      // every other cache here, this one has to be refetched. `resetQueries`
      // rather than `invalidateQueries`: the feed's membership just changed,
      // so dropping back to page one is both the correct reading and cheaper
      // than refetching every page someone has scrolled through.
      onSettled: () => {
        void queryClient.resetQueries({ queryKey: orpc.post.list.key() });
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
