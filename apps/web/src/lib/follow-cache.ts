import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc, type Profile, type SearchUsersPage, type UserListPage } from "@/lib/orpc";

type CachedQueries<T> = [readonly unknown[], T | undefined][];

export interface FollowSnapshot {
  profiles: CachedQueries<Profile>;
  lists: CachedQueries<InfiniteData<UserListPage>>;
  search: CachedQueries<InfiniteData<SearchUsersPage>>;
}

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
  const fromProfile = queryClient
    .getQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() })
    .find(([, data]) => data?.id === userId)?.[1];

  if (fromProfile) return fromProfile.viewerIsFollowing;

  const fromList = [orpc.user.followers.key(), orpc.user.following.key()]
    .flatMap((key) => queryClient.getQueriesData<InfiniteData<UserListPage>>({ queryKey: key }))
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === userId);

  if (fromList) return fromList.viewerIsFollowing;

  return queryClient
    .getQueriesData<InfiniteData<SearchUsersPage>>({ queryKey: orpc.search.users.key() })
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === userId)?.viewerIsFollowing ?? false;
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
  { userId, viewerId, following }: { userId: string; viewerId: string | undefined; following: boolean },
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

  for (const key of [orpc.user.followers.key(), orpc.user.following.key()]) {
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

  // Search rows carry no follower counts — only the viewer-relative flag — so
  // the flip is the whole patch. Without it, a search-result button would sit
  // stale until the results were refetched.
  queryClient.setQueriesData<InfiniteData<SearchUsersPage>>(
    { queryKey: orpc.search.users.key() },
    (cached) =>
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

/** Snapshot of every profile, follower/following list and search-result query, taken before an optimistic edit so it can be undone. */
export function snapshotFollowCaches(queryClient: QueryClient): FollowSnapshot {
  return {
    profiles: queryClient.getQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() }),
    lists: [orpc.user.followers.key(), orpc.user.following.key()].flatMap((key) =>
      queryClient.getQueriesData<InfiniteData<UserListPage>>({ queryKey: key }),
    ),
    search: queryClient.getQueriesData<InfiniteData<SearchUsersPage>>({
      queryKey: orpc.search.users.key(),
    }),
  };
}

/** Restores a snapshot taken by {@link snapshotFollowCaches}, e.g. on a failed mutation. */
export function restoreFollowCaches(queryClient: QueryClient, snapshot: FollowSnapshot): void {
  for (const [key, data] of [...snapshot.profiles, ...snapshot.lists, ...snapshot.search]) {
    queryClient.setQueryData(key, data);
  }
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
