import type { InfiniteData, Query, QueryClient, QueryKey } from "@tanstack/react-query";
import {
  orpc,
  type PostListPage,
  type Profile,
  type SearchUsersPage,
  type UserListPage,
} from "@/lib/orpc";
import { getPageRanking } from "@/lib/ranking";

/** What `follow`/`unfollow` return: the person's id and the authoritative follow state. */
export interface FollowResult {
  userId: string;
  followerCount: number;
  viewerIsFollowing: boolean;
  /** Present on `follow` only (issue #328): true when the call created a pending request instead of an edge. */
  requested?: boolean;
}

/**
 * The caches this module writes, listed once so the pre-patch cancel has a
 * single inventory to iterate (issue #127). A person's follow state lives in
 * four shapes at once — their profile object, any follower/following list row,
 * and any `search.users` result row — and {@link patchFollowState} /
 * {@link restoreFollowCaches} sweep exactly these prefixes, plus the
 * ranked-feed suggestion rows inside the `post.list` prefix (issue #305).
 * {@link beginFollowPatch} cancels this inventory before writing, so a caller
 * can't cancel a shorter list and let an in-flight refetch overwrite the
 * patch with pre-click state.
 *
 * The sweeps list the same keys inline rather than iterating this array: each
 * cache has a different shape (flat `Profile` vs paginated `InfiniteData`) and
 * a different update, so a shared loop would need a per-key dispatch. Adding a
 * cache means updating both this array and the sweep that writes it.
 */
export const FOLLOW_CACHE_KEYS = [
  orpc.user.byUsername.key(),
  orpc.user.followers.key(),
  orpc.user.following.key(),
  orpc.search.users.key(),
];

/**
 * A person's follow state is cached in five shapes at once: their profile
 * (a flat object), any follower/following list they appear in (paginated),
 * any `search.users` result row (paginated — the search page renders a
 * live follow button off it), and any ranked-feed Who-to-Follow suggestion
 * row (issue #305 — Discover renders live follow buttons off it). This reads
 * whichever cache happens to hold them rather than from a prop: a prop is a
 * render-time snapshot, so a burst of clicks would all see the same starting
 * value and resolve the same way.
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

  const fromSearch = queryClient
    .getQueriesData<InfiniteData<SearchUsersPage>>({ queryKey: orpc.search.users.key() })
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === userId)?.viewerIsFollowing;
  if (fromSearch !== undefined) return fromSearch;

  return (
    queryClient
      .getQueriesData<InfiniteData<PostListPage>>({ queryKey: orpc.post.list.key() })
      .flatMap(([, data]) => data?.pages ?? [])
      .flatMap((page) => getPageRanking(page)?.suggestions ?? [])
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
 * Whether a cached query holds ranked suggestion rows at all (issue #305).
 * The `beginFollowPatch` cancel predicate uses this so a follow click
 * cancels only the `post.list` entries that actually carry suggestions —
 * never the whole feed inventory on every click.
 */
export function queryHoldsSuggestions(query: Query): boolean {
  // SAFETY: only the ranking block is read, through the validated reader —
  // nothing is written through this view, and non-feed entries simply miss.
  const data = query.state.data as InfiniteData<PostListPage> | undefined;
  return data?.pages.some((page) => (getPageRanking(page)?.suggestions.length ?? 0) > 0) ?? false;
}

/**
 * Same sweep as {@link setFollowFlagInListCaches}, over the ranked-feed
 * Who-to-Follow suggestion rows (issue #305). Suggestion rows carry the same
 * viewer-relative flags as list rows — `viewerIsFollowing` always,
 * `hasRequested` once a private-target response reconciles — so a Discover
 * follow button flips in place like a search-result button does. The feed's
 * post order is untouched: this patches the ranking block, never `items`.
 */
function setFollowFlagInRankedSuggestions(
  queryClient: QueryClient,
  userId: string,
  viewerIsFollowing: boolean,
  hasRequested?: boolean,
): void {
  queryClient.setQueriesData<InfiniteData<PostListPage>>(
    { queryKey: orpc.post.list.key() },
    (cached) =>
      cached
        ? {
            ...cached,
            pages: cached.pages.map((page) => {
              const ranking = getPageRanking(page);
              if (!ranking || !ranking.suggestions.some((item) => item.id === userId)) {
                return page;
              }
              return {
                ...page,
                ranking: {
                  ...ranking,
                  suggestions: ranking.suggestions.map((item) => {
                    if (item.id !== userId) return item;
                    const next = { ...item, viewerIsFollowing };
                    if (hasRequested !== undefined) next.hasRequested = hasRequested;
                    return next;
                  }),
                },
              };
            }),
          }
        : cached,
  );
}

