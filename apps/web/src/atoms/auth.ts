import { atom } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { authClient, type SocialProviderId } from "@/lib/auth-client";
import { waitForSignedOut } from "@/lib/session-sync";
import { profileAtomFamily } from "@/atoms/profile";
import { clearPostFeedFamily } from "@/atoms/post-feed";
import { clearUserListFamily } from "@/atoms/user-list";
import { clearLikeFamilies } from "@/atoms/like";
import { clearFollowFamilies } from "@/atoms/follow";
import { clearThreadFamily } from "@/atoms/thread";
import { clearReplyFamilies } from "@/atoms/reply-composer";
import { m } from "@/paraglide/messages.js";

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
 * double-navigation bug this migration removes from `register.tsx`. What each
 * action returns is a result for whatever called it (e.g. a test); it is not
 * "the redirect."
 *
 * The one exception is `SignInOutcome`'s `"two-factor"`, and it is not really
 * an exception: that case produces *no session at all*, so there is nothing
 * for the effect to react to and the route has to act on the value. See below.
 */

type SignInArgs = { identifier: string; password: string };

/**
 * What a sign-in attempt actually ended in.
 *
 * `"two-factor"` is the reason this isn't a boolean any more: a correct
 * password on a 2FA account produces **no session** — BetterAuth issues a
 * challenge and discards the pending session — so `isSignedInAtom` never
 * flips and `useRedirectWhenSignedIn` never fires. Nothing would happen at all
 * unless the outcome is reported back to the caller, which is why the route
 * navigates on this value. See the note on `twoFactorClient()` in
 * `lib/auth-client.ts` for why the plugin's own redirect options aren't used.
 */
export type SignInOutcome =
  | { status: "signed-in" }
  | { status: "two-factor"; methods: string[] }
  | { status: "failed" };

/** What BetterAuth returns in place of a session when it issues a 2FA challenge. */
interface TwoFactorChallengeResponse {
  twoFactorRedirect?: boolean;
  twoFactorMethods?: string[];
}

/**
 * Reads an error code off a BetterAuth client response.
 *
 * `res.error` is a union in which only some members carry `code`, so a direct
 * `res.error.code` does not compile. This narrows once instead of at each of
 * the three places that need to tell a user-cancelled WebAuthn ceremony apart
 * from a real failure.
 */
export function errorCodeOf(error: object): string | undefined {
  return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/**
 * Which second factors the pending challenge accepts, as reported by the
 * sign-in response (e.g. `["totp"]`, `["totp", "otp"]`).
 *
 * Empty when `/two-factor` is reached directly — a reload, or a bookmark —
 * which the page treats as "offer everything" rather than an error: the
 * challenge itself lives in a server-side cookie that outlives this atom, so
 * the person can still complete it.
 */
export const twoFactorMethodsAtom = atom<string[]>([]);

/** Same email-vs-username split the old inline handler used. */
export const signInAtom = atom(
  null,
  async (_get, set, { identifier, password }: SignInArgs): Promise<SignInOutcome> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    set(twoFactorMethodsAtom, []);
    try {
      const isEmail = identifier.includes("@");
      const res = isEmail
        ? await authClient.signIn.email({ email: identifier.trim(), password })
        : await authClient.signIn.username({ username: identifier.trim(), password });

      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return { status: "failed" };
      }

      // The inferred success type describes the *session* response only —
      // `twoFactorRedirect` is substituted for it at runtime when a challenge
      // is issued, and the plugin does not widen the type to say so (its own
      // docs call this out). Reading it through a local shape keeps the
      // assertion here rather than letting a cast on `res` leak an optimistic
      // type into everything downstream.
      const data = res.data as TwoFactorChallengeResponse;
      if (data.twoFactorRedirect) {
        const methods = data.twoFactorMethods ?? [];
        set(twoFactorMethodsAtom, methods);
        return { status: "two-factor", methods };
      }

      return { status: "signed-in" };
    } catch (err) {
      console.error("Login error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return { status: "failed" };
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/**
 * Hands the browser to an OAuth provider. Resolves only if the handoff fails —
 * on success the document navigates away and nothing after it runs.
 *
 * `callbackURL` is home rather than a profile because a *new* social account
 * has no handle to build a profile URL from; `useRequireHandle` then moves it
 * to `/welcome`. `errorCallbackURL` brings a refused or cancelled consent back
 * to the form, where `authErrorAtom` can say so, instead of a bare error page.
 *
 * **Both must be absolute.** BetterAuth echoes these back as the `Location` of
 * the redirect its *own* server issues at the end of `/api/auth/callback/:id`,
 * so a relative `"/"` resolves against the API origin rather than the web
 * app's. Same-origin in production that is invisible; in dev, where the web
 * app is on :5173 and the API on :3001, it drops you on the API server —
 * which serves no HTML and answers "Not found". `window.location.origin` is
 * the web origin in both cases, and matches the `trustedOrigins` allowlist in
 * packages/auth (BetterAuth rejects a redirect target outside it, so this
 * cannot become an open redirect).
 */
export const signInWithProviderAtom = atom(
  null,
  async (_get, set, provider: SocialProviderId): Promise<void> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.signIn.social({
        provider,
        callbackURL: `${window.location.origin}/`,
        errorCallbackURL: `${window.location.origin}/login`,
      });
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      }
    } catch (err) {
      console.error("Social sign-in error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/**
 * Signs in with a passkey.
 *
 * The passkey plugin never rejects and never sets `throw` — a cancelled or
 * failed WebAuthn ceremony comes back as `{ error }` on a resolved promise —
 * so the error branch below is the only one that ever runs on failure.
 *
 * A cancelled prompt is silent on purpose. Dismissing the browser's passkey
 * sheet is a normal way to change your mind, and surfacing "Auth cancelled" in
 * the form's alert would read as a malfunction.
 */
export const signInWithPasskeyAtom = atom(null, async (_get, set): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.signIn.passkey();
    if (res?.error) {
      if (errorCodeOf(res.error) !== "AUTH_CANCELLED") {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      }
      return false;
    }
    return true;
  } catch (err) {
    console.error("Passkey sign-in error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

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
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }
      return true;
    } catch (err) {
      console.error("Registration error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
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
    // Not redundant with the line above — see `lib/session-sync.ts`. Without
    // it the caller navigates while the session store still reports the old
    // user, and `useRedirectWhenSignedIn` bounces them back.
    await waitForSignedOut();
    get(queryClientAtom).clear();
    clearFamily(profileAtomFamily);
    clearPostFeedFamily();
    clearUserListFamily();
    clearThreadFamily();
    // Reply drafts are per-post and in-memory; they belong to the person who
    // typed them, not to the browser.
    clearReplyFamilies();
    // The like/follow families hold per-entity intent as well as mutation
    // atoms, and intent is viewer-relative — a stale `true` would make the
    // next viewer's first response look superseded and be dropped.
    clearLikeFamilies();
    clearFollowFamilies();
    // Sign-in state that belongs to the session that just ended: a pending
    // challenge's methods would otherwise still be on screen for whoever signs
    // in next on this browser.
    set(twoFactorMethodsAtom, []);
    set(authErrorAtom, null);
  } finally {
    set(authPendingAtom, false);
  }
});
