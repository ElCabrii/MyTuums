import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { queryClientAtom } from "jotai-tanstack-query";
import { normalizeUsername, type LocalePreference } from "@my-tuums/auth/rules";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/lib/orpc";
import { waitForSession } from "@/lib/session-sync";
import { validateUsername } from "@/lib/auth-validation";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { linkedAccountsAtom } from "@/atoms/linked-accounts";
import { viewerHandleAtom } from "@/atoms/session";
import { profileAtomFamily } from "@/atoms/profile";
import { themeAtom, type Theme } from "@/atoms/theme";
import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";

/**
 * Account-level changes that are neither profile content nor a security
 * enrolment: the handle and the password.
 *
 * Both go through `authClient` rather than an oRPC procedure. The handle is the
 * `username` plugin's field and changing it has to run the plugin's
 * normalisation and uniqueness check; the password is Better Auth's to hash and
 * to revoke sessions for. Reimplementing either against the database would mean
 * reimplementing the rules with it.
 */

// ---------------------------------------------------------------- handle

/** The handle being typed in settings; reset on unmount like every form field. */
export const handleChangeDraftAtom = atomWithReset("");

/** First handle-validation error for the current draft, or `null`. */
export const handleChangeValidationAtom = atom((get) =>
  validateUsername(get(handleChangeDraftAtom)),
);

/** Clears the handle draft and the shared auth error — unmount cleanup. */
export const resetHandleChangeAtom = atom(null, (_get, set) => {
  set(handleChangeDraftAtom, RESET);
  set(authErrorAtom, null);
});

/**
 * Changes the handle, and returns the new normalised one so the caller can
 * navigate to the profile URL it now lives at.
 *
 * Returning the handle is a deliberate departure from `claimWelcomeFieldsAtom`,
 * which pointedly does *not* — there, navigation is owned by
 * `useRedirectWhenSignedIn` and returning a value would invite a second,
 * racing navigate. Here there is no redirect effect watching: the session is
 * already complete and signed in, so nothing else is going to move anyone off
 * a now-404 URL. It comes from the refreshed session rather than the draft, so
 * it is the *normalised* casing — the same rule `handleOf` encodes, and what
 * `profileAtomFamily` is keyed by.
 *
 * There is no `isUsernameAvailable` pre-check, for the reason
 * `atoms/handle-claim.ts` already records: `updateUser` rejects a taken handle
 * with a translated `USERNAME_IS_ALREADY_TAKEN`, so a pre-check would add a
 * round trip, a second way to say the same thing, and could still lose the race.
 */
export const changeHandleAtom = atom(null, async (get, set): Promise<string | null> => {
  const validationError = get(handleChangeValidationAtom);
  if (validationError) {
    set(authErrorAtom, validationError);
    return null;
  }

  const next = normalizeUsername(get(handleChangeDraftAtom).trim());
  const previous = get(viewerHandleAtom);
  if (next === previous) {
    // Nothing to do, and saying so beats a round trip that reports success for
    // a change that did not happen.
    set(handleChangeDraftAtom, RESET);
    return previous;
  }

  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.updateUser({ username: next });
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return null;
    }

    // Same gap `atoms/handle-claim.ts` closes: `updateUser` resolves before the
    // client has refetched, so reading the handle back immediately would still
    // give the old one — and navigating with it would land on the URL that has
    // just stopped existing.
    await waitForSession((value) => value.data?.user.username === next);

    // The old handle's cached profile is now a 404 and the new one has never
    // been fetched. Removing the family entry rather than invalidating it
    // matters: an invalidated entry would refetch the dead handle immediately.
    if (previous) profileAtomFamily.remove(previous);
    void get(queryClientAtom).removeQueries({
      queryKey: orpc.user.byUsername.key({ input: { username: previous ?? next } }),
    });

    set(handleChangeDraftAtom, RESET);
    return get(viewerHandleAtom);
  } catch (err) {
    console.error("Handle change error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return null;
  } finally {
    set(authPendingAtom, false);
  }
});

// -------------------------------------------------------------- password

/** The current password — required, and only ever checked against the server. */
export const currentPasswordAtom = atomWithReset("");
/** The password being set; cleared on success so no typed password lingers. */
export const newPasswordAtom = atomWithReset("");
/** The re-typed new password; must equal `newPasswordAtom`. */
export const confirmNewPasswordAtom = atomWithReset("");

/** True once a password change has succeeded, so the form can say so. */
export const passwordChangedAtom = atom(false);

