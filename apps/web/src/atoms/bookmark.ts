import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { store } from "@/lib/store";
import { orpc } from "@/lib/orpc";
import {
  beginPostPatch,
  readCachedPost,
  removePostFromBookmarksFeed,
  restorePosts,
  updatePostEverywhere,
  type PostSnapshot,
  type PostSnapshotScope,
} from "@/lib/post-cache";

/**
 * The state the *last* click asked for, per post — the bookmark twin of
 * `intentFamily` in `atoms/like.ts`, and for the same reason: bookmark and
 * unbookmark are serialised (see `scope` below), so responses for superseded
 * clicks still arrive, and this is what lets `onSuccess` drop the ones that no
 * longer match the user's current intent instead of flickering through them.
 */
const intentFamily = atomFamily<string, PrimitiveAtom<boolean | null>>(() =>
  atom<boolean | null>(null),
);

interface BookmarkContext {
  snapshot: PostSnapshot | undefined;
}

interface BookmarkResult {
  postId: string;
  viewerHasBookmarked: boolean;
}

interface BookmarkVariables {
  postId: string;
}

/** The bookmark family's slice of the cached post row — what its rollback may touch. */
const SNAPSHOT_SCOPE: PostSnapshotScope = "bookmark";

/**
 * `post.bookmark` / `post.unbookmark` as optimistic mutations — structurally
 * the same design as `atoms/like.ts` (mutation-level callbacks, one scope per
 * post, intent-tracked reconciliation), and for the same reasons documented
 * there. The one difference the response shape forces: a like reconciles the
 * public count from the response, while a bookmark is private state with no
 * count, so success merely confirms the flag the optimistic patch already
 * set.
 */
function toggleMutationAtom(postId: string, direction: "bookmark" | "unbookmark") {
  // Explicit type parameters: the options are built by spreading oRPC's
  // `mutationOptions()`, and inference does not flow the variables/context
  // types back out through that spread.
  return atomWithMutation<BookmarkResult, BookmarkVariables, Error, BookmarkContext>((get) => {
    const queryClient = get(queryClientAtom);
    const procedure = direction === "bookmark" ? orpc.post.bookmark : orpc.post.unbookmark;
    const bookmarked = direction === "bookmark";

    return {
      ...procedure.mutationOptions(),

      // Both directions share one scope id, which is what makes them run in
      // serial (see `atoms/like.ts`): a quick bookmark-then-unbookmark must
      // not let the responses land in the opposite order to the clicks.
      // Scoped per post, not globally — two different posts have no ordering
      // relationship and shouldn't queue.
      scope: { id: `post-bookmark:${postId}` },

      // Runs synchronously inside `mutate()`, before the scope queue gate, so
      // the optimistic patch lands on click. The patch rides the same
      // `beginPostPatch` inventory as likes (feeds — including the bookmarks
      // page's `post.list` entry — threads, and search results), so every
      // cached copy of the post flips together.
      onMutate: (): BookmarkContext => {
        const snapshot = beginPostPatch(queryClient, postId, SNAPSHOT_SCOPE, (post) => {
          if (post.viewerHasBookmarked === bookmarked) return post;
          return { ...post, viewerHasBookmarked: bookmarked };
        });
        return { snapshot };
      },

      // The response carries no count to reconcile — private state, nothing
      // public to re-derive — so success confirms (or drops, when a later
      // click has since flipped the intent) the flag. A confirmed UN-bookmark
      // also drops the row from the bookmarks page's cached pages, so the
      // saved list updates on the click itself. That is safe and was always
      // the intent: `getNextPageParam` reads the stored per-page `nextCursor`,
      // which filtering `items` leaves untouched — cursors come from the
      // server's page boundaries, not from the rows the client happens to be
      // holding.
      onSuccess: (result: BookmarkResult) => {
        // Read at callback time, deliberately not via the factory's `get`:
        // `get(intentFamily(...))` here would make intent a dependency of the
        // options, so every click would rebuild the mutation options.
        const intent = store.get(intentFamily(postId));
        if (intent !== null && result.viewerHasBookmarked !== intent) return;

        updatePostEverywhere(queryClient, result.postId, (post) => ({
          ...post,
          viewerHasBookmarked: result.viewerHasBookmarked,
        }));
        if (result.viewerHasBookmarked === false) {
          removePostFromBookmarksFeed(queryClient, result.postId);
        }
      },

      onError: (
        _error: Error,
        _variables: BookmarkVariables,
        context: BookmarkContext | undefined,
      ) => {
        // No snapshot means the post was cached nowhere at `onMutate` time, so
        // the optimistic patch was a no-op and there is nothing to undo.
        if (context?.snapshot) restorePosts(queryClient, context.snapshot);
      },
    };
  });
}

const bookmarkFamily = atomFamily((postId: string) => toggleMutationAtom(postId, "bookmark"));
const unbookmarkFamily = atomFamily((postId: string) => toggleMutationAtom(postId, "unbookmark"));

/**
 * Write-only, like `toggleLikeAtomFamily`: `useSetAtom` gives a component the
 * action without subscribing it to mutation status — the optimistic flip *is*
 * the feedback. The direction is read from the cache, not a prop, so a burst
 * of clicks alternates instead of resolving to the same starting value.
 */
export const toggleBookmarkAtomFamily = atomFamily((postId: string) =>
  atom(null, (get) => {
    const queryClient = get(queryClientAtom);

    const bookmarked = !(readCachedPost(queryClient, postId)?.viewerHasBookmarked ?? false);
    store.set(intentFamily(postId), bookmarked);

    // `get` computes the mutation atom without mounting it, which is exactly
    // why rollback lives on the mutation options above.
    get(bookmarked ? bookmarkFamily(postId) : unbookmarkFamily(postId)).mutate({ postId });
  }),
);

/** Drops every entry these families have created. See `clearPostFeedFamily`. */
export function clearBookmarkFamilies(): void {
  for (const key of bookmarkFamily.getParams()) bookmarkFamily.remove(key);
  for (const key of unbookmarkFamily.getParams()) unbookmarkFamily.remove(key);
  for (const key of intentFamily.getParams()) intentFamily.remove(key);
  for (const key of toggleBookmarkAtomFamily.getParams()) toggleBookmarkAtomFamily.remove(key);
}
