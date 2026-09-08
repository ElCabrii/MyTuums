import { atom } from "jotai";
import type { Post } from "@/lib/orpc";

// Keep dialog identities free of runtime mutation and UI imports: the root
// observes them before any dialog implementation has been requested.

/**
 * The target a report dialog is open on. A post report carries the post
 * itself — already loaded in the feed cache when the kebab opened the dialog
 * — so the dialog can preview what is being flagged without a second fetch,
 * and without a fetch race against a post being removed between the card and
 * the dialog. A user report carries no post; there is nothing to preview.
 */
export type ReportDialogTarget =
  { targetType: "post"; targetId: string; post: Post } | { targetType: "user"; targetId: string };

/** Which report dialog is open: the target being reported, or null. */
export const reportDialogAtom = atom<ReportDialogTarget | null>(null);

/** Which block-confirm dialog is open: the user to block, or null. */
export const blockDialogAtom = atom<{ userId: string; handle: string } | null>(null);

/**
 * Which delete-confirmation dialog is open: the post id, or null. One dialog
 * app-wide, the same identity-holding reasoning as `blockDialogAtom` — every
 * card's kebab only sets the target, so two cards for the same post cannot
 * stack two dialogs.
 */
export const deletePostDialogAtom = atom<string | null>(null);

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

/** Which post the quote dialog is quoting: the full row, or null when closed. */
export const quoteDialogAtom = atom<Post | null>(null);
