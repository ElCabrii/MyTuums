import { atom } from "jotai";
import { atomWithReset, RESET } from "jotai/utils";
import { validateLogin, validateRegister } from "@/lib/auth-validation";

export const loginIdentifierAtom = atomWithReset("");
export const loginPasswordAtom = atomWithReset("");

export const registerUsernameAtom = atomWithReset("");
export const registerNameAtom = atomWithReset("");
export const registerEmailAtom = atomWithReset("");
export const registerPasswordAtom = atomWithReset("");
export const registerConfirmPasswordAtom = atomWithReset("");

/**
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
 */
export const resetLoginFormAtom = atom(null, (_get, set) => {
  set(loginIdentifierAtom, RESET);
  set(loginPasswordAtom, RESET);
});

export const resetRegisterFormAtom = atom(null, (_get, set) => {
  set(registerUsernameAtom, RESET);
  set(registerNameAtom, RESET);
  set(registerEmailAtom, RESET);
  set(registerPasswordAtom, RESET);
  set(registerConfirmPasswordAtom, RESET);
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
  }),
);
