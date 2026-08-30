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
} from "@/lib/post-cache";
import type { PostSnapshot } from "@/lib/post-cache";

/**
 * The repost mirror of `atoms/like.ts`: the same per-post intent atom, the
 * same shared mutation scope, the same reconcile-from-response success path,
 * and the same mutation-level rollback contract (the doc comment there is the
 * full reasoning — this file deliberately restates only what differs).
 *
 * What differs: reposting also has a *feed placement* effect a like does not
 * — the repost event belongs at the top of the home feeds. The optimistic
 * patch only flips the count and the viewer flag; the event's position is
 * server-ordered, so success invalidates the feed queries rather than trying
 * to splice an event in. A refetch landing mid-scroll is the same trade
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
        const snapshot = beginPostPatch(queryClient, postId, (post) => {
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

        if (reposted) {
          // A new repost event belongs at the top of the home feeds at the
          // event's own timestamp; refetch rather than guess the position.
          void queryClient.invalidateQueries({ queryKey: orpc.post.list.key() });
        }
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
