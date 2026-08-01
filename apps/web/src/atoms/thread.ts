import { atomFamily } from "jotai-family";
import { atomWithQuery } from "jotai-tanstack-query";
import { orpc, retryUnlessClientError } from "@/lib/orpc";

/**
 * One query atom per post id — the focused post plus its ancestor chain, as
 * rendered by `/post/$postId`.
 *
 * Same shape and same reasoning as `profileAtomFamily`: a primitive string
 * param so the family stays a `Map` lookup rather than a linear scan behind
 * an `areEqual` comparator, and no `setShouldRemove` because it is evaluated
 * lazily at read time and could hand two components reading the same id two
 * different atoms. Cleanup happens at sign-out instead.
 *
 * The post's *replies* are not here — they are paginated, and
 * `postFeedAtom({ parentId })` serves them off `post.list` so they share the
 * feed cache the optimistic-like sweep already covers.
 */
export const threadAtomFamily = atomFamily((postId: string) =>
  atomWithQuery(() => ({
    // `retry` is spread in after `queryOptions()` for the same reason as in
    // `atoms/profile.ts`: oRPC's trailing spread of its own options would
    // otherwise clobber it back to the default, and a deleted post would be
    // retried on its way to a 404.
    ...orpc.post.thread.queryOptions({ input: { postId } }),
    retry: retryUnlessClientError,
  })),
);

/**
 * Drops every entry this family has created. Called from `signOutAtom` for
 * the same reason as `clearPostFeedFamily`: the thread payload carries
 * viewer-dependent `viewerHasLiked` behind a query key with no viewer
 * identity in it, so leaving it cached would show the next viewer the
 * previous one's like state.
 */
export function clearThreadFamily(): void {
  for (const key of [...threadAtomFamily.getParams()]) threadAtomFamily.remove(key);
}
