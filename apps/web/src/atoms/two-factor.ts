import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { authClient } from "@/lib/auth-client";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { validateTwoFactorCode } from "@/lib/auth-validation";
import { m } from "@/paraglide/messages.js";

/**
 * Two-factor state, split across two audiences that never appear together:
 * enrolment lives on `/settings/account`, the challenge on `/two-factor`.
 * They share `authErrorAtom`/`authPendingAtom` so every auth surface reports
 * failure and progress the same way.
 */

// ─── Enrolment (settings) ───────────────────────────────────────────────────

/** Password confirmation for enabling/disabling — BetterAuth requires it for credential accounts. */
export const twoFactorPasswordAtom = atomWithReset("");

/** What `twoFactor.enable` returns: the TOTP URI to scan and the ten backup codes. */
export interface TwoFactorSetup {
  totpURI: string;
  backupCodes: string[];
}

/**
 * The enrolment secret, held only between "enable" and "verify".
 *
 * In memory and never persisted, deliberately: `totpURI` contains the shared
 * TOTP secret and `backupCodes` are ten single-use passwords to the account.
 * Writing either to `localStorage` would leave the second factor sitting in
 * the same place an XSS already reaches the first one. Losing it on reload is
 * the correct trade — the flow can simply be restarted.
 */
export const twoFactorSetupAtom = atom<TwoFactorSetup | null>(null);

/**
 * Which two-factor panel the settings page is showing.
 *
 * `"verify"` is not derived from `twoFactorSetupAtom !== null` even though it
 * looks like it could be. The backup codes are displayed in that step and are
 * shown exactly once, so leaving that step has to be a deliberate action that
 * also discards them — deriving the step would collapse "stop showing the
 * codes" and "throw away the secret" into the same event.
 */
export type TwoFactorPanel = "idle" | "enable" | "verify" | "disable";

export const twoFactorPanelAtom = atom<TwoFactorPanel>("idle");

/** Opens a two-factor panel, clearing typed passwords, codes and errors from the previous one. */
export const openTwoFactorPanelAtom = atom(null, (_get, set, panel: TwoFactorPanel) => {
  set(twoFactorPanelAtom, panel);
  // Never leave a typed password sitting in the store across panels.
  set(twoFactorPasswordAtom, RESET);
  set(twoFactorCodeAtom, RESET);
  set(authErrorAtom, null);
  if (panel === "idle") set(twoFactorSetupAtom, null);
});

/**
 * Starts enrolment: generates the secret and backup codes.
 *
 * Note this does NOT turn two-factor on. BetterAuth leaves `twoFactorEnabled`
 * false until a TOTP code is verified, which is what stops somebody locking
 * themselves out with a secret they never successfully scanned.
 */
