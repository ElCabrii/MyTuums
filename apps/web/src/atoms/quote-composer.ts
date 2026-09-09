import { quoteDialogAtom } from "@/atoms/dialog-targets";
import { atom } from "jotai";
import { atomWithMutation, queryClientAtom } from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import { store } from "@/lib/store";
import { clearVideoDraft } from "@/atoms/video-upload";
import type { ComposerAttachment } from "./composer.js";

/**
 * The quote composer (issue #261): the in-memory draft and `post.create`
 * mutation. Its lightweight target lives in `dialog-targets.ts`.
 *
 * The dialog target holds the whole `Post` row, not just an id, because the
 * dialog renders the embedded quoted card — the same `quoted`-less shape the
 * composer previews from. In-memory rather than persisted for the same reason
 * as the reply drafts (`atoms/reply-composer.ts`): there is exactly one
 * dialog, its lifetime is bounded by the dialog being open, and a persisted
 * quote draft would outlive the post it quotes with nothing to evict it.
 */

/** The quote dialog's half-typed text — one draft, one dialog. */
export const quoteDraftAtom = atom("");

/** The quote dialog's selected images, in memory until submit or removal. */
export const quoteAttachmentsAtom = atom<ComposerAttachment[]>([]);

/**
 * `post.create` with `quotedPostId`. Like the reply composer there is no
 * optimistic patch: the new quote's position in a keyset-ordered feed is
 * server-owned, and the dialog is a deliberate flow, not a rapid toggle.
 *
 * Success closes the dialog and resets the draft through the module-scope
 * store (the same contract `createPostAtom` documents: `atomWithMutation`'s
 * options factory is handed a `Getter` only).
 */
export const createQuoteAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);
  return orpc.post.create.mutationOptions({
    onSuccess: async () => {
      store.set(quoteDraftAtom, "");
      store.set(quoteAttachmentsAtom, []);
      clearVideoDraft("quote-composer");
      store.set(quoteDialogAtom, null);

      // A new quote is a post in the home feeds and the author's profile;
      // its position depends on server ordering — refetch rather than splice.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.post.list.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.video.pending.key() }),
      ]);
    },
  });
});

/** Drops the dialog's own state after sign-out. See `clearViewerState`. */
export function clearQuoteComposerState(): void {
  store.set(quoteDialogAtom, null);
  store.set(quoteDraftAtom, "");
  store.set(quoteAttachmentsAtom, []);
}
