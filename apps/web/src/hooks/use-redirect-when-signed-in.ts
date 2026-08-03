import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import {
  isSignedInAtom,
  needsDobAtom,
  viewerHandleAtom,
} from "@/atoms/session";
import { offerTwoFactorAtom } from "@/atoms/onboarding";
import { sanitizeRedirect } from "@/lib/redirect";

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
 *
 * `redirectFromSearch` is the `?redirect=` param the signed-in gate set
 * (`use-require-signed-in.ts`): when present and sanitized, a *complete*
 * session is sent there instead of the profile. The completeness guard
 * (`handle && !needsDob`) exists because dumping a half-finished session on
 * a page it will instantly bounce out of is a visible flash — and the
 * `/welcome` page does not set the param, so a session completing there
 * still lands on its profile.
 */
export function useRedirectWhenSignedIn(redirectFromSearch?: string | null): void {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const handle = useAtomValue(viewerHandleAtom);
  const needsDob = useAtomValue(needsDobAtom);
  const offerTwoFactor = useAtomValue(offerTwoFactorAtom);

  useEffect(() => {
    if (!isSignedIn) return;

    // A sign-up that has just completed goes to `/welcome` for the two-factor
    // offer instead of straight to its profile. Ahead of the `?redirect=`
    // branch on purpose: the offer is shown once, and losing it to a
    // `?redirect=` someone happened to arrive with would mean an account
    // silently never gets asked. `/welcome` renders the offer only when the
    // session is otherwise complete, so an OAuth sign-up still sees the handle
    // form first — and this flag is never set for one anyway.
    //
    // Not a redirect loop: `/welcome`'s Skip and its successful enrolment both
    // clear the flag, at which point this effect re-runs and falls through to
    // the rules below.
    if (offerTwoFactor) {
      void navigate({ to: "/welcome", replace: true });
      return;
    }

    const redirect = sanitizeRedirect(redirectFromSearch);
    if (redirect && handle && !needsDob) {
      void navigate({ href: redirect, replace: true });
      return;
    }

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
  }, [isSignedIn, handle, needsDob, offerTwoFactor, navigate, redirectFromSearch]);
}