export const startTwoFactorSetupAtom = atom(null, async (get, set): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.twoFactor.enable({ password: get(twoFactorPasswordAtom) });
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }

    set(twoFactorSetupAtom, {
      totpURI: res.data.totpURI,
      backupCodes: res.data.backupCodes,
    });
    set(twoFactorPasswordAtom, RESET);
    return true;
  } catch (err) {
    console.error("Two-factor enable error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

/** Disables two-factor, requiring the current password; returns whether it succeeded. */
export const disableTwoFactorAtom = atom(null, async (get, set): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.twoFactor.disable({ password: get(twoFactorPasswordAtom) });
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }
    set(twoFactorPasswordAtom, RESET);
    set(twoFactorSetupAtom, null);
    return true;
  } catch (err) {
    console.error("Two-factor disable error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});

// ─── Challenge (/two-factor) ────────────────────────────────────────────────

/** The code being entered, whichever kind it is. */
export const twoFactorCodeAtom = atomWithReset("");

/**
 * Skip the challenge on this device for 30 days.
 *
 * Defaults to off. A trusted-device checkbox that starts ticked quietly turns
 * two-factor into one-factor on every machine somebody signs in from, which is
 * the opposite of what they enabled it for — so this is a choice, not a
 * default.
 */
export const trustDeviceAtom = atomWithReset(false);

/** The second-factor kinds the /two-factor page can ask for. */
export type TwoFactorMethod = "totp" | "otp" | "backup";

/**
 * Which challenge form is on screen.
 *
 * An atom rather than `useState` — the app has none, by policy (CLAUDE.md) —
 * and it earns it: switching method has to clear the half-typed code and the
 * previous error too, which `selectTwoFactorMethodAtom` does in one place
 * instead of at each of the three buttons.
 */
export const selectedTwoFactorMethodAtom = atom<TwoFactorMethod>("totp");

export const selectTwoFactorMethodAtom = atom(null, (_get, set, method: TwoFactorMethod) => {
  set(selectedTwoFactorMethodAtom, method);
  // A TOTP code typed into the backup-code field would just fail confusingly.
  set(twoFactorCodeAtom, RESET);
  set(authErrorAtom, null);
});

export const resetTwoFactorChallengeAtom = atom(null, (_get, set) => {
  set(twoFactorCodeAtom, RESET);
  set(trustDeviceAtom, RESET);
  set(selectedTwoFactorMethodAtom, "totp");
  set(authErrorAtom, null);
});

/**
 * Dispatches to the verify endpoint for the chosen method.
 *
 * A helper instead of a ternary chain because the chain nested a conditional
 * inside a conditional (which the lint rule flags), and an explicitly
 * annotated `let res` collapsed to `any` (better-auth's client types defeat
 * `ReturnType` extraction). The inferred union of the three returns is what
 * the original chain produced — `res.error` below stays type-safe.
 */
function verifyTwoFactor(
  method: TwoFactorMethod,
  code: string,
  trustDevice: boolean,
) {
  if (method === "totp") return authClient.twoFactor.verifyTotp({ code, trustDevice });
  if (method === "otp") return authClient.twoFactor.verifyOtp({ code, trustDevice });
  return authClient.twoFactor.verifyBackupCode({ code, trustDevice });
}

/**
 * Verifies the second factor and completes sign-in.
 *
 * All three methods share one action because they differ only in which
 * endpoint they post to — the calling page decides which is on screen. On
 * success BetterAuth issues the real session cookie, the client's session
 * store updates, and the page's redirect effect takes it from there.
 */
export const verifyTwoFactorAtom = atom(
  null,
  async (get, set, method: TwoFactorMethod): Promise<boolean> => {
    const code = get(twoFactorCodeAtom).trim();
    const invalid = validateTwoFactorCode(code);
    if (invalid) {
      // English at the source, translated at the render boundary by
      // `localizeAuthError` — the rule `lib/auth-validation.ts` documents.
      set(authErrorAtom, invalid);
      return false;
    }

    set(authErrorAtom, null);
    set(authPendingAtom, true);
    try {
      const trustDevice = get(trustDeviceAtom);
      const res = await verifyTwoFactor(method, code, trustDevice);

      if (res.error) {
        set(authErrorAtom, res.error.message || m.common_something_went_wrong());
        return false;
      }

      set(twoFactorCodeAtom, RESET);
      return true;
    } catch (err) {
      console.error("Two-factor verification error:", err);
      set(authErrorAtom, m.common_something_went_wrong());
      return false;
    } finally {
      set(authPendingAtom, false);
    }
  },
);

/** Emails a one-time code, for people without an authenticator app to hand. */
export const sendTwoFactorOtpAtom = atom(null, async (_get, set): Promise<boolean> => {
  set(authErrorAtom, null);
  set(authPendingAtom, true);
  try {
    const res = await authClient.twoFactor.sendOtp();
    if (res.error) {
      set(authErrorAtom, res.error.message || m.common_something_went_wrong());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Two-factor OTP send error:", err);
    set(authErrorAtom, m.common_something_went_wrong());
    return false;
  } finally {
    set(authPendingAtom, false);
  }
});
