import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import {
  authErrorAtom,
  forgotPasswordSentAtom,
  resetPasswordDoneAtom,
  resetPasswordInvalidAtom,
} from "@/atoms/auth";
import {
  validateEmail,
  validateLogin,
  validateRegister,
  validateResetPassword,
} from "@/lib/auth-validation";

/** The login form's identifier field — an email or a username. */
export const loginIdentifierAtom = atomWithReset("");
/** The login form's password field. */
export const loginPasswordAtom = atomWithReset("");

/** The register form's username field. */
export const registerUsernameAtom = atomWithReset("");
/** The register form's display-name field. */
export const registerNameAtom = atomWithReset("");
/** The register form's email field. */
export const registerEmailAtom = atomWithReset("");
/** The register form's password field. */
export const registerPasswordAtom = atomWithReset("");
/** The register form's password confirmation. */
export const registerConfirmPasswordAtom = atomWithReset("");
/** The register form's date-of-birth field, in "YYYY-MM-DD" from the native input. */
export const registerDateOfBirthAtom = atomWithReset("");
/** The register form's Terms of Service and Privacy Policy acceptance box. */
export const registerTermsAcceptedAtom = atomWithReset(false);

/** The forgot-password form's email field. */
export const forgotPasswordEmailAtom = atomWithReset("");

/** The reset-password form's new-password field. */
export const resetPasswordNewAtom = atomWithReset("");
/** The reset-password form's confirmation field. */
export const resetPasswordConfirmAtom = atomWithReset("");

/**
 * Resets every login-form field plus the shared auth error — unmount cleanup.
 *
 * These atoms are module-scoped, not component-scoped, so their lifetime
 * has to be bounded some other way or a half-typed password would survive
 * navigating away from /login and back. The obvious-looking fix — wrap the
 * page in its own `<Provider>` — is wrong: Jotai's `Provider` creates a
 * fully SEPARATE store for its subtree, not a scoped slice of the app's one
 * store. Reads inside that subtree (including `isSignedInAtom`, which the
 * redirect hook depends on) would resolve against an empty store instead of
 * the real session, silently breaking the redirect.
 *
 * The working equivalent is resetting on unmount. Each page does:
 *   const reset = useSetAtom(resetLoginFormAtom);
 *   useEffect(() => reset, [reset]);
 * — returning the setter itself as the effect's cleanup, so it runs once,
 * on unmount, with no dependency on anything else.
 *
 * `authErrorAtom` is cleared alongside the fields. It lives in `atoms/auth.ts`
 * because the action atoms write it, but it is just as page-scoped as the
 * fields are: leaving it set means navigating away from a failed sign-in and
 * back renders the old error above an empty form. The import is safe —
 * `atoms/auth.ts` does not import this module, so the dependency runs one way.
 */
export const resetLoginFormAtom = atom(null, (_get, set) => {
  set(loginIdentifierAtom, RESET);
  set(loginPasswordAtom, RESET);
  set(authErrorAtom, null);
});

export const resetRegisterFormAtom = atom(null, (_get, set) => {
  set(registerUsernameAtom, RESET);
  set(registerNameAtom, RESET);
  set(registerEmailAtom, RESET);
  set(registerPasswordAtom, RESET);
  set(registerConfirmPasswordAtom, RESET);
  set(registerDateOfBirthAtom, RESET);
  set(registerTermsAcceptedAtom, RESET);
  set(authErrorAtom, null);
});

export const resetForgotPasswordFormAtom = atom(null, (_get, set) => {
  set(forgotPasswordEmailAtom, RESET);
  set(authErrorAtom, null);
  set(forgotPasswordSentAtom, false);
});

export const resetResetPasswordFormAtom = atom(null, (_get, set) => {
  set(resetPasswordNewAtom, RESET);
  set(resetPasswordConfirmAtom, RESET);
  set(authErrorAtom, null);
  set(resetPasswordDoneAtom, false);
  set(resetPasswordInvalidAtom, false);
});

/** First validation error for the current field values, or `null`. */
export const loginValidationAtom = atom((get) =>
  validateLogin({
    identifier: get(loginIdentifierAtom),
    password: get(loginPasswordAtom),
  }),
);

/** First validation error for the current field values, or `null`. */
export const registerValidationAtom = atom((get) =>
  validateRegister({
    username: get(registerUsernameAtom),
    name: get(registerNameAtom),
    email: get(registerEmailAtom),
    password: get(registerPasswordAtom),
    confirmPassword: get(registerConfirmPasswordAtom),
    dateOfBirth: get(registerDateOfBirthAtom),
    termsAccepted: get(registerTermsAcceptedAtom),
  }),
);

/** First validation error for the current field values, or `null`. */
export const forgotPasswordValidationAtom = atom((get) =>
  validateEmail(get(forgotPasswordEmailAtom)),
);

/** First validation error for the current field values, or `null`. */
export const resetPasswordValidationAtom = atom((get) =>
  validateResetPassword({
    newPassword: get(resetPasswordNewAtom),
    confirmPassword: get(resetPasswordConfirmAtom),
  }),
);
