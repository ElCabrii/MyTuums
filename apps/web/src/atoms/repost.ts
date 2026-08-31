import { atom, type PrimitiveAtom } from "jotai";
import { atomFamily } from "jotai-family";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { store } from "@/lib/store";
import { orpc } from "@/lib/orpc";
import {
  beginPostPatch,
  readCachedPost,
  restorePosts,
  updatePostEverywhere,
  type PostSnapshot,
  type PostSnapshotScope,
} from "@/lib/post-cache";

/**
 * The repost mirror of `atoms/like.ts`: the same per-post intent atom, the
 * same shared mutation scope, the same reconcile-from-response success path,
 * and the same mutation-level rollback contract (the doc comment there is the
 * full reasoning — this file deliberately restates only what differs).
 *
 * What differs: a repost is also a feed *event*, and success in either
 * direction changes the event list — a new repost belongs at the top of the
 * home feeds at the event's own timestamp, and an unrepost removes one (the
 * primary flow: unreposting from the "You reposted" card at the top of the
 * viewer's own home feed). The optimistic patch only flips the count and the
 * viewer flag; the event list is server-ordered, so success invalidates the
 * feed queries rather than trying to splice an event in or guess which cached
 * page holds one. A refetch landing mid-scroll is the same trade
 * `createPostAtom` makes for a fresh post.
 */
const intentFamily = atomFamily<string, PrimitiveAtom<boolean | null>>(() =>
  atom<boolean | null>(null),
);

interface RepostResult {
  postId: string;
  repostCount: number;
  viewerHasReposted: boolean;
}

interface RepostVariables {
  postId: string;
}

interface RepostContext {
  snapshot: PostSnapshot | undefined;
}

/** The repost family's slice of the cached post row — what its rollback may touch. */
const SNAPSHOT_SCOPE: PostSnapshotScope = "repost";

function toggleMutationAtom(postId: string, direction: "repost" | "unrepost") {
  return atomWithMutation<RepostResult, RepostVariables, Error, RepostContext>((get) => {
    const queryClient = get(queryClientAtom);
    const procedure = direction === "repost" ? orpc.post.repost : orpc.post.unrepost;
    const reposted = direction === "repost";

    return {
      ...procedure.mutationOptions(),

      // One scope id per post shared by both directions, so a quick
      // repost-then-unrepost applies in order and the server's final state is
      // the user's last intent (see `atoms/like.ts`).
      scope: { id: `post-repost:${postId}` },

      onMutate: (): RepostContext => {
        const snapshot = beginPostPatch(queryClient, postId, SNAPSHOT_SCOPE, (post) => {
          if (post.viewerHasReposted === reposted) return post;
          const delta = reposted ? 1 : -1;
          return { ...post, viewerHasReposted: reposted, repostCount: post.repostCount + delta };
        });
        return { snapshot };
      },

      onSuccess: (result: RepostResult) => {
        const intent = store.get(intentFamily(postId));
        if (intent !== null && result.viewerHasReposted !== intent) return;

        updatePostEverywhere(queryClient, result.postId, (post) => ({
          ...post,
          repostCount: result.repostCount,
          viewerHasReposted: result.viewerHasReposted,
        }));

        // A repost is a feed event whose position is server-ordered — and so
        // is the removal of one. Success refetches the feed lists in both
        // directions: a new repost lands at the top of the home feeds at the
        // event's own timestamp, and an unrepost (typically from the "You
        // reposted" card at the top of the viewer's own home feed) takes an
        // event out that no cached page knows is gone. Refetch rather than
        // splice in either direction.
        void queryClient.invalidateQueries({ queryKey: orpc.post.list.key() });
      },

      onError: (_error: Error, _variables: RepostVariables, context: RepostContext | undefined) => {
        if (context?.snapshot) restorePosts(queryClient, context.snapshot);
      },
    };
  });
}

const repostFamily = atomFamily((postId: string) => toggleMutationAtom(postId, "repost"));
const unrepostFamily = atomFamily((postId: string) => toggleMutationAtom(postId, "unrepost"));

/** Write-only action: flips the viewer's repost state from the cache, like `toggleLikeAtomFamily`. */
export const toggleRepostAtomFamily = atomFamily((postId: string) =>
  atom(null, (get) => {
    const queryClient = get(queryClientAtom);

    const reposted = !(readCachedPost(queryClient, postId)?.viewerHasReposted ?? false);
    store.set(intentFamily(postId), reposted);

    get(reposted ? repostFamily(postId) : unrepostFamily(postId)).mutate({ postId });
  }),
);

/** Drops every entry these families have created. See `clearPostFeedFamily`. */
export function clearRepostFamilies(): void {
  for (const key of repostFamily.getParams()) repostFamily.remove(key);
  for (const key of unrepostFamily.getParams()) unrepostFamily.remove(key);
  for (const key of intentFamily.getParams()) intentFamily.remove(key);
  for (const key of toggleRepostAtomFamily.getParams()) toggleRepostAtomFamily.remove(key);
}
