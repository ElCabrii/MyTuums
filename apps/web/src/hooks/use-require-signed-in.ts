import { useEffect } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "jotai";
import { isSignedOutPath } from "@my-tuums/api/constants";
import { isSignedInAtom, sessionErrorAtom, sessionPendingAtom } from "@/atoms/session";
import { sanitizeRedirect } from "@/lib/redirect";

/**
 * How long the gate waits before bouncing a signed-out-looking visitor to
 * /login: one `/get-session` round-trip of margin. BetterAuth can transiently
 * settle the store as signed-out (see `sessionPendingAtom`'s comment) while a
 * real session exists; the timer is cancelled the moment a real session
 * lands, so a genuinely signed-out visitor waits this once, ever.
 */
const GATE_CONFIRM_MS = 150;

/**
 * Holds the site behind a signed-in session — except its public surface
 * (`isSignedOutPath`: the auth/legal pages and, since 0.4.0, the `/post/`
 * permalinks, which render read-only for a signed-out visitor).
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
 *
 * The bounce itself is deferred by `GATE_CONFIRM_MS` so a transient
 * signed-out settle that recovers inside one round-trip never navigates at
 * all — the timer is cancelled the instant a real session lands.
 */
export function useRequireSignedIn(): void {
  const navigate = useNavigate();
  const isSignedIn = useAtomValue(isSignedInAtom);
  const isSessionPending = useAtomValue(sessionPendingAtom);
  const sessionError = useAtomValue(sessionErrorAtom);
  const { pathname, href } = useLocation();

  useEffect(() => {
    if (isSessionPending) return;
    if (isSignedIn) return;
    // A settled error is "couldn't reach the server", not "signed out" — wait
    // for a clean answer. The 401 carve-out mirrors the store's own
    // `isUnauthorized` check (`error?.status === 401` in better-auth's
    // session-atom.mjs), the one error that IS a real sign-out. A bare Error
    // from the fetch catch path has no `.status`, so it is blocked too —
    // correct, that one is transient.
    if (sessionError && sessionError.status !== 401) return;
    if (isSignedOutPath(pathname)) return;

    const timeout = setTimeout(() => {
      void navigate({
        to: "/login",
        search: { redirect: sanitizeRedirect(href) ?? undefined },
        replace: true,
      });
    }, GATE_CONFIRM_MS);
    return () => clearTimeout(timeout);
  }, [isSessionPending, isSignedIn, sessionError, pathname, href, navigate]);
}
