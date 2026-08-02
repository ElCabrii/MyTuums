import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { isSignedInAtom, viewerHandleAtom } from "@/atoms/session";

/**
 * Shared by /login and /register: someone who already has a session has no
 * business on either form, so bounce them to their profile (or home, if
 * there's no handle yet). This has to run in an effect, not during render —
 * `navigate()` updates the router's Transitioner, and doing that while this
 * component is still rendering is exactly the "Cannot update a component
 * while rendering a different component" warning React emits.
 *
 * Depends on the primitives derived from the session (`isSignedInAtom`,
 * `viewerHandleAtom`), not the session object itself, whose identity changes
 * on every fetch/refetch — depending on the object would re-fire this effect,
 * and re-issue the same navigate, on every unrelated session update while a
 * redirect is already in flight.
 *
 * `replace: true` so the back button doesn't just redirect forward again.
 *
 * This is also the entire post-sign-in/sign-up redirect, not just the
 * already-signed-in-on-load case: `signInAtom`/`signUpAtom` (`atoms/auth.ts`)
 * don't navigate themselves — they wait for BetterAuth's session store to
 * update, which flows into `isSignedInAtom` and fires this same effect. That
 * is what fixes `register.tsx`'s old bug, where the submit handler called
 * `goToProfile()` directly *and* this effect fired once the session updated,
 * racing two navigations. Routing through one effect removes the race
 * instead of trying to sequence it.
 *
 * A hook, not an atom: it needs the router's `navigate`, and an atom that
 * imported the router would cycle through `main.tsx`.
 */
export function useRedirectWhenSignedIn(): void {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const handle = useAtomValue(viewerHandleAtom);

  useEffect(() => {
    if (!isSignedIn) return;

    if (handle) {
      void navigate({ to: "/@{$username}", params: { username: handle }, replace: true });
    } else {
      // No handle means an OAuth sign-up that never chose one — there is no
      // profile URL to send them to. `/welcome` rather than `/` because home
      // would immediately bounce them here anyway via `useRequireHandle`, and
      // routing through the intermediate page just adds a visible flash of a
      // feed they cannot yet participate in.
      void navigate({ to: "/welcome", replace: true });
    }
  }, [isSignedIn, handle, navigate]);
}
