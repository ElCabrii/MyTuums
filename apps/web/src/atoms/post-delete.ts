import { atom } from "jotai";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { POST_CACHE_KEYS } from "@/lib/post-cache";

/**
 * Deleting one's own post (issue #148) — the confirmation target and the
 * mutation behind it.
 *
 * Deliberately not in `atoms/moderation.ts`: a self-delete is not a moderation
 * action. It writes no audit row, sends no email, and has nothing to appeal,
 * so it must not ride along on the moderation sweeps.
 */

/**
 * Which delete-confirmation dialog is open: the post id, or null. One dialog
 * app-wide, the same identity-holding reasoning as `blockDialogAtom` — every
 * card's kebab only sets the target, so two cards for the same post cannot
 * stack two dialogs.
 */
export const deletePostDialogAtom = atom<string | null>(null);

/**
 * `post.delete` as a mutation atom. No optimistic patch and no rollback,
 * unlike like/follow: the server turns the post into a tombstone, which
 * changes its content, its `deleted` flag and its presence in search results
 * at once — more than the entity-scoped patch in `lib/post-cache.ts` is
 * shaped to express, and with no round trip worth racing (the card is behind
 * a confirmation dialog, not a rapid toggle).
 *
 * The sweep is `POST_CACHE_KEYS` — the same inventory the moderation removal
 * invalidates, because the two produce the same kind of cached-row rewrite:
 * feeds, threads and post search all hold copies of the row that just changed.
 */
export const deletePostAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.post.delete.mutationOptions({
    onSuccess: () => {
      for (const queryKey of POST_CACHE_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
});