/**
 * Sweeps every cache that holds a person's follow state — the same keys
 * {@link FOLLOW_CACHE_KEYS} lists for the pre-patch cancel, so keep the two in
 * sync when adding a cache. The Following *feed* is a fifth cache that depends
 * on this same state, but it can't be patched client-side (there's no way to
 * synthesise which posts now belong in it), so that one is reset separately
 * by the caller once the mutation settles.
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
  setFollowFlagInRankedSuggestions(queryClient, userId, following);
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
  /**
   * The inverse of the ±1 the patch applied to the viewer's own `followingCount`,
   * applied on rollback — absent when the viewer's profile wasn't cached (so
   * the patch never touched it).
   */
  viewerFollowingDelta: number | undefined;
  /**
   * This person's suggestion rows, one per `post.list` entry that held one
   * (issue #305). A single flag cannot restore them: a row the profile and
   * list caches never saw may hold a different value, and every row carries
   * its own `hasRequested` besides the flag — so each row's own pre-update
   * values are recorded and written back per entry.
   */
  suggestionRows: SuggestionRowSnapshot[];
}

/**
 * One suggestion row's pre-update state, bound to the exact query entry it
 * was read from — the rollback writes it back to that entry only.
 */
export interface SuggestionRowSnapshot {
  queryKey: QueryKey;
  viewerIsFollowing: boolean;
  hasRequested: boolean;
}

/**
 * Captures this person's suggestion rows across the `post.list` entries —
 * at most one row per entry, the first page hit wins per entry since every
 * page of one ranking repeats the same snapshot block.
 */
function snapshotSuggestionRows(queryClient: QueryClient, userId: string): SuggestionRowSnapshot[] {
  const rows: SuggestionRowSnapshot[] = [];
  const entries = queryClient.getQueriesData<InfiniteData<PostListPage>>({
    queryKey: orpc.post.list.key(),
  });
  for (const [queryKey, data] of entries) {
    for (const page of data?.pages ?? []) {
      const row = getPageRanking(page)?.suggestions.find((item) => item.id === userId);
      if (row) {
        rows.push({
          queryKey,
          viewerIsFollowing: row.viewerIsFollowing,
          hasRequested: row.hasRequested,
        });
        break;
      }
    }
  }
  return rows;
}

/** Writes captured suggestion rows back to their own entries — same scope as the capture. */
function restoreSuggestionRows(
  queryClient: QueryClient,
  snapshots: SuggestionRowSnapshot[],
  userId: string,
): void {
  for (const snapshot of snapshots) {
    queryClient.setQueriesData<InfiniteData<PostListPage>>(
      { queryKey: snapshot.queryKey, exact: true },
      (cached) =>
        cached
          ? {
              ...cached,
              pages: cached.pages.map((page) => {
                const ranking = getPageRanking(page);
                if (!ranking || !ranking.suggestions.some((item) => item.id === userId)) {
                  return page;
                }
                return {
                  ...page,
                  ranking: {
                    ...ranking,
                    suggestions: ranking.suggestions.map((item) =>
                      item.id === userId
                        ? {
                            ...item,
                            viewerIsFollowing: snapshot.viewerIsFollowing,
                            hasRequested: snapshot.hasRequested,
                          }
                        : item,
                    ),
                  },
                };
              }),
            }
          : cached,
    );
  }
}

/**
 * Cancels every cache this module writes, then captures the pre-update state
 * and applies the optimistic patch — one call, so the cancel list is
 * {@link FOLLOW_CACHE_KEYS}, the same keys the sweep writes, and can't be
 * rediscovered shorter (issue #127). Cancellation is initiated (fire-and-forget)
 * before the snapshot; the snapshot and patch then run synchronously with no
 * `await` between them, so no refetch can land between the read and the write
 * to poison the rollback. Returns the snapshot for `onError` to feed
 * {@link restoreFollowCaches}.
 */
export function beginFollowPatch(
  queryClient: QueryClient,
  {
    userId,
    viewerId,
    following,
  }: { userId: string; viewerId: string | undefined; following: boolean },
): FollowSnapshot {
  // Cancelling the exact keys this module is about to write stops an in-flight
  // refetch landing after the patch and overwriting it with pre-click server
  // state. The suggestion rows ride the shared `post.list` prefix, so they
  // are cancelled by predicate — only entries actually carrying suggestions
  // (see `queryHoldsSuggestions`), never the whole feed inventory.
  for (const queryKey of FOLLOW_CACHE_KEYS) {
    void queryClient.cancelQueries({ queryKey });
  }
  void queryClient.cancelQueries({
    queryKey: orpc.post.list.key(),
    predicate: queryHoldsSuggestions,
  });
  const snapshot = snapshotFollowCaches(queryClient, { userId, viewerId, following });
  patchFollowState(queryClient, { userId, viewerId, following });
  return snapshot;
}

/**
 * Captures the pre-update follow state of `userId`: their flag (from
 * whichever cache holds them) and, when cached, the target profile's follower
 * count. The viewer's own `followingCount` is recorded as the inverse of the
 * ±1 the patch will apply (not as an absolute value), so the rollback can
 * subtract only this mutation's delta — a concurrent follow of a different
 * person advances the same shared field, and restoring an absolute value would
 * clobber it. The delta is recorded only when the viewer's profile was cached,
 * so the rollback never invents a value for an entry the patch never touched.
 * Suggestion rows are captured per entry beside it (see `FollowSnapshot`).
 */
