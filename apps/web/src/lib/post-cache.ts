import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc, type Post, type PostListPage, type SearchPostsPage, type Thread } from "@/lib/orpc";

/**
 * The caches this module writes, listed once so the pre-patch cancel has a
 * single inventory to iterate (issue #127). A post is cached in three shapes
 * at once — feeds, threads, and search results — and {@link updatePostEverywhere}
 * / {@link restorePosts} sweep exactly these prefixes. {@link beginPostPatch}
 * cancels this inventory before writing, so a caller can't cancel a shorter
 * list and let an in-flight refetch overwrite the patch with pre-click state.
 *
 * The sweep lists the same keys inline rather than iterating this array: each
 * cache has a different shape (paginated `InfiniteData` vs a flat `Thread`) and
 * a different update, so a shared loop would need a per-key dispatch. Adding a
 * cache means updating both this array and the sweep that writes it.
 */
export const POST_CACHE_KEYS = [
  orpc.post.list.key(),
  orpc.post.thread.key(),
  orpc.search.posts.key(),
];

/** Every cached `post.list` entry as [queryKey, data] — the read unit for {@link readCachedPost}. */
type CachedFeeds = [readonly unknown[], InfiniteData<PostListPage> | undefined][];
/** Every cached `post.thread` entry as [queryKey, data] — the read unit for {@link readCachedPost}. */
type CachedThreads = [readonly unknown[], Thread | undefined][];
/** Every cached `search.posts` entry as [queryKey, data] — the read unit for {@link readCachedPost}. */
type CachedSearchPosts = [readonly unknown[], InfiniteData<SearchPostsPage> | undefined][];

/**
 * The pre-mutation state of ONE post, captured before an optimistic edit so
 * it can be undone.
 *
 * Scoped to a single id on purpose: likes on two different posts are
 * genuinely concurrent (see the `scope` note in `atoms/like.ts`), so a
 * failed like on post A must not replay cached state that post B's mutation
 * — or confirmation — has since written into the same feed/thread/search
 * entries. The snapshot is therefore just A's own row, and
 * {@link restorePosts} writes it back through the entity-scoped
 * {@link updatePostEverywhere}, which touches only A's fields in every
 * entry it appears in and leaves every other post's fields exactly as they
 * are.
 */
export interface PostSnapshot {
  /** The post this snapshot is scoped to. */
  postId: string;
  /** The post's full pre-mutation row, as read from whichever cache held it. */
  post: Post;
}

function feedQueries(queryClient: QueryClient): CachedFeeds {
  return queryClient.getQueriesData<InfiniteData<PostListPage>>({
    queryKey: orpc.post.list.key(),
  });
}

function threadQueries(queryClient: QueryClient): CachedThreads {
  return queryClient.getQueriesData<Thread>({ queryKey: orpc.post.thread.key() });
}

function searchPostsQueries(queryClient: QueryClient): CachedSearchPosts {
  return queryClient.getQueriesData<InfiniteData<SearchPostsPage>>({
    queryKey: orpc.search.posts.key(),
  });
}

function postsInListPage(page: PostListPage): Post[] {
  const continuations =
    "continuations" in page ? page.continuations.flatMap((continuation) => continuation.items) : [];
  return [...page.items, ...continuations];
}

function updatePostListPage(
  page: PostListPage,
  postId: string,
  update: (post: Post) => Post,
): PostListPage {
  const items = page.items.map((post) => (post.id === postId ? update(post) : post));
  if (!("continuations" in page)) return { ...page, items };

  return {
    ...page,
    items,
    continuations: page.continuations.map((continuation) => ({
      ...continuation,
      items: continuation.items.map((post) => (post.id === postId ? update(post) : post)),
    })),
  };
}

/**
 * Current state, read from whichever cache happens to hold this post rather
 * than from a prop: a prop is a render-time snapshot, so a burst of clicks
 * would all see the same starting value and resolve to the same direction.
 *
 * Feeds are checked first only because they are the common case; the three
 * shapes always agree, since every write goes through
 * {@link updatePostEverywhere}.
 */
