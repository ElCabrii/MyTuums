import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { orpc, type Profile, type UserListPage } from "@/lib/orpc";

type CachedQueries<T> = [readonly unknown[], T | undefined][];

interface FollowResult {
  userId: string;
  followerCount: number;
  viewerIsFollowing: boolean;
}

/**
 * The same shape as `useToggleLike` in ./post-card.tsx — scoped mutations so
 * follow and unfollow can't land out of order, an `intent` ref so a response
 * for a superseded click is dropped rather than flickered through, and a
 * snapshot/rollback around an optimistic edit.
 *
 * It differs in *which* caches it has to sweep. A person's follow state is
 * cached in three shapes at once: their profile (a flat object), and any
 * follower/following list they appear in (paginated). All three are patched
 * locally. The Following *feed* is the fourth, and the one that can't be
 * patched — see the invalidation in `onSettled`.
 */
function useToggleFollow(userId: string, viewerId: string | undefined) {
  const queryClient = useQueryClient();

  const profilesKey = orpc.user.byUsername.key();
  const followersKey = orpc.user.followers.key();
  const followingKey = orpc.user.following.key();

  const intent = useRef<boolean | null>(null);

  /**
   * Current state, read from whichever cache happens to hold this person
   * rather than from a prop: a prop is a render-time snapshot, so a burst of
   * clicks would all see the same starting value and resolve the same way.
   */
  const cachedIsFollowing = (): boolean => {
    const fromProfile = queryClient
      .getQueriesData<Profile>({ queryKey: profilesKey })
      .find(([, data]) => data?.id === userId)?.[1];

    if (fromProfile) return fromProfile.viewerIsFollowing;

    const fromList = [followersKey, followingKey]
      .flatMap((key) =>
        queryClient.getQueriesData<InfiniteData<UserListPage>>({ queryKey: key }),
      )
      .flatMap(([, data]) => data?.pages ?? [])
      .flatMap((page) => page.items)
      .find((item) => item.id === userId);

    return fromList?.viewerIsFollowing ?? false;
  };

  const patchProfiles = (following: boolean) => {
    queryClient.setQueriesData<Profile>({ queryKey: profilesKey }, (cached) => {
      if (!cached) return cached;

      if (cached.id === userId) {
        return {
          ...cached,
          viewerIsFollowing: following,
          followerCount: Math.max(0, cached.followerCount + (following ? 1 : -1)),
        };
      }

      // The viewer's own profile, if it happens to be cached from an earlier
      // visit — their *following* count moved, not their follower count.
      if (viewerId && cached.id === viewerId) {
        return {
          ...cached,
          followingCount: Math.max(0, cached.followingCount + (following ? 1 : -1)),
        };
      }

      return cached;
    });
  };

  const patchLists = (following: boolean) => {
    for (const key of [followersKey, followingKey]) {
      queryClient.setQueriesData<InfiniteData<UserListPage>>({ queryKey: key }, (cached) =>
        cached
          ? {
              ...cached,
              pages: cached.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === userId ? { ...item, viewerIsFollowing: following } : item,
                ),
              })),
            }
          : cached,
      );
    }
  };

  const rollback = (
    profiles: CachedQueries<Profile>,
    lists: CachedQueries<InfiniteData<UserListPage>>,
  ) => {
    for (const [key, data] of [...profiles, ...lists]) {
      queryClient.setQueryData(key, data);
    }
  };

  // `follow`/`unfollow` return the authoritative count, so success reconciles
  // from the response instead of refetching every visible profile.
  const reconcile = (result: FollowResult) => {
    if (intent.current !== null && result.viewerIsFollowing !== intent.current) return;

    queryClient.setQueriesData<Profile>({ queryKey: profilesKey }, (cached) =>
      cached && cached.id === result.userId
        ? {
            ...cached,
            viewerIsFollowing: result.viewerIsFollowing,
            followerCount: result.followerCount,
          }
        : cached,
    );
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
    const following = !cachedIsFollowing();
    intent.current = following;

    void queryClient.cancelQueries({ queryKey: profilesKey });
    const profiles = queryClient.getQueriesData<Profile>({ queryKey: profilesKey });
    const lists = [followersKey, followingKey].flatMap((key) =>
      queryClient.getQueriesData<InfiniteData<UserListPage>>({ queryKey: key }),
    );

    // Applied here rather than in `onMutate`, which for a scoped mutation
    // doesn't run until the queue reaches it — the click has to show up
    // immediately, not one round trip later.
    patchProfiles(following);
    patchLists(following);

    const mutation = following ? follow : unfollow;
    mutation.mutate(
      { userId },
      {
        onError: () => {
          rollback(profiles, lists);
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
