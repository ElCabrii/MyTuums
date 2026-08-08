import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc, type Profile, type SearchUsersPage, type UserListPage } from "@/lib/orpc";

/** What `follow`/`unfollow` return: the person's id and the authoritative follow state. */
export interface FollowResult {
  userId: string;
  followerCount: number;
  viewerIsFollowing: boolean;
}

/**
 * A person's follow state is cached in four shapes at once: their profile
 * (a flat object), any follower/following list they appear in (paginated),
 * and any `search.users` result row (paginated — the search page renders a
 * live follow button off it). This reads whichever cache happens to hold them
 * rather than from a prop: a prop is a render-time snapshot, so a burst of
 * clicks would all see the same starting value and resolve the same way.
 */
export function readCachedIsFollowing(queryClient: QueryClient, userId: string): boolean {
  const fromProfile = cachedProfile(queryClient, userId);
  if (fromProfile) return fromProfile.viewerIsFollowing;

  const fromList = [orpc.user.followers.key(), orpc.user.following.key()]
    .flatMap((key) => queryClient.getQueriesData<InfiniteData<UserListPage>>({ queryKey: key }))
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === userId);

  if (fromList) return fromList.viewerIsFollowing;

  return (
    queryClient
      .getQueriesData<InfiniteData<SearchUsersPage>>({ queryKey: orpc.search.users.key() })
      .flatMap(([, data]) => data?.pages ?? [])
      .flatMap((page) => page.items)
      .find((item) => item.id === userId)?.viewerIsFollowing ?? false
  );
}

/** Finds a cached profile by user id — `byUsername` entries are keyed by username, so the match is a scan. */
function cachedProfile(queryClient: QueryClient, userId: string): Profile | undefined {
  return queryClient
    .getQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() })
    .find(([, data]) => data?.id === userId)?.[1];
}

/**
 * Sets `viewerIsFollowing` on every cached row for `userId` in the follower
 * and following list caches. Shared by the optimistic patch (which writes the
 * new direction) and the rollback (which writes the recorded pre-mutation
 * flag back) — the two write the same shape, just different values, and
 * keeping the sweep in one place means neither can drift out of sync with the
 * rows the other one writes.
 */
function setFollowFlagInListCaches(
  queryClient: QueryClient,
  userId: string,
  viewerIsFollowing: boolean,
): void {
  for (const key of [orpc.user.followers.key(), orpc.user.following.key()]) {
    queryClient.setQueriesData<InfiniteData<UserListPage>>({ queryKey: key }, (cached) =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.id === userId ? { ...item, viewerIsFollowing } : item,
              ),
            })),
          }
        : cached,
    );
  }
}

/**
 * Same sweep as {@link setFollowFlagInListCaches}, over `search.users` rows.
 * Search rows carry no follower counts — only the viewer-relative flag — so
 * the flip is the whole patch. Without it, a search-result button would sit
 * stale until the results were refetched.
 */
function setFollowFlagInSearchCaches(
  queryClient: QueryClient,
  userId: string,
  viewerIsFollowing: boolean,
): void {
  queryClient.setQueriesData<InfiniteData<SearchUsersPage>>(
    { queryKey: orpc.search.users.key() },
    (cached) =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.map((item) =>
                item.id === userId ? { ...item, viewerIsFollowing } : item,
              ),
            })),
          }
        : cached,
  );
}

/**
 * Sweeps all four caches that hold a person's follow state: their profile
 * object, the followers list, the following list, and search-result rows.
 * The Following *feed* is a fifth cache that depends on this same state, but
 * it can't be patched client-side (there's no way to synthesise which posts
 * now belong in it), so that one is reset separately by the caller once the
 * mutation settles.
 */
export function patchFollowState(
  queryClient: QueryClient,
  {
    userId,
    viewerId,
    following,
  }: { userId: string; viewerId: string | undefined; following: boolean },
): void {
  queryClient.setQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() }, (cached) => {
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

  setFollowFlagInListCaches(queryClient, userId, following);
  setFollowFlagInSearchCaches(queryClient, userId, following);
}

