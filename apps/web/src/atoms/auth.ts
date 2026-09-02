import { atom } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { clearViewerState } from "@/atoms/session-teardown";
import { authClient, type SocialProviderId } from "@/lib/auth-client";
import { waitForSignedOut } from "@/lib/session-sync";
import { dateOfBirthToIso } from "@/lib/auth-validation";
import { LEGAL_VERSION, normalizeUsername } from "@my-tuums/auth/rules";
import { postSignInDestination, sanitizeDestination } from "@/lib/redirect";
import { offerTwoFactorAtom } from "@/atoms/onboarding";
import { m } from "@/paraglide/messages.js";

/** Set by `signInAtom`/`signUpAtom`/`signOutAtom`/`requestPasswordResetAtom`/`resetPasswordAtom`; the form's `role="alert"` reads this. */
export const authErrorAtom = atom<string | null>(null);

/** True while a sign-in, sign-up, or sign-out request is in flight. */
export const authPendingAtom = atom(false);

/**
 * The email address awaiting verification, when a flow has one in hand.
 *
 * Set by `signUpAtom` on a successful password sign-up (the address just
 * entered) and by `signInAtom` when an unverified account tries to sign in
 * with an email identifier. The `/verify-email` route reads it to offer a
 * resend without asking for the address again. `null` when unknown — a
 * reload of the pending page, or a sign-in by username — so the route then
 * shows the check-your-email state without a resend button (the server's
 * `sendOnSignIn` already re-sent the link in the username case).
 *
 * In memory only, deliberately: it is the address of the sign-up in progress,
 * not something to persist across sessions.
 */
export const verifyEmailAtom = atom<string | null>(null);

/**
 * True once a resend from `/verify-email` has been accepted. The route shows a
 * generic "if an account exists, we've sent a new link" confirmation on it —
 * generic on purpose, because `sendVerificationEmail` answers `{ status: true }`
 * whether or not the address has an account, and so must the UI (issue #172:
 * the flow must not become an account-enumeration oracle).
 */
export const verifyEmailSentAtom = atom(false);

/**
 * The absolute URL a verification link lands on, carrying the pre-login
 * destination when there is one.
 *
 * Absolute for the reason on `SignUpEmailBody.callbackURL`: Better Auth
 * resolves a relative callback against the API origin, which serves no HTML in
 * dev. The `?redirect=` rides *inside* it so the trip to a protected page
 * survives verification even when the link is opened in a different browser,
 * where no atom or history entry exists to remember it — the same reason
 * `/login` carries the param to `/two-factor`.
 *
 * Sanitized here rather than trusted: it reaches this function from a URL, and
 * an unsanitized value would be baked into an emailed link. `sanitizeDestination`
 * rejects anything that is not a single-slash-relative path, so this cannot
 * become an open redirect.
 */
function verifyEmailCallbackURL(redirect?: string | null): string {
  const base = `${window.location.origin}/verify-email`;
  const safe = sanitizeDestination(redirect);
  return safe ? `${base}?redirect=${encodeURIComponent(safe)}` : base;
}

/**
 * Requests a fresh verification email for the address pending verification.
 *
 * The address comes from `verifyEmailAtom` (set by the sign-up or the
 * unverified sign-in recovery), so the pending screen can offer a resend
 * without a second field. `callbackURL` is absolute for the same reason every
 * other callback URL in this module is — see `SignUpEmailBody.callbackURL`.
 *
 * Returns `true` only for transport-level success; the route shows the generic
 * confirmation regardless, matching `requestPasswordResetAtom`'s shape. The
 * server's `/send-verification-email` rate limit (packages/auth/src/index.ts)
 * is the abuse control, not this atom.
 */
/** What the `/verify-email` resend button hands the atom: the address, and where to go after. */
interface ResendVerificationArgs {
  email: string;
  redirect?: string | undefined;
}

