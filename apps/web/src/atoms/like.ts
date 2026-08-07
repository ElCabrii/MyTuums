import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { store } from "@/lib/store";
import { orpc } from "@/lib/orpc";
import {
  readCachedPost,
  restorePosts,
  snapshotPosts,
  updatePostEverywhere,
  type PostSnapshot,
} from "@/lib/post-cache";

/**
 * The state the *last* click asked for, per post.
 *
 * Because like and unlike are serialised (see `scope` below), responses for
 * superseded clicks still arrive. This is what lets `onSuccess` tell "the
 * server confirming what the user currently wants" apart from "the server
 * confirming a click that's already been undone", and drop the latter instead
 * of flickering through it.
 *
 * Per-post rather than per-component, which the `useRef` it replaces could
 * never be: the same post can render in the home feed and a profile feed at
 * once, and those two cards shared one mutation queue but had two independent
 * refs, so neither knew about the other's clicks.
 */
const intentFamily = atomFamily<string, PrimitiveAtom<boolean | null>>(() =>
  atom<boolean | null>(null),
);

interface LikeContext {
  snapshot: PostSnapshot;
}

interface LikeResult {
  postId: string;
  likeCount: number;
  viewerHasLiked: boolean;
}

interface LikeVariables {
  postId: string;
}

/**
 * Rollback rides on `onMutate` context and a MUTATION-LEVEL `onError`, not on
 * a per-call `mutate(vars, { onError })`. That is load-bearing, not taste.
 *
 * query-core stores per-call callbacks on the mutation's *observer* and only
 * fires them when `hasListeners()` is true (`mutationObserver.ts:164`), and
 * `atomWithMutation` subscribes its observer only in the result atom's
 * `onMount`. The action atom below reads the mutation with `get()` and is
 * itself read with `useSetAtom`, so nothing ever mounts it — a per-call
 * `onError` would silently never run and a failed like would stick forever.
 * Mutation-level callbacks land on `mutation.options` and fire regardless of
 * what is mounted.
 *
 * Verified empirically before this was written: fired from an unmounted
 * write-only path, mutation-level `onError` runs, each queued mutation
 * receives its own `onMutate` context, and the shared scope still serialises
 * the pair.
 */
function toggleMutationAtom(postId: string, direction: "like" | "unlike") {
  // Explicit type parameters: the options are built by spreading oRPC's
  // `mutationOptions()`, and inference does not flow the variables/context
  // types back out through that spread.
  return atomWithMutation<LikeResult, LikeVariables, Error, LikeContext>((get) => {
    const queryClient = get(queryClientAtom);
    const procedure = direction === "like" ? orpc.post.like : orpc.post.unlike;
    const liked = direction === "like";

    return {
      ...procedure.mutationOptions(),

      // Both directions share one scope id, which is what makes them run in
      // serial (TanStack queues same-scope mutations). Without it the two
      // requests race: a quick like-then-unlike can have the *unlike* response
      // land first and the *like* response land second, so `onSuccess`
      // reconciles from the stale one and the UI settles on "liked" while the
      // server has it unliked. Serialising also means the server applies the
      // clicks in the order they were made, so its final state is the user's
      // last intent — the half a client-side ordering guard can't fix.
      //
      // Scoped per post, not globally: liking two different posts in quick
      // succession has no ordering relationship and shouldn't queue.
      scope: { id: `post-like:${postId}` },

      // Runs synchronously inside `mutate()` — `onMutate` is awaited at
      // `mutation.ts:222` and the queue gate is `retryer.start()` one line
      // later, so a scoped mutation does NOT delay it. The optimistic patch
      // still lands on click, not a round trip later. Nothing here awaits, so
      // cancel + snapshot + patch stay one atomic block with no boundary for
      // an interleaved dispatch to land in.
      onMutate: (): LikeContext => {
        // All three caches hold this post (see lib/post-cache.ts), so all three
        // need cancelling — an in-flight refetch landing after the patch would
        // overwrite it with the pre-click server state, whether it came from a
        // feed, a thread or a search result.
        void queryClient.cancelQueries({ queryKey: orpc.post.list.key() });
        void queryClient.cancelQueries({ queryKey: orpc.post.thread.key() });
        void queryClient.cancelQueries({ queryKey: orpc.search.posts.key() });
        const snapshot = snapshotPosts(queryClient);

        updatePostEverywhere(queryClient, postId, (post) => {
          if (post.viewerHasLiked === liked) return post;
          const likeDelta = liked ? 1 : -1;
          return { ...post, viewerHasLiked: liked, likeCount: post.likeCount + likeDelta };
        });

        return { snapshot };
      },

      // `like`/`unlike` return the authoritative count, so success reconciles
      // from the response instead of invalidating and refetching every feed.
      onSuccess: (result: LikeResult) => {
        // Read at callback time, deliberately not via the factory's `get`:
        // `get(intentFamily(...))` here would make intent a dependency of the
        // options, so every click would rebuild the mutation options.
        const intent = store.get(intentFamily(postId));
        if (intent !== null && result.viewerHasLiked !== intent) return;

        updatePostEverywhere(queryClient, result.postId, (post) => ({
          ...post,
          likeCount: result.likeCount,
          viewerHasLiked: result.viewerHasLiked,
        }));
      },

      onError: (_error: Error, _variables: LikeVariables, context: LikeContext | undefined) => {
        if (context) restorePosts(queryClient, context.snapshot);
      },
    };
  });
}

const likeFamily = atomFamily((postId: string) => toggleMutationAtom(postId, "like"));
const unlikeFamily = atomFamily((postId: string) => toggleMutationAtom(postId, "unlike"));

/**
 * Write-only: `useSetAtom(toggleLikeAtomFamily(id))` gives a component the
 * action without subscribing it to mutation status, which `PostCard` renders
 * none of — the optimistic flip *is* the feedback.
 */
export const toggleLikeAtomFamily = atomFamily((postId: string) =>
  atom(null, (get) => {
    const queryClient = get(queryClientAtom);

    // Read the current state from the cache rather than a prop: a prop is a
    // render-time snapshot, so a burst of clicks would all see the same
    // starting value and resolve to the same direction.
    const liked = !(readCachedPost(queryClient, postId)?.viewerHasLiked ?? false);
    store.set(intentFamily(postId), liked);

    // `get` computes the mutation atom without mounting it, which is exactly
    // why rollback lives on the mutation options above.
    get(liked ? likeFamily(postId) : unlikeFamily(postId)).mutate({ postId });
  }),
);

/** Drops every entry these families have created. See `clearPostFeedFamily`. */
export function clearLikeFamilies(): void {
  for (const key of [...likeFamily.getParams()]) likeFamily.remove(key);
  for (const key of [...unlikeFamily.getParams()]) unlikeFamily.remove(key);
  for (const key of [...intentFamily.getParams()]) intentFamily.remove(key);
  for (const key of [...toggleLikeAtomFamily.getParams()]) toggleLikeAtomFamily.remove(key);
}
