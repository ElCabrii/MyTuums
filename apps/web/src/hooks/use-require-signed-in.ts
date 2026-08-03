import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { isSignedInAtom, sessionPendingAtom } from "@/atoms/session";
import { sanitizeRedirect } from "@/lib/redirect";

/**
 * Where a signed-out visitor is allowed to be. Everything else redirects to
 * `/login` — the site is private, like a social media app where nothing
 * renders until you're signed in.
 *
 * The auth pages speak for themselves. `/welcome` is here because it is the
 * completion page for a *signed-in* session that lacks a handle or a date of
 * birth; a signed-out visitor landing on it is sent to `/login` by the page's
 * own guard. The legal pages are exempt because a sign-in gate that will not
 * let someone read the terms and privacy policy they are being asked to
 * accept is its own problem — the same reason `use-require-handle.ts`
 * exempts them.
 */
const ALLOWED_SIGNED_OUT = new Set([
  "/login",
  "/register",
  "/two-factor",
  // `/forgot-password` is an auth page like the ones above; `/reset-password`
  // is exempt on purpose even though it is NOT — resetting your own password
  // from an email link is legitimate while signed in, and the reset revokes
  // every session anyway.
  "/forgot-password",
  "/reset-password",
  "/welcome",
  "/privacy",
  "/terms",
  "/mentions-legales",
]);

/**
 * Holds the site behind a signed-in session.
 *
 * Mounted once in `__root.tsx`, so it covers every route rather than the
 * handful that happen to remember to check — the same reasoning as
 * `use-require-handle.ts` next to it.
 *
 * The `sessionPendingAtom` guard is not optional: on a cold load the first
 * `/get-session` is still in flight when this runs, `isSignedInAtom` reads
 * `false`, and without the guard a signed-in person reloading a deep link
 * would be ejected to `/login`. That is the exact bug documented in
 * `settings.account.tsx`.
 *
 * The check is on the pathname rather than the route id, and the redirect
 * value is the whole `href` (pathname + search + hash) so a deep link with
 * parameters survives the round trip. `replace: true` so the back button
 * doesn't bounce between the gate and the page that triggered it.
 */
export function useRequireSignedIn(): void {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const isSessionPending = useAtomValue(sessionPendingAtom);
  const { pathname, href } = useLocation();

  useEffect(() => {
    if (isSessionPending) return;
    if (isSignedIn) return;
    if (ALLOWED_SIGNED_OUT.has(pathname)) return;

    void navigate({
      to: "/login",
      search: { redirect: sanitizeRedirect(href) ?? undefined },
      replace: true,
    });
  }, [isSessionPending, isSignedIn, pathname, href, navigate]);
}