export const resendVerificationEmailAtom = atom(
  null,
  async (_get, set, { email, redirect }: ResendVerificationArgs): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.sendVerificationEmail({
        email,
        callbackURL: verifyEmailCallbackURL(redirect),
      });
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }
      set(verifyEmailSentAtom, true);
      return true;
    } catch (err) {
      console.error("Verification email resend error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/**
 * True once a reset email has been sent; `/forgot-password` swaps to the
 * "check your email" panel on it. A plain flag rather than a string so the
 * route never shows anything but the generic message — see
 * `requestPasswordResetAtom` below.
 */
export const forgotPasswordSentAtom = atom(false);

/** True once a password reset succeeded; `/reset-password` shows the success panel on it. */
export const resetPasswordDoneAtom = atom(false);

/** True when the server rejected the reset token; `/reset-password` swaps to the invalid-link panel on it. */
export const resetPasswordInvalidAtom = atom(false);

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
 *
 * `"banned"` is the same shape of exception for a different reason (issue
 * #74): the admin plugin's `session.create.before` hook throws `BANNED_USER`
 * instead of returning a session, so this is also not something
 * `useRedirectWhenSignedIn` can react to. `/login` navigates to `/banned` on
 * this value instead of setting `authErrorAtom` — a banned account isn't
 * "try again", it's a different screen.
 *
 * `"verify-email"` (issue #172) is the recovery half of email verification: a
 * correct password on an unverified account produces no session — Better Auth
 * rejects the sign-in with `EMAIL_NOT_VERIFIED` and `sendOnSignIn` re-sends the
 * verification email — so `isSignedInAtom` never flips. `/login` navigates to
 * `/verify-email` on this value so the person lands on the check-your-email
 * screen rather than a banner that says "try again".
 */
export type SignInOutcome =
  | { status: "signed-in" }
  | { status: "two-factor"; methods: string[] }
  | { status: "banned" }
  | { status: "verify-email" }
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
/** The error members BetterAuth's client responses carry, when they carry them. */
interface BetterAuthClientError {
  code?: string;
  message?: string;
}

export function errorCodeOf(error: BetterAuthClientError): string | undefined {
  return error.code;
}

/** The sign-up body incl. the additional dateOfBirth field the server accepts. */
interface SignUpEmailBody {
  email: string;
  password: string;
  name: string;
  username: string;
  dateOfBirth?: string;
  legalAcceptedAt?: string;
  legalVersion?: string;
  /**
   * Where the verification email link lands after the person clicks it. The
   * server builds the link as `/api/auth/verify-email?token=…&callbackURL=…`
   * and redirects there on success (and to `callbackURL?error=…` on a bad
   * token), so this is what makes a verified sign-in arrive at `/verify-email`
   * rather than `/`. Absolute, like every other callback URL in this module:
   * Better Auth resolves a relative one against the API origin, which in dev
   * serves no HTML. `webOrigin` is in `trustedOrigins`, so it passes the
   * `originCheck` the verify endpoint applies.
   */
  callbackURL?: string;
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

/**
 * Signs in with an email or a username and reports the outcome as a value;
 * it never navigates — the redirect effect owns that (see the note above).
 */
export const signInAtom = atom(
  null,
  async (_get, set, { identifier, password }: SignInArgs): Promise<SignInOutcome> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    set(twoFactorMethodsAtom, []);
    try {
      const isEmail = identifier.includes("@");
      // Deliberately NO `callbackURL` here, even though `sendOnSignIn` uses it
      // as the landing page of the verification link it re-sends. On the
      // *success* path better-auth echoes `callbackURL` back as
      // `{ redirect: true, url }`, and its always-on `redirectPlugin`
      // (client/fetch-plugins.mjs) hard-assigns `window.location.href` to it —
      // so passing one here would send every ordinary sign-in to
      // `/verify-email` and blow away the SPA's own redirect. The resend's
      // link therefore keeps better-auth's `/` default; a *valid* one still
      // verifies and signs in, and `resendVerificationEmailAtom` — the resend
      // this app actually drives — does pass `/verify-email`.
      const res = isEmail
        ? await authClient.signIn.email({ email: identifier.trim(), password })
        : await authClient.signIn.username({ username: identifier.trim(), password });

      if (res.error) {
        // See the `"banned"` case's docblock on `SignInOutcome` above: the
        // route navigates on this instead of showing it in the banner.
        if (errorCodeOf(res.error) === "BANNED_USER") {
          return { status: "banned" };
        }
        // The unverified-account recovery path (issue #172): a correct
        // password on an account whose email was never verified. Better Auth
        // rejects the sign-in (no session) and `sendOnSignIn` has already
        // re-sent the verification email, so this navigates to the
        // check-your-email screen rather than a "try again" banner.
        //
        // The username branch CLEARS the address rather than leaving it: a
        // sign-up followed by a username sign-in for a different account would
        // otherwise strand the first address here, and the resend button would
        // mail the wrong one. Cleared, the page shows the pending state with no
        // resend — correct, since `sendOnSignIn` just sent the link anyway.
        if (errorCodeOf(res.error) === "EMAIL_NOT_VERIFIED") {
          set(verifyEmailAtom, isEmail ? identifier.trim() : null);
          return { status: "verify-email" };
        }
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return { status: "failed" };
      }

      // The inferred success type describes the *session* response only —
      // `twoFactorRedirect` is substituted for it at runtime when a challenge
      // is issued, and the plugin does not widen the type to say so (its own
      // docs call this out). Reading it through a local shape keeps the
      // assertion here rather than letting a cast on `res` leak an optimistic
      // type into everything downstream.
      // SAFETY: twoFactorRedirect is substituted for the session shape at runtime
      // (documented upstream); this local shape narrows exactly the fields read.
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
      // The `?redirect=` param set by the signed-in gate, read through the
      // shared gate in lib/redirect rather than the raw search param (an atom
      // that imported the router would cycle through main.tsx). It travels as
      // the callback target so the person lands where they were headed — and
      // as part of `errorCallbackURL` so a refused consent comes back to the
      // form with the destination intact.
      const destination = postSignInDestination();
      const res = await authClient.signIn.social({
        provider,
        callbackURL: `${window.location.origin}${destination ?? "/"}`,
        errorCallbackURL: `${window.location.origin}/login${
          destination ? `?redirect=${encodeURIComponent(destination)}` : ""
        }`,
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
 * What a passkey sign-in attempt ended in. `SignInOptions` navigates to
 * `/banned` on `"banned"`, the same reaction `SignInOutcome`'s case gets on
 * the password/username path — see that type's docblock (issue #74).
 */
export type PasskeySignInOutcome = "signed-in" | "banned" | "failed";

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
export const signInWithPasskeyAtom = atom(
  null,
  async (_get, set): Promise<PasskeySignInOutcome> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) {
        // The `session.create.before` hook throws this for a banned account
        // regardless of sign-in method (issue #74) — a passkey is no
        // exception, so this gets the same navigate-away treatment as
        // `signInAtom`'s `"banned"` case rather than the generic banner.
        if (errorCodeOf(res.error) === "BANNED_USER") {
          return "banned";
        }
        if (errorCodeOf(res.error) !== "AUTH_CANCELLED") {
          set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        }
        return "failed";
      }
      return "signed-in";
    } catch (err) {
      console.error("Passkey sign-in error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return "failed";
    } finally {
      set(authPendingAtom, false);
    }
  },
);

type SignUpArgs = {
  username: string;
  name: string;
  email: string;
  password: string;
  /** "YYYY-MM-DD" from the form; converted to the UTC-midnight wire format here. */
  dateOfBirth: string;
  /** The checked consent box; only true sends the server-side acceptance evidence. */
  legalAccepted: boolean;
  /**
   * The pre-login destination from `/register?redirect=`, baked into the
   * verification link so the trip to a protected page survives verification —
   * including when the link is opened in a different browser.
   */
  redirect?: string | undefined;
};

/**
 * Registers a new account with email and password.
 * Trims username/name/email the same way `lib/auth-validation.ts` checks them; the password is sent as typed.
 */
export const signUpAtom = atom(null, async (_get, set, fields: SignUpArgs): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const body: SignUpEmailBody = {
      email: fields.email.trim(),
      password: fields.password,
      name: fields.name.trim(),
      username: normalizeUsername(fields.username.trim()),
      dateOfBirth: dateOfBirthToIso(fields.dateOfBirth),
      // Absolute, and carrying the pre-login destination when there is one —
      // see `verifyEmailCallbackURL`.
      callbackURL: verifyEmailCallbackURL(fields.redirect),
    };
    if (fields.legalAccepted) {
      body.legalAcceptedAt = new Date().toISOString();
      body.legalVersion = LEGAL_VERSION;
    }
    // SAFETY: The server accepts dateOfBirth and callbackURL
    // (packages/auth/src/index.ts additionalFields + Better Auth's sign-up
    // route); better-auth 1.6.25's client types don't surface either on the
    // sign-up body — see lib/auth-client.ts's sessionStore cast.
    const res = await authClient.signUp.email(body);

    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    // A successful password sign-up no longer creates a session (issue #172:
    // `requireEmailVerification`), so there is nothing for
    // `useRedirectWhenSignedIn` to react to — the register route navigates to
    // `/verify-email` on this `true`. Hold onto the address so that screen can
    // offer a resend without asking for it again.
    set(verifyEmailAtom, body.email);
    return true;
  } catch (err) {
    console.error("Registration error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

/**
 * Signs the viewer out and discards everything on this browser that was
 * theirs.
 *
 * Replaces the inline `authClient.signOut()` + `queryClient.clear()` that
 * used to live in `profile-layout.tsx`. *What* has to be discarded — the
 * query cache and every viewer-keyed atom family — is the inventory owned by
 * `atoms/session-teardown.ts`, not by this atom: this is the one place in the
 * app that can say "the session is over", and it should not also have to know
 * which families exist.
 */
export const signOutAtom = atom(null, async (get, set): Promise<void> => {
  set(authPendingAtom, true);
  try {
    await authClient.signOut();
    // Not redundant with the line above — see `lib/session-sync.ts`. Without
    // it the caller navigates while the session store still reports the old
    // user, and `useRedirectWhenSignedIn` bounces them back.
    await waitForSignedOut();
    // Clears the QueryClient synchronously, then schedules independent
    // best-effort sweeps of the heavier family modules. No lazy chunk can
    // block sign-out completion, while the signed-out UI never sees the old
    // cache.
    clearViewerState(get(queryClientAtom));
    // Sign-in state that belongs to the session that just ended: a pending
    // challenge's methods would otherwise still be on screen for whoever signs
    // in next on this browser.
    set(twoFactorMethodsAtom, []);
    // A sign-up offer that was never answered belongs to that sign-up, not to
    // whoever signs in next on this browser.
    set(offerTwoFactorAtom, false);
    set(authErrorAtom, null);
  } finally {
    set(authPendingAtom, false);
  }
});

/**
 * Requests a password-reset email for an address.
 *
 * Returns `true` only for transport-level success. The server answers
 * `{status: true}` for unknown emails too — deliberately, so an attacker
 * cannot tell which addresses have accounts — so the route shows the generic
 * "check your email" panel regardless of this boolean; the two differ only
 * when the request itself failed (rate limited, network).
 *
 * `redirectTo` must be absolute: BetterAuth validates the token on its own
 * origin and then resolves the callback against its own baseURL, so a relative
 * "/reset-password" would bounce the browser to the API server — which serves
 * no HTML. Same reasoning as `signInWithProviderAtom` above; the web origin
 * also matches `trustedOrigins`, so this cannot become an open redirect.
 */
export const requestPasswordResetAtom = atom(
  null,
  async (_get, set, email: string): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: new URL("/reset-password", window.location.origin).href,
      });
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }
      set(forgotPasswordSentAtom, true);
      return true;
    } catch (err) {
      console.error("Password reset request error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/** What a password-reset attempt ended in; the route renders a panel per outcome. */
export type ResetPasswordOutcome =
  { status: "success" } | { status: "invalid-token" } | { status: "failed" };

/**
 * Resets the password with a single-use token.
 *
 * `"invalid-token"` is detected by error *code*, never by message: the i18n
 * plugin may have translated the message into French by the time it arrives
 * here. The route renders the invalid-link panel on that outcome — no banner,
 * because the panel already explains the link failed. Any other failure
 * surfaces in the form's `role="alert"` like a sign-in error.
 */
export const resetPasswordAtom = atom(
  null,
  async (
    _get,
    set,
    args: { token: string; newPassword: string },
  ): Promise<ResetPasswordOutcome> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const res = await authClient.resetPassword({
        token: args.token,
        newPassword: args.newPassword,
      });
      if (res.error) {
        if (errorCodeOf(res.error) === "INVALID_TOKEN") {
          set(resetPasswordInvalidAtom, true);
          return { status: "invalid-token" };
        }
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return { status: "failed" };
      }
      set(resetPasswordDoneAtom, true);
      return { status: "success" };
    } catch (err) {
      console.error("Password reset error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return { status: "failed" };
    } finally {
      set(authPendingAtom, false);
    }
  },
);
