import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage, type Thread } from "@/lib/orpc";

/** Every cached `post.list` entry as [queryKey, data] — the snapshot unit for feeds. */
export type CachedFeeds = [readonly unknown[], InfiniteData<PostListPage> | undefined][];
/** Every cached `post.thread` entry as [queryKey, data] — the snapshot unit for threads. */
export type CachedThreads = [readonly unknown[], Thread | undefined][];

/**
 * A post is cached in two structurally different shapes, and every helper here
 * has to cover both:
 *
 * - `post.list` — paginated `InfiniteData`, one entry per (feed, author,
 *   parent) combination. A post can be in several at once: the home timeline,
 *   its author's profile feed, and the reply list under whatever it replies to.
 * - `post.thread` — a flat `{ post, ancestors }` object, one entry per open
 *   permalink. The focused post lives here, and so does every ancestor above
 *   it.
 *
 * Missing the thread half is not a cosmetic bug: opening `/post/<id>` cold
 * puts that post in *no* feed, so a like would find nothing to patch and the
 * button would sit there doing nothing until a refetch landed.
 */
export interface PostSnapshot {
  feeds: CachedFeeds;
  threads: CachedThreads;
}

function feedQueries(queryClient: QueryClient): CachedFeeds {
  return queryClient.getQueriesData<InfiniteData<PostListPage>>({
    queryKey: orpc.post.list.key(),
  });
}

function threadQueries(queryClient: QueryClient): CachedThreads {
  return queryClient.getQueriesData<Thread>({ queryKey: orpc.post.thread.key() });
}

/**
 * Current state, read from whichever cache happens to hold this post rather
 * than from a prop: a prop is a render-time snapshot, so a burst of clicks
 * would all see the same starting value and resolve to the same direction.
 *
 * Feeds are checked first only because they are the common case; the two
 * shapes always agree, since every write goes through
 * {@link updatePostEverywhere}.
 */
export function readCachedPost(queryClient: QueryClient, postId: string): Post | undefined {
  const fromFeed = feedQueries(queryClient)
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === postId);

  if (fromFeed) return fromFeed;

  return threadQueries(queryClient)
    .flatMap(([, data]) => (data ? [data.post, ...data.ancestors] : []))
    .find((item) => item.id === postId);
}

/**
 * Applies `update` to every copy of a post in both caches. See
 * {@link PostSnapshot} for why one post has several homes.
 */
export function updatePostEverywhere(
  queryClient: QueryClient,
  postId: string,
  update: (post: Post) => Post,
): void {
  queryClient.setQueriesData<InfiniteData<PostListPage>>(
    { queryKey: orpc.post.list.key() },
    (cached) =>
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

  queryClient.setQueriesData<Thread>({ queryKey: orpc.post.thread.key() }, (cached) =>
    cached
      ? {
          ...cached,
          post: cached.post.id === postId ? update(cached.post) : cached.post,
          ancestors: cached.ancestors.map((post) => (post.id === postId ? update(post) : post)),
        }
      : cached,
  );
}

/** Snapshot of every cached post, taken before an optimistic edit so it can be undone. */
export function snapshotPosts(queryClient: QueryClient): PostSnapshot {
  return { feeds: feedQueries(queryClient), threads: threadQueries(queryClient) };
}

/** Restores a snapshot taken by {@link snapshotPosts}, e.g. on a failed mutation. */
export function restorePosts(queryClient: QueryClient, snapshot: PostSnapshot): void {
  for (const [key, data] of snapshot.feeds) {
    queryClient.setQueryData(key, data);
  }
  for (const [key, data] of snapshot.threads) {
    queryClient.setQueryData(key, data);
  }
}
