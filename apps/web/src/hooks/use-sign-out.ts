import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { authErrorAtom, signOutAtom } from "@/atoms/auth";
import { m } from "@/paraglide/messages.js";

/**
 * Signs the viewer out and lands them on /login.
 *
 * The one place that decides both. `signOutAtom` (`atoms/auth.ts`) owns the
 * teardown sequence — the server sign-out, the wait for the session store to
 * empty, and `clearViewerState`'s cache/family sweep — and this hook owns what
 * happens after: the navigate and the single error path. Every entry point
 * (header menu, profile page, settings, the post-reset "log in" button) calls
 * this, so a rejected sign-out behaves the same from each: the error is
 * surfaced through `authErrorAtom` (and logged), and the visitor is left on
 * the page they were on.
 *
 * This hook is the sole owner of the post-sign-out destination. The signed-in
 * gate (`use-require-signed-in.ts`) is the fallback for any *other* way a
 * session ends (expiry, a 401), and it no-ops here because /login is in
 * `SIGNED_OUT_PATHS` — so the two never race to different places.
 *
 * A hook, not an atom, because it needs the router's `navigate` (see the
 * "never import the router from an atom" invariant in `apps/web/CONTEXT.md`).
 */
export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  const signOut = useSetAtom(signOutAtom);
  const setAuthError = useSetAtom(authErrorAtom);

  return async () => {
    try {
      await signOut();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out", err);
      setAuthError(m.common_something_went_wrong());
    }
  };
}
