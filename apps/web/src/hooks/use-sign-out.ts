import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { signOutAtom } from "@/atoms/auth";

/**
 * Signs the viewer out and lands them on /login.
 *
 * The one place that decides both. `signOutAtom` (`atoms/auth.ts`) owns the
 * teardown sequence — the server sign-out, the wait for the session store to
 * empty, and `clearViewerState`'s cache/family sweep — and this hook owns what
 * happens after: the navigate and the single error path. The three entry
 * points (header menu, profile page, settings) all call this, so a rejected
 * sign-out behaves the same from each: logged, and the visitor left on the
 * page they were on.
 *
 * This hook is the sole owner of the post-sign-out destination. The signed-in
 * gate (`use-require-signed-in.ts`) is the fallback for any *other* way a
 * session ends (expiry, a 401), and it no-ops here because /login is in
 * `SIGNED_OUT_PATHS` — so the two never race to different places.
 *
 * A hook, not an atom: it needs the router's `navigate`, and an atom that
 * imported the router would cycle through `main.tsx` (see the invariant in
 * `apps/web/CONTEXT.md`).
 */
export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  const signOut = useSetAtom(signOutAtom);

  return async () => {
    try {
      await signOut();
      void navigate({ to: "/login" });
    } catch (err) {
      console.error("Failed to sign out", err);
    }
  };
}
