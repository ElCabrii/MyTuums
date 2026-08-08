import { useEffect } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { isSignedInAtom, needsDobAtom, viewerHandleAtom } from "@/atoms/session";
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
  const router = useRouter();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const handle = useAtomValue(viewerHandleAtom);
  const needsDob = useAtomValue(needsDobAtom);
  const offerTwoFactor = useAtomValue(offerTwoFactorAtom);

  useEffect(() => {
    if (!isSignedIn) return;

    // Read imperatively, deliberately NOT through a reactive location
    // subscription: this effect must fire on session changes only. Subscribing
    // to the location would re-run it on every navigation, and it would
    // ping-pong against `useRequireHandle` — profile → /welcome → profile →
    // … — for sessions that are incomplete (the E2E suite caught exactly
    // that as a session landing on its profile instead of /welcome). A stale
    // pathname by a few milliseconds is fine for the self-navigation guard
    // below.
    const { pathname } = router.state.location;

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
      // Already on `/welcome`? The offer is what this page is rendering right
      // now — navigating to the same path would remount the route, and the
      // unmount resets the page's drafts (`resetHandleClaimAtom` in
      // atoms/handle-claim.ts), discarding a handle the person has already
      // typed. The guard matters the same way in the handle-less branch below.
      if (pathname !== "/welcome") void navigate({ to: "/welcome", replace: true });
      return;
    }

    const redirect = sanitizeRedirect(redirectFromSearch);
    if (redirect && handle && !needsDob) {
      void navigate({ href: redirect, replace: true });
      return;
    }

    if (handle) {
      void navigate({ to: "/@{$username}", params: { username: handle }, replace: true });
    } else if (pathname !== "/welcome") {
      // No handle means an OAuth sign-up that never chose one — there is no
      // profile URL to send them to. `/welcome` rather than `/` because home
      // would immediately bounce them here anyway via `useRequireHandle`, and
      // routing through the intermediate page just adds a visible flash of a
      // feed they cannot yet participate in. Skipped when the session is
      // already there — same remount/cleared-draft reason as the offer branch,
      // and the E2E suite caught it as a lost fill before a handle claim.
      //
      // `.catch(() => {})`: the stub route tree in the component tests has no
      // `/welcome`, so the navigate rejects there; the real tree never does.
      // Handled so the rejection can't surface as an unhandled rejection in
      // the test process.
      void navigate({ to: "/welcome", replace: true }).catch(() => {});
    }
  }, [isSignedIn, handle, needsDob, offerTwoFactor, navigate, redirectFromSearch, router]);
}