export function readCachedPost(queryClient: QueryClient, postId: string): Post | undefined {
  const fromFeed = feedQueries(queryClient)
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap(postsInListPage)
    .find((item) => item.id === postId);

  if (fromFeed) return fromFeed;

  const fromSearch = searchPostsQueries(queryClient)
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.items)
    .find((item) => item.id === postId);

  if (fromSearch) return fromSearch;

  return threadQueries(queryClient)
    .flatMap(([, data]) => (data ? [data.post, ...data.ancestors] : []))
    .find((item) => item.id === postId);
}

/**
 * A post is cached in three structurally different shapes, and every helper here
 * has to cover all of them:
 *
 * - `post.list` — paginated `InfiniteData`, one entry per (feed, author,
 *   parent) combination. A post can be in several at once: the home timeline,
 *   its author's profile feed, and the reply list under whatever it replies to.
 * - `post.thread` — a flat `{ post, ancestors }` object, one entry per open
 *   permalink. The focused post lives here, and so does every ancestor above
 *   it.
 * - `search.posts` — the same paginated `InfiniteData` shape as `post.list`,
 *   one entry per query. A search result is a real, cached home for a post
 *   that may exist in no feed and no thread.
 *
 * Missing any one of the three is not a cosmetic bug: opening `/post/<id>` cold
 * puts that post in *no* feed, so a like would find nothing to patch and the
 * button would sit there doing nothing until a refetch landed — and a post
 * whose only cached copy is a search result would get its like direction
 * computed from "nothing cached" and re-send `like` instead of `unlike`.
 *
 * Because one post has several homes, every write has to sweep all three —
 * which is also what makes the rollback in {@link PostSnapshot} precise:
 * undoing an edit means re-running this sweep with the pre-mutation row,
 * not replaying whole query objects.
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
            pages: cached.pages.map((page) => updatePostListPage(page, postId, update)),
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

  // `search.posts` is a third home for the paginated shape: its items are the
  // same `Post` rows, so a like on one must patch it here too or the button
  // would sit stale until the results were refetched.
  queryClient.setQueriesData<InfiniteData<SearchPostsPage>>(
    { queryKey: orpc.search.posts.key() },
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
}

/**
 * Cancels every cache this module writes, then captures the pre-update row and
 * applies `update` across all of them — one call, so the cancel list is
 * {@link POST_CACHE_KEYS}, the same keys the sweep writes, and can't be
 * rediscovered shorter (issue #127). Cancellation is initiated (fire-and-forget)
 * before the snapshot; the snapshot and patch then run synchronously with no
 * `await` between them, so no refetch can land between the read and the write
 * to poison the rollback. Returns the snapshot for `onError` to feed
 * {@link restorePosts} — `undefined` when the post was cached nowhere (then
 * the patch is a no-op and there is nothing to undo).
 */
export function beginPostPatch(
  queryClient: QueryClient,
  postId: string,
  update: (post: Post) => Post,
): PostSnapshot | undefined {
  // Cancelling the exact keys this module is about to write stops an in-flight
  // refetch landing after the patch and overwriting it with pre-click server
  // state.
  for (const queryKey of POST_CACHE_KEYS) {
    void queryClient.cancelQueries({ queryKey });
  }
  const snapshot = snapshotPosts(queryClient, postId);
  updatePostEverywhere(queryClient, postId, update);
  return snapshot;
}

/**
 * Captures the pre-mutation state of `postId` — its full row, read from
 * whichever cache happens to hold it — so a failed mutation can undo exactly
 * its own optimistic patch.
 *
 * Returns undefined when the post is cached nowhere: then the optimistic
 * patch was a no-op and there is nothing to undo.
 */
export function snapshotPosts(queryClient: QueryClient, postId: string): PostSnapshot | undefined {
  const post = readCachedPost(queryClient, postId);
  return post ? { postId, post } : undefined;
}

/**
 * Undoes an optimistic edit captured by {@link snapshotPosts}, e.g. on a
 * failed mutation. The pre-mutation row is written back through
 * {@link updatePostEverywhere}, so it replaces every copy of THIS post in
 * all three caches — and touches no other post's fields in those same
 * entries, even when another post's concurrent mutation has since confirmed
 * new values into them.
 */
export function restorePosts(queryClient: QueryClient, snapshot: PostSnapshot): void {
  updatePostEverywhere(queryClient, snapshot.postId, () => snapshot.post);
}
