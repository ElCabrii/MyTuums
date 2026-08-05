import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { authClient } from "@/lib/auth-client";
import { waitForCompletion } from "@/lib/session-sync";
import {
  dateOfBirthToIso,
  validateDateOfBirth,
  validateUsername,
} from "@/lib/auth-validation";
import { needsDobAtom, needsHandleAtom } from "@/atoms/session";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { m } from "@/paraglide/messages.js";

/**
 * The handle being claimed at `/welcome`.
 *
 * `atomWithReset` plus a reset on unmount, matching `atoms/auth-form.ts` — a
 * nested Jotai `<Provider>` would create a *separate store* for the subtree,
 * so every session read inside it (including the one that decides whether this
 * page should be shown at all) would resolve against an empty store.
 */
export const handleDraftAtom = atomWithReset("");

/** The date of birth being declared at `/welcome`, same lifetime as the handle. */
export const dateOfBirthDraftAtom = atomWithReset("");

/** Live first-violated-rule, from the same function `/register` uses. */
export const handleValidationAtom = atom((get) => validateUsername(get(handleDraftAtom)));

/**
 * The page-wide first-violated-rule, checking only the fields this session
 * actually still needs. A social sign-up lands here needing both a handle and
 * a date of birth; an account that predates the 15+ rule needs only the date
 * of birth. Each case validates exactly what it renders.
 */
export const welcomeValidationAtom = atom((get) => {
  if (get(needsHandleAtom)) {
    const usernameError = validateUsername(get(handleDraftAtom));
    if (usernameError) return usernameError;
  }
  if (get(needsDobAtom)) {
    const dobError = validateDateOfBirth(get(dateOfBirthDraftAtom));
    if (dobError) return dobError;
  }
  return null;
});

/** Clears the welcome drafts and the shared auth error — unmount cleanup. */
export const resetHandleClaimAtom = atom(null, (_get, set) => {
  set(handleDraftAtom, RESET);
  set(dateOfBirthDraftAtom, RESET);
  set(authErrorAtom, null);
});

/**
 * Completes a sign-up: claims the handle and/or declares the date of birth —
 * whichever of the two this session is still missing — in one `updateUser`,
 * then waits for the session to actually carry the result.
 *
 * The wait is the important half. `updateUser` resolves before the client has
 * refetched the session, so navigating straight to `/@handle` would run
 * `useRequireHandle` against a session that still has no username — and it
 * would send the person right back here, one step after succeeding. See
 * `lib/session-sync.ts`.
 *
 * There is no separate `isUsernameAvailable` pre-check. `updateUser` already
 * rejects a taken handle with `USERNAME_IS_ALREADY_TAKEN`, which the i18n
 * plugin translates server-side, so a pre-check would add a round trip and a
 * second way to be told the same thing — and could still lose a race with
 * someone claiming it in between.
 *
 * A missing field is never sent as an empty string: validation above rejects
 * empty drafts before `updateUser` runs, and the spreads below simply leave
 * the already-present field out of the body.
 *
 * Returns only success or failure — deliberately not the handle. Navigation is
 * owned by `useRedirectWhenSignedIn`, which reads the *normalised* handle back
 * off the refreshed session; returning the typed value here would invite a
 * caller to navigate with the wrong casing and fragment the profile cache
 * (`handleOf` in lib/user.ts is the rule).
 */
export const claimWelcomeFieldsAtom = atom(null, async (get, set): Promise<boolean> => {
  const wantsHandle = get(needsHandleAtom);
  const wantsDob = get(needsDobAtom);
  // Nothing missing — the page should not be showing. A no-op success beats
  // sending an empty `{}` update that the server would accept for nothing.
  if (!wantsHandle && !wantsDob) return true;

  if (wantsHandle) {
    const usernameError = validateUsername(get(handleDraftAtom));
    if (usernameError) {
      set(authErrorAtom, usernameError);
      return false;
    }
  }
  if (wantsDob) {
    const dobError = validateDateOfBirth(get(dateOfBirthDraftAtom));
    if (dobError) {
      set(authErrorAtom, dobError);
      return false;
    }
  }

  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.updateUser({
      ...(wantsHandle ? { username: get(handleDraftAtom).trim() } : {}),
      // Same client-type boundary as the sign-up body in atoms/auth.ts —
      // the server accepts the field, 1.6.25's client types don't surface it.
      ...(wantsDob
        ? ({ dateOfBirth: dateOfBirthToIso(get(dateOfBirthDraftAtom).trim()) } as Record<
            string,
            string
          >)
        : {}),
    });
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    // The await is what turns the claim into a redirect: `viewerHandleAtom`
    // only reports the new handle once the session store has caught up, and
    // that is what `useRedirectWhenSignedIn` is waiting on.
    await waitForCompletion();
    return true;
  } catch (err) {
    console.error("Welcome claim error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});
