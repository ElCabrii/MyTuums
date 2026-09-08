import { atom } from "jotai";
import { legalConsentRequiredAtom } from "@/atoms/legal-consent";
import {
  isSignedInAtom,
  needsCompletionAtom,
  sessionErrorAtom,
  sessionPendingAtom,
} from "@/atoms/session";

/** Hold protected reads until the session confirms consent and onboarding. */
export const protectedProductReadyAtom = atom(
  (get) => get(isSignedInAtom) && !get(legalConsentRequiredAtom) && !get(needsCompletionAtom),
);
/** Public reads allow known anonymous viewers, not unresolved null sessions. */
export const publicReadReadyAtom = atom((get) => {
  if (get(isSignedInAtom)) return get(protectedProductReadyAtom);
  return !get(sessionPendingAtom) && !get(sessionErrorAtom);
});