/** First password-change violation (missing current, too short, mismatch), or `null`. */
export const passwordChangeValidationAtom = atom((get) => {
  if (!get(currentPasswordAtom)) return "Please enter your password.";
  if (get(newPasswordAtom).length < 8) return "Password must be at least 8 characters long.";
  if (get(newPasswordAtom) !== get(confirmNewPasswordAtom)) return "Passwords do not match.";
  return null;
});

/** Clears the password fields, the success flag and the shared error — unmount cleanup. */
export const resetPasswordChangeAtom = atom(null, (_get, set) => {
  set(currentPasswordAtom, RESET);
  set(newPasswordAtom, RESET);
  set(confirmNewPasswordAtom, RESET);
  set(passwordChangedAtom, false);
  set(authErrorAtom, null);
});

/**
 * Changes the password and signs every other session out.
 *
 * `revokeOtherSessions: true` is not a convenience. Someone changing their
 * password is very often doing it *because* they think somebody else has it,
 * and leaving those sessions alive would mean the change accomplished nothing —
 * the same reasoning behind `revokeSessionsOnPasswordReset` in
 * `packages/auth/src/index.ts`, applied to the path a signed-in person takes.
 *
 * The current session survives: Better Auth reissues it, so this does not sign
 * the person out of the page they are standing on.
 */
export const changePasswordAtom = atom(null, async (get, set): Promise<boolean> => {
  const validationError = get(passwordChangeValidationAtom);
  if (validationError) {
    set(authErrorAtom, validationError);
    return false;
  }

  set(authErrorAtom, null);
  set(passwordChangedAtom, false);
  set(authPendingAtom, true);
  try {
    const res = await authClient.changePassword({
      currentPassword: get(currentPasswordAtom),
      newPassword: get(newPasswordAtom),
      revokeOtherSessions: true,
    });

    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    set(currentPasswordAtom, RESET);
    set(newPasswordAtom, RESET);
    set(confirmNewPasswordAtom, RESET);
    set(passwordChangedAtom, true);
    return true;
  } catch (err) {
    console.error("Password change error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

/**
 * Whether this account has a password at all.
 *
 * An OAuth-only sign-up has no `credential` account row, so `changePassword`
 * can only fail for it — there is no current password to supply. The settings
 * page hides the whole section rather than showing a form that cannot succeed.
 *
 * Read off `linkedAccountsAtom`, which the linked-accounts section already
 * fetches, so this costs no extra request. `undefined` while that query is
 * still loading, which the section renders as "nothing yet" rather than
 * flashing the form and then removing it.
 */
export const hasPasswordAtom = atom((get) => {
  const accounts = get(linkedAccountsAtom).data;
  if (!accounts) return undefined;
  return accounts.some((account) => account.providerId === "credential");
});

// ----------------------------------------------------------- preferences

/**
 * Stores the account's default theme, and applies it to this device too.
 *
 * Both halves matter, and they are different things. The `updateUser` call sets
 * what a device that has never chosen falls back to (see `atoms/theme.ts`);
 * `set(themeAtom, ...)` sets this device's own choice. Without the second, the
 * person picks "Dark" in settings and nothing visibly happens here — because
 * this browser already has a stored choice, which by design outranks the
 * account default they just saved.
 */
export const saveThemePreferenceAtom = atom(
  null,
  async (_get, set, preference: Theme): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      // SAFETY: themePreference is an additionalField the server accepts;
      // better-auth 1.6.25's client types don't surface it (lib/auth-client.ts).
      const res = await authClient.updateUser({ themePreference: preference } as Parameters<
        typeof authClient.updateUser
      >[0]);
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }

      set(themeAtom, preference);
      return true;
    } catch (err) {
      console.error("Theme preference error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/**
 * Stores the account's default language, and switches this device to it.
 *
 * `setLocale` reloads the document, so it must come *after* the request has
 * landed — the reload discards this page, and anything not yet persisted with
 * it. That ordering is why this cannot mirror the theme atom's shape exactly.
 */
export const saveLocalePreferenceAtom = atom(
  null,
  async (_get, set, preference: LocalePreference): Promise<boolean> => {
    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      // SAFETY: localePreference is an additionalField the server accepts;
      // better-auth 1.6.25's client types don't surface it (lib/auth-client.ts).
      const res = await authClient.updateUser({ localePreference: preference } as Parameters<
        typeof authClient.updateUser
      >[0]);
      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }

      // Sets the PARAGLIDE_LOCALE cookie and reloads. From here on this device
      // has made an explicit choice, so `localePreferenceEffect` will leave it
      // alone — which is correct: they chose it right here.
      if (preference !== getLocale()) void setLocale(preference);
      return true;
    } catch (err) {
      console.error("Locale preference error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);
