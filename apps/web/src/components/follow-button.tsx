import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import {
  patchFollowState,
  readCachedIsFollowing,
  reconcileFollow,
  restoreFollowCaches,
  snapshotFollowCaches,
  type FollowResult,
} from "@/lib/follow-cache";
import { orpc } from "@/lib/orpc";

/**
 * The same shape as `useToggleLike` in ./post-card.tsx — scoped mutations so
 * follow and unfollow can't land out of order, an `intent` ref so a response
 * for a superseded click is dropped rather than flickered through, and a
 * snapshot/rollback around an optimistic edit.
 *
 * It differs in *which* caches it has to sweep — see `../lib/follow-cache.ts`.
 * A person's follow state is cached in three shapes at once: their profile
 * (a flat object), and any follower/following list they appear in
 * (paginated). All three are patched locally by `patchFollowState`. The
 * Following *feed* is the fourth, and the one that can't be patched — see the
 * invalidation in `onSettled` below.
 */
function useToggleFollow(userId: string, viewerId: string | undefined) {
  const queryClient = useQueryClient();
  const profilesKey = orpc.user.byUsername.key();

  // The state the *last* click asked for. Because the two mutations are
  // serialised, responses for superseded clicks still arrive — this is what
  // lets `reconcile` tell "the server confirming what the user currently
  // wants" apart from "the server confirming a click that's already been
  // undone", and drop the latter instead of flickering through it.
  const intent = useRef<boolean | null>(null);

  const reconcile = (result: FollowResult) => {
    if (intent.current !== null && result.viewerIsFollowing !== intent.current) return;
    reconcileFollow(queryClient, result);
  };

  // Following someone changes *which posts belong in the Following feed*, and
  // there is no way to synthesise their posts client-side — so unlike every
  // other cache here, this one has to be refetched. `resetQueries` rather than
  // `invalidateQueries`: the feed's membership just changed, so dropping back
  // to page one is both the correct reading and cheaper than refetching every
  // page someone has scrolled through.
  const refreshFeeds = () => {
    void queryClient.resetQueries({ queryKey: orpc.post.list.key() });
  };

  const scope = { id: `follow:${userId}` };
  const follow = useMutation({
    ...orpc.user.follow.mutationOptions({ onSuccess: reconcile, onSettled: refreshFeeds }),
    scope,
  });
  const unfollow = useMutation({
    ...orpc.user.unfollow.mutationOptions({ onSuccess: reconcile, onSettled: refreshFeeds }),
    scope,
  });

  return () => {
    // Read the current state from the cache rather than the `isFollowing`
    // prop: the prop is a render-time snapshot, so a burst of clicks would
    // all see the same starting value and resolve the same way.
    const following = !readCachedIsFollowing(queryClient, userId);
    intent.current = following;

    void queryClient.cancelQueries({ queryKey: profilesKey });
    const snapshot = snapshotFollowCaches(queryClient);

    // Applied here rather than in `onMutate`: inside this synchronous block,
    // `cancelQueries` + snapshot + patch + intent-set execute atomically —
    // there is no `await` boundary where an interleaved dispatch (another
    // click, a background refetch) could land between them and observe a
    // half-updated cache.
    patchFollowState(queryClient, { userId, viewerId, following });

    // Rollback below is a *per-call* callback (`mutate(vars, { onError })`),
    // which query-core stores on the mutation's observer and only fires when
    // `hasListeners()` is true (mutationObserver.ts ~line 164) — unlike the
    // `mutationOptions({ onSuccess, onSettled })` above, which lands on
    // `mutation.options` and always fires regardless of what's still mounted.
    // That asymmetry means a rapid follow→unfollow→follow can detach the
    // observer from an earlier click's still-pending mutation, silently
    // dropping that click's rollback. Pre-existing behaviour, not introduced
    // by this extraction.
    const mutation = following ? follow : unfollow;
    mutation.mutate(
      { userId },
      {
        onError: () => {
          restoreFollowCaches(queryClient, snapshot);
        },
      },
    );
  };
}

export function FollowButton({
  userId,
  isFollowing,
  className,
}: {
  userId: string;
  isFollowing: boolean;
  className?: string;
}) {
  const { data: session } = useSession();
  const viewerId = session?.user.id;
  const toggleFollow = useToggleFollow(userId, viewerId);

  // Following yourself is a BAD_REQUEST server-side and forbidden by a CHECK
  // constraint, so there is no state in which this button is meaningful on
  // your own row. Callers guard too; this is the backstop.
  if (viewerId === userId) return null;

  if (!session?.user) {
    // Signed out, the server would reject the follow — send people to log in
    // rather than let them click into a 401, matching the like affordance in
    // ./post-card.tsx.
    return (
      <Button
        size="sm"
        nativeButton={false}
        className={className}
        render={<Link to="/login" title="Log in to follow people" className="gap-1.5 rounded-full" />}
      >
        <UserPlus className="h-4 w-4" />
        <span>Follow</span>
      </Button>
    );
  }

  // Deliberately no pending/disabled state: the optimistic flip *is* the
  // feedback and it lands on click, while disabling for the round trip would
  // block a fast undo — exactly the interaction the mutation scope above
  // exists to make safe.
  return isFollowing ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={toggleFollow}
      aria-pressed
      aria-label="Unfollow"
      className={`group gap-1.5 rounded-full hover:border-destructive/40 hover:text-destructive ${className ?? ""}`}
    >
      {/* Pure CSS label swap — the button already has a mutation queue, and
          adding hover state to it in React invites the two disagreeing. */}
      <span className="group-hover:hidden">Following</span>
      <span className="hidden group-hover:inline">Unfollow</span>
    </Button>
  ) : (
    <Button
      type="button"
      size="sm"
      onClick={toggleFollow}
      aria-pressed={false}
      aria-label="Follow"
      className={`gap-1.5 rounded-full ${className ?? ""}`}
    >
      <UserPlus className="h-4 w-4" />
      <span>Follow</span>
    </Button>
  );
}
