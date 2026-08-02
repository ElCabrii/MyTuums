import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { authClient } from "@/lib/auth-client";
import { waitForHandle } from "@/lib/session-sync";
import { validateUsername } from "@/lib/auth-validation";
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

/** Live first-violated-rule, from the same function `/register` uses. */
export const handleValidationAtom = atom((get) => validateUsername(get(handleDraftAtom)));

export const resetHandleClaimAtom = atom(null, (_get, set) => {
  set(handleDraftAtom, RESET);
  set(authErrorAtom, null);
});

/**
 * Claims the handle, then waits for the session to actually carry it.
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
 * Returns only success or failure — deliberately not the handle. Navigation is
 * owned by `useRedirectWhenSignedIn`, which reads the *normalised* handle back
 * off the refreshed session; returning the typed value here would invite a
 * caller to navigate with the wrong casing and fragment the profile cache
 * (`handleOf` in lib/user.ts is the rule).
 */
export const claimHandleAtom = atom(null, async (get, set): Promise<boolean> => {
  const username = get(handleDraftAtom).trim();

  const invalid = validateUsername(username);
  if (invalid) {
    set(authErrorAtom, invalid);
    return false;
  }

  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.updateUser({ username });
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    // The await is what turns the claim into a redirect: `viewerHandleAtom`
    // only reports the new handle once the session store has caught up, and
    // that is what `useRedirectWhenSignedIn` is waiting on.
    await waitForHandle();
    return true;
  } catch (err) {
    console.error("Handle claim error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});