/**
 * The pre-mutation follow state of ONE person, captured before an optimistic
 * follow/unfollow so it can be undone.
 *
 * Scoped to a single person on purpose: follow and unfollow of two different
 * people are genuinely concurrent (same `scope` argument as `atoms/like.ts`),
 * so rolling one back must not replay cached state the other's mutation — or
 * confirmation — has since written into the same profile/list/search entries.
 * The snapshot therefore records only this person's pre-update values (plus
 * the viewer's own profile count, which the patch also moves), and
 * {@link restoreFollowCaches} writes them back with the same per-person sweep
 * the patch used.
 */
export interface FollowSnapshot {
  /** The person whose follow state this snapshot undoes. */
  userId: string;
  /** The viewer whose own `followingCount` the patch moved, if their profile was cached. */
  viewerId: string | undefined;
  /** The pre-update follow flag, read from whichever cache held the person. */
  viewerIsFollowing: boolean;
  /** The target profile's pre-update follower count — absent when it wasn't cached. */
  followerCount: number | undefined;
  /** The viewer's own profile's pre-update following count — absent when it wasn't cached. */
  viewerFollowingCount: number | undefined;
}

/**
 * Captures the pre-update follow state of `userId`: their flag (from
 * whichever cache holds them) and, when cached, the counts the patch will
 * move — the target profile's follower count and the viewer's own profile's
 * following count. Counts are recorded only when their entry was cached, so
 * the rollback never invents a value for an entry the patch never touched.
 */
export function snapshotFollowCaches(
  queryClient: QueryClient,
  { userId, viewerId }: { userId: string; viewerId: string | undefined },
): FollowSnapshot {
  const targetProfile = cachedProfile(queryClient, userId);
  const viewerProfile = viewerId ? cachedProfile(queryClient, viewerId) : undefined;
  return {
    userId,
    viewerId,
    viewerIsFollowing: readCachedIsFollowing(queryClient, userId),
    followerCount: targetProfile?.followerCount,
    viewerFollowingCount: viewerProfile?.followingCount,
  };
}

/**
 * Undoes an optimistic edit captured by {@link snapshotFollowCaches}, e.g. on
 * a failed mutation. Writes the recorded pre-update values back with the same
 * per-person sweep as {@link patchFollowState}, so it touches only this
 * person's rows (and the viewer's own profile count) and leaves every other
 * person's state — including confirmed writes from concurrent mutations —
 * exactly as it is.
 *
 * Counts are written back only when they were recorded, i.e. when the entry
 * was cached before the patch; an entry that appears after the snapshot (a
 * profile fetched mid-flight) is a fresh server read, and subtracting the
 * patch's ±1 delta from it again would be wrong.
 */
export function restoreFollowCaches(queryClient: QueryClient, snapshot: FollowSnapshot): void {
  queryClient.setQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() }, (cached) => {
    if (!cached) return cached;

    if (cached.id === snapshot.userId) {
      // Same branch order as the patch: the target's own profile gets its flag
      // back, and its follower count back when it was cached at snapshot time.
      return snapshot.followerCount === undefined
        ? { ...cached, viewerIsFollowing: snapshot.viewerIsFollowing }
        : {
            ...cached,
            viewerIsFollowing: snapshot.viewerIsFollowing,
            followerCount: snapshot.followerCount,
          };
    }

    if (
      snapshot.viewerId &&
      cached.id === snapshot.viewerId &&
      snapshot.viewerFollowingCount !== undefined
    ) {
      return { ...cached, followingCount: snapshot.viewerFollowingCount };
    }

    return cached;
  });

  setFollowFlagInListCaches(queryClient, snapshot.userId, snapshot.viewerIsFollowing);
  setFollowFlagInSearchCaches(queryClient, snapshot.userId, snapshot.viewerIsFollowing);
}

/**
 * `follow`/`unfollow` return the authoritative count, so success reconciles
 * the profile cache from the response instead of refetching every visible
 * profile. Only the profile object is patched here — the list caches were
 * already brought in sync by the optimistic `patchFollowState` call, and the
 * response carries no per-row data to reconcile them with.
 */
export function reconcileFollow(queryClient: QueryClient, result: FollowResult): void {
  queryClient.setQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() }, (cached) =>
    cached && cached.id === result.userId
      ? {
          ...cached,
          viewerIsFollowing: result.viewerIsFollowing,
          followerCount: result.followerCount,
        }
      : cached,
  );
}
