import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { isSignedInAtom, sessionPendingAtom } from "@/atoms/session";
import { promptOneTap } from "@/lib/one-tap";

/**
 * Offers Google One Tap on the sign-in pages.
 *
 * Waits for the session to resolve before prompting: `sessionPendingAtom` is
 * true on first paint, and prompting during that window would show "sign in
 * with Google" to somebody who is already signed in and about to be redirected
 * away by `useRedirectWhenSignedIn`.
 *
 * The effect deliberately does not depend on anything that changes afterwards,
 * so the prompt is offered once per visit rather than re-armed on every
 * session refetch — Google's own exponential backoff assumes it is asked once.
 */
export function useOneTap(): void {
  const isSignedIn = useAtomValue(isSignedInAtom);
  const isPending = useAtomValue(sessionPendingAtom);

  useEffect(() => {
    if (isPending || isSignedIn) return;
    promptOneTap();
  }, [isPending, isSignedIn]);
}
