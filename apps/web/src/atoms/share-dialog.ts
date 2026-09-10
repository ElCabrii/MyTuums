import { atom } from "jotai";
import type { Post } from "@/lib/orpc";

/**
 * The share dialog (issue #307): which post the open dialog is sharing, or
 * null when closed.
 *
 * The target holds the whole `Post` row, not just an id, because the dialog
 * previews the post — the same identity-atom shape as `quoteDialogAtom`, and
 * in-memory for the same reason: there is exactly one dialog, its lifetime is
 * bounded by being open, and a share target has nothing to persist.
 */
export const shareDialogAtom = atom<Post | null>(null);
