import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage } from "@/lib/orpc";

export type CachedFeeds = [readonly unknown[], InfiniteData<PostListPage> | undefined][];

/**
 * Current state, read from whichever feed happens to hold this post rather
 * than from a prop: a prop is a render-time snapshot, so a burst of clicks
 * would all see the same starting value and resolve to the same direction.
 */
export function readCachedPost(queryClient: QueryClient, postId: string): Post | undefined {
  return queryClient
    .getQueriesData<InfiniteData<PostListPage>>({ queryKey: orpc.post.list.key() })
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === postId);
}

/**
 * A post can be cached in several feeds at once (the home timeline and its
 * author's profile), so every optimistic edit has to sweep all `post.list`
 * queries rather than one key.
 */
export function updatePostEverywhere(
  queryClient: QueryClient,
  postId: string,
  update: (post: Post) => Post,
): void {
  queryClient.setQueriesData<InfiniteData<PostListPage>>({ queryKey: orpc.post.list.key() }, (cached) =>
    cached
      ? {
          ...cached,
          pages: cached.pages.map((page) => ({
            ...page,
            items: page.items.map((post) => (post.id === postId ? update(post) : post)),
          })),
        }
      : cached,
  );
}

/** Snapshot of every `post.list` query, taken before an optimistic edit so it can be undone. */
export function snapshotFeeds(queryClient: QueryClient): CachedFeeds {
  return queryClient.getQueriesData<InfiniteData<PostListPage>>({ queryKey: orpc.post.list.key() });
}

/** Restores a snapshot taken by {@link snapshotFeeds}, e.g. on a failed mutation. */
export function restoreFeeds(queryClient: QueryClient, snapshot: CachedFeeds): void {
  for (const [key, data] of snapshot) {
    queryClient.setQueryData(key, data);
  }
}
