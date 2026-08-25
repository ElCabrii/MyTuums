import { atom } from "jotai";
import { atomFamily } from "jotai-family";
import type { MentionToken } from "@/lib/composer-mentions";

/** The transient mention-completion state for one mounted composer. */
export interface ComposerMentionState {
  token: MentionToken | null;
  highlight: number;
  open: boolean;
}

const initialMentionState: ComposerMentionState = {
  token: null,
  highlight: -1,
  open: false,
};

/**
 * Mention state is keyed by editor identity rather than held in the
 * stateless form chrome. A post composer, a reply composer, and the bio
 * editor can therefore keep independent caret/highlight state while sharing
 * the same UI — each passes its own `mentionScope`.
 */
export const composerMentionAtomFamily = atomFamily((scope: string) => {
  // The family map owns the scope key; keeping the callback parameter named
  // documents that identity even though the atom value itself is the same.
  void scope;
  return atom<ComposerMentionState>({ ...initialMentionState });
});

/** Drops transient completion state when the signed-in viewer changes. */
export function clearComposerMentionFamilies(): void {
  for (const key of composerMentionAtomFamily.getParams()) composerMentionAtomFamily.remove(key);
}
