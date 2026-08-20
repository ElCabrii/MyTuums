import { atom } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { atomWithReset, RESET } from "jotai/utils";
import { hasCurrentLegalConsent, LEGAL_VERSION } from "@my-tuums/auth/rules";
import { authClient } from "@/lib/auth-client";
import { waitForSession } from "@/lib/session-sync";
import { isSignedInAtom, viewerAtom } from "@/atoms/session";
import { m } from "@/paraglide/messages.js";

/** The legal acceptance checkbox in the global consent dialog. */
export const legalConsentCheckboxAtom = atomWithReset(false);

/** True while the global consent dialog is saving acceptance. */
export const legalConsentPendingAtom = atom(false);

/** The last consent-save failure, shown inside the dialog. */
export const legalConsentErrorAtom = atom<string | null>(null);

/** The signed-in user's recorded legal acceptance timestamp, if any. */
export const viewerLegalAcceptedAtAtom = atom((get) => get(viewerAtom)?.legalAcceptedAt ?? null);

/** The signed-in user's recorded legal version, if any. */
export const viewerLegalVersionAtom = atom((get) => get(viewerAtom)?.legalVersion ?? null);

/**
 * True when the signed-in account must accept legal documents before using
 * the app: either it has never accepted them, or its recorded version is not
 * the current one.
 */
export const legalConsentRequiredAtom = atom(
  (get) =>
    get(isSignedInAtom) &&
    !hasCurrentLegalConsent({
      legalAcceptedAt: get(viewerLegalAcceptedAtAtom),
      legalVersion: get(viewerLegalVersionAtom),
    }),
);

/** Whether the dialog is asking for first-time consent or an updated consent. */
export const legalConsentModeAtom = atom((get) =>
  get(viewerLegalAcceptedAtAtom) ? ("update" as const) : ("missing" as const),
);

/** Clears the dialog-local state when the dialog unmounts. */
export const resetLegalConsentAtom = atom(null, (_get, set) => {
  set(legalConsentCheckboxAtom, RESET);
  set(legalConsentErrorAtom, null);
});

/**
 * Records the current legal version through `authClient.updateUser`, then
 * waits for the session store to carry the new version before closing.
 */
export const acceptLegalConsentAtom = atom(null, async (get, set): Promise<boolean> => {
  // The Accept button is disabled while the box is unticked, so this guard is
  // the belt to that brace. It does not reuse the sign-up rejection string
  // from `@my-tuums/auth/rules`: this account already exists, so "to create an
  // account" would be the wrong sentence.
  if (!get(legalConsentCheckboxAtom)) {
    set(legalConsentErrorAtom, m.legal_consent_required());
    return false;
  }

  set(legalConsentErrorAtom, null);
  set(legalConsentPendingAtom, true);
  try {
    // SAFETY: legalAcceptedAt and legalVersion are additionalFields the server
    // accepts; better-auth 1.6.25's client types don't surface them
    // (lib/auth-client.ts).
    const res = await authClient.updateUser({
      legalAcceptedAt: new Date().toISOString(),
      legalVersion: LEGAL_VERSION,
    } as Parameters<typeof authClient.updateUser>[0]);

    if (res.error) {
      set(legalConsentErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    await waitForSession((value) => value.data?.user.legalVersion === LEGAL_VERSION);

    // Every procedure is behind the same gate server-side (the consent
    // middleware in packages/api/src/procedures.ts), so whatever the pages
    // behind this dialog tried to load while consent was owed is sitting in
    // an error state. Resetting clears those failures and refetches what is
    // still mounted, so accepting lands on a working page instead of one the
    // reader has to reload by hand.
    await get(queryClientAtom).resetQueries();

    set(legalConsentCheckboxAtom, RESET);
    return true;
  } catch (err) {
    console.error("Legal consent error:", err);
    set(legalConsentErrorAtom, m.legal_consent_error());
    return false;
  } finally {
    set(legalConsentPendingAtom, false);
  }
});
