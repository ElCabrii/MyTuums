import { atom } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { authClient } from "@/lib/auth-client";
import { profileAtomFamily } from "@/atoms/profile";
import { clearPostFeedFamily } from "@/atoms/post-feed";
import { clearUserListFamily } from "@/atoms/user-list";

/** Set by `signInAtom`/`signUpAtom`/`signOutAtom`; the form's `role="alert"` reads this. */
export const authErrorAtom = atom<string | null>(null);

/** True while a sign-in, sign-up, or sign-out request is in flight. */
export const authPendingAtom = atom(false);

/**
 * Both `signInAtom` and `signUpAtom` deliberately don't navigate on
 * success. BetterAuth's client re-notifies its session nanostore once the
 * request lands (`$sessionSignal`, in `session-atom.mjs`), which flows into
 * `sessionAtom` → `isSignedInAtom` and fires `useRedirectWhenSignedIn` on its
 * own. A manual redirect here would race that effect — exactly the
 * double-navigation bug this migration removes from `register.tsx`. The
 * boolean each action returns is only a success/failure signal for whatever
 * called it (e.g. a test); it is not "the redirect."
 */

type SignInArgs = { identifier: string; password: string };

/** Same email-vs-username split the old inline handler used. */
export const signInAtom = atom(
  null,
  async (_get, set, { identifier, password }: SignInArgs): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const isEmail = identifier.includes("@");
      const res = isEmail
        ? await authClient.signIn.email({ email: identifier.trim(), password })
        : await authClient.signIn.username({ username: identifier.trim(), password });

      if (res.error) {
        set(authErrorAtom, res.error.message || "Invalid credentials. Please try again.");
        return false;
      }
      return true;
    } catch (err) {
      console.error("Login error:", err);
      set(authErrorAtom, "An unexpected error occurred. Please try again.");
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

type SignUpArgs = { username: string; name: string; email: string; password: string };

/** Trims username/name/email the same way `lib/auth-validation.ts` checks them; the password is sent as typed. */
export const signUpAtom = atom(
  null,
  async (_get, set, fields: SignUpArgs): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.signUp.email({
        email: fields.email.trim(),
        password: fields.password,
        name: fields.name.trim(),
        username: fields.username.trim(),
      });

      if (res.error) {
        set(authErrorAtom, res.error.message || "Registration failed. Please check your details.");
        return false;
      }
      return true;
    } catch (err) {
      console.error("Registration error:", err);
      set(authErrorAtom, "An unexpected error occurred. Please try again.");
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/** Sweeps every family's `remove()` across all params it has ever created. */
function clearFamily<Param>(family: { getParams(): Iterable<Param>; remove(p: Param): void }): void {
  for (const param of [...family.getParams()]) family.remove(param);
}

/**
 * Replaces the inline `authClient.signOut()` + `queryClient.clear()` that
 * used to live in `profile-layout.tsx`. Cached profiles and feeds carry
 * viewer-dependent fields (`viewerIsFollowing`, `viewerHasLiked`) behind
 * query keys that carry no viewer identity, so without clearing them here,
 * the next visitor on this browser would keep seeing the previous session's
 * follow/like state until each query happened to refetch on its own.
 *
 * Sign-out is also the one moment nothing in the app is mounted against
 * `profileAtomFamily`/`postFeedFamily`/`userListFamily`, which is why it's
 * safe to sweep every entry directly here instead of the lazy
 * `setShouldRemove` predicate those families explicitly avoid elsewhere —
 * there's nothing currently reading them that a mid-sweep removal could
 * split.
 */
export const signOutAtom = atom(null, async (get, set): Promise<void> => {
  set(authPendingAtom, true);
  try {
    await authClient.signOut();
    get(queryClientAtom).clear();
    clearFamily(profileAtomFamily);
    clearPostFeedFamily();
    clearUserListFamily();
  } finally {
    set(authPendingAtom, false);
  }
});
