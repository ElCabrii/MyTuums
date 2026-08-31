import { atom } from "jotai";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { POST_CACHE_KEYS } from "@/lib/post-cache";

/**
 * Editing the text of one's own post or reply (issue #264) — the dialog
 * target and the mutation behind it.
 *
 * Beside `atoms/post-delete.ts`, not inside `atoms/moderation.ts`, for the
 * same reason that file exists: a self-edit is not a moderation action. It
 * writes no audit row and sends no email, so it must not ride along on the
 * moderation sweeps.
 */

/**
 * Which edit dialog is open, or null. One dialog app-wide, the same
 * identity-holding reasoning as `deletePostDialogAtom` — every card's kebab
 * only sets the target, so two cards for the same post cannot stack two
 * dialogs.
 *
 * The target carries the post's text and attachment count as they were at
 * render time, not just the id: the dialog seeds its textarea from the card
 * the kebab lives on (a prop snapshot, always fresh — the card just rendered
 * it), so it never has to hunt the query caches and cannot fall back to an
 * empty draft because the row was cached nowhere. The attachment count is
 * what lets the composer allow an empty text: a post that carries images may
 * legally have its text cleared (issue #202's cross-field rule, checked
 * against server state).
 */
export interface EditPostTarget {
  postId: string;
  content: string;
  attachmentCount: number;
}

export const editPostDialogAtom = atom<EditPostTarget | null>(null);

/**
 * `post.edit` as a mutation atom. No optimistic patch and no rollback, like
 * `deletePostAtom`: the success path invalidates the caches that hold copies
 * of the row (the dialog blocks the user, so there is no rapid-toggle race
 * worth patching around), and the failure path leaves the card's text alone —
 * the dialog stays open with the error instead.
 *
 * The sweep is `POST_CACHE_KEYS` — the same inventory the delete and
 * moderation removals invalidate, because all three rewrite a cached row's
 * text-bearing fields.
 */
export const editPostAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.post.edit.mutationOptions({
    onSuccess: () => {
      for (const queryKey of POST_CACHE_KEYS) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
});