export function snapshotFollowCaches(
  queryClient: QueryClient,
  {
    userId,
    viewerId,
    following,
  }: { userId: string; viewerId: string | undefined; following: boolean },
): FollowSnapshot {
  const targetProfile = cachedProfile(queryClient, userId);
  const viewerProfile = viewerId ? cachedProfile(queryClient, viewerId) : undefined;
  return {
    userId,
    viewerId,
    viewerIsFollowing: readCachedIsFollowing(queryClient, userId),
    followerCount: targetProfile?.followerCount,
    viewerFollowingDelta: viewerProfile ? (following ? -1 : 1) : undefined,
    suggestionRows: snapshotSuggestionRows(queryClient, userId),
  };
}

/**
 * Undoes an optimistic edit captured by {@link snapshotFollowCaches}, e.g. on
 * a failed mutation. Writes the recorded pre-update values back with the same
 * per-person sweep as {@link patchFollowState}, so it touches only this
 * person's rows and leaves every other person's state — including confirmed
 * writes from concurrent mutations — exactly as it is.
 *
 * The target's follower count is restored absolutely (it is scoped to this
 * person), but the viewer's own `followingCount` is a field shared by every
 * follow mutation, so it is rolled back by applying the recorded inverse delta
 * rather than an absolute value — a concurrent follow of a different person
 * advances the same field, and restoring an absolute snapshot would clobber
 * that increment. The delta is applied only when it was recorded, i.e. when
 * the viewer's profile was cached before the patch; an entry that appears
 * after the snapshot is a fresh server read and must not be adjusted.
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
      snapshot.viewerFollowingDelta !== undefined
    ) {
      return {
        ...cached,
        followingCount: Math.max(0, cached.followingCount + snapshot.viewerFollowingDelta),
      };
    }

    return cached;
  });

  setFollowFlagInListCaches(queryClient, snapshot.userId, snapshot.viewerIsFollowing);
  setFollowFlagInSearchCaches(queryClient, snapshot.userId, snapshot.viewerIsFollowing);
  // Suggestion rows restore per entry from their own capture — never from the
  // shared flag above, which may have come from a different cache holding a
  // different value for the same person.
  restoreSuggestionRows(queryClient, snapshot.suggestionRows, snapshot.userId);
}

/**
 * Withdraws an outgoing follow request from the suggestion rows (issue #328
 * meets #305): the row flips back to Follow in place, like the profile and
 * list buttons the cancel path already refetches. A request was never a feed
 * membership, so no feed invalidation is needed — and none happens, which
 * keeps the pinned snapshot (and its order) exactly where it was.
 */
export function withdrawSuggestionRequest(queryClient: QueryClient, userId: string): void {
  setFollowFlagInRankedSuggestions(queryClient, userId, false, false);
}

/**
 * `follow`/`unfollow` return the authoritative count, so success reconciles
 * the profile cache from the response instead of refetching every visible
 * profile. Only the profile object is patched here — the list, search and
 * suggestion caches were already brought in sync by the optimistic
 * `patchFollowState` call, and the response carries no per-row data to
 * reconcile them with. A `requested` response (issue #328, private target)
 * also flips `hasRequested` — the optimistic patch set `viewerIsFollowing`
 * true, which the response corrects back to false alongside it.
 */
export function reconcileFollow(queryClient: QueryClient, result: FollowResult): void {
  queryClient.setQueriesData<Profile>({ queryKey: orpc.user.byUsername.key() }, (cached) => {
    if (!cached || cached.id !== result.userId) return cached;
    const next: Profile = {
      ...cached,
      viewerIsFollowing: result.viewerIsFollowing,
      followerCount: result.followerCount,
    };
    if (result.requested !== undefined) {
      next.hasRequested = result.requested;
    }
    return next;
  });
  // List, search and suggestion rows carry the same flags — bring them in
  // sync when the response names a request state, so a private-target follow
  // flips the row to Requested without waiting for a refetch.
  if (result.requested !== undefined) {
    const hasRequested = result.requested;
    for (const key of [orpc.user.followers.key(), orpc.user.following.key()]) {
      queryClient.setQueriesData<InfiniteData<UserListPage>>({ queryKey: key }, (cached) =>
        cached
          ? {
              ...cached,
              pages: cached.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === result.userId
                    ? { ...item, viewerIsFollowing: result.viewerIsFollowing, hasRequested }
                    : item,
                ),
              })),
            }
          : cached,
      );
    }
    queryClient.setQueriesData<InfiniteData<SearchUsersPage>>(
      { queryKey: orpc.search.users.key() },
      (cached) =>
        cached
          ? {
              ...cached,
              pages: cached.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === result.userId
                    ? { ...item, viewerIsFollowing: result.viewerIsFollowing, hasRequested }
                    : item,
                ),
              })),
            }
          : cached,
    );
    setFollowFlagInRankedSuggestions(
      queryClient,
      result.userId,
      result.viewerIsFollowing,
      hasRequested,
    );
  }
}
