import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { POST_CACHE_KEYS } from "@/lib/post-cache";

/**
 * Editing the text of one's own post or reply (issue #264). The lightweight
 * target lives in `dialog-targets.ts`; this module owns the mutation.
 *
 * Beside `atoms/post-delete.ts`, not inside `atoms/moderation.ts`, for the
 * same reason that file exists: a self-edit is not a moderation action. It
 * writes no audit row and sends no email, so it must not ride along on the
 * moderation sweeps.
 */

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
