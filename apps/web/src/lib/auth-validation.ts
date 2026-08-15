/**
 * The browser's form adapter over the account rules.
 *
 * The rules themselves — the handle bounds and charset, the date-of-birth
 * parse and the age comparison, the bio limit, and every sentence a rejection
 * carries — live in `@my-tuums/auth/rules`, the one dependency-free module
 * `packages/auth` also enforces them from. That subpath is browser-safe on the
 * same terms as `@my-tuums/api/constants`: it imports nothing, so importing it
 * cannot drag `@my-tuums/db` (which reads `DATABASE_URL` at module scope and
 * throws) or the Better Auth instance into the bundle.
 *
 * What is left here is what only a form knows:
 *
 * - **Which fields are required.** The server never sees a half-filled form,
 *   so "Username is required." has no server counterpart and is stated here.
 * - **Trimming policy.** `username`/`name`/`email`/`bio` are trimmed before
 *   checking: leading and trailing whitespace was never significant. Passwords
 *   are NOT trimmed — a leading or trailing space is a character the person
 *   typed and BetterAuth hashes verbatim, so stripping it here would let this
 *   function accept input the server treats as a different password.
 * - **Rule order.** Which violation a submission with several surfaces first.
 * - **The rules with no server half at all**: password length and
 *   confirmation, the two-factor code box, the login fields.
 *
 * Every message returned from here is a key in ./auth-error-message.ts, which
 * is what lets a *server* rejection — thrown with the identical string by the
 * database hooks — land on the same translated copy.
 */
import {
  BIO_TOO_LONG_MESSAGE,
  DOB_INVALID_MESSAGE,
  DOB_UNDER_AGE_MESSAGE,
  isAtLeastYearsOld,
  isBioWithinLimit,
  parseDateOnlyParts,
  usernameRuleViolation,
} from "@my-tuums/auth/rules";

/**
 * The handle rules, on their own so `/welcome` enforces exactly what
 * `/register` does — a social sign-up claims its handle on a different page
 * from the one it was registered on.
 *
 * Presence is this function's own; the bound and the charset come from the
 * shared module, so this form, the other form, `usernameInput` in
 * packages/api/src/users.ts and the BetterAuth `username()` plugin all read
 * one pair of numbers.
 */
export function validateUsername(rawUsername: string): string | null {
  const username = rawUsername.trim();

  if (!username) return "Username is required.";
  return usernameRuleViolation(username);
}

export type RegisterFields = {
  username: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  /** "YYYY-MM-DD" — the value of the native date input, before `dateOfBirthToIso`. */
  dateOfBirth: string;
};

/**
 * The date-of-birth field.
 *
 * Presence is this function's own — the server deliberately permits an absent
 * date of birth, because OAuth sign-ups arrive with none and the app holds
 * them at `/welcome` until they declare one. Everything past presence is the
 * shared rule: `parseDateOnlyParts` is the strict `YYYY-MM-DD` the native date
 * input produces, and `isAtLeastYearsOld` is the same UTC tuple comparison the
 * database hook runs.
 */
export function validateDateOfBirth(rawDateOfBirth: string): string | null {
  const dateOfBirth = rawDateOfBirth.trim();

  if (!dateOfBirth) return "Date of Birth is required.";

  const parts = parseDateOnlyParts(dateOfBirth);
  if (!parts) return DOB_INVALID_MESSAGE;
  if (!isAtLeastYearsOld(parts)) return DOB_UNDER_AGE_MESSAGE;
  return null;
}

/**
 * The email rule on its own, so `/forgot-password` enforces exactly what
 * `/register` does.
 *
 * Deliberately shallow — presence and an `@` — for the same reason the file
 * header gives for usernames: the shape check belongs to the server (zod's
 * `z.email()` in BetterAuth), and a client-side guess that disagrees with it
 * would reject an address the server accepts.
 */
export function validateEmail(rawEmail: string): string | null {
  const email = rawEmail.trim();

  if (!email || !email.includes("@")) return "Please enter a valid email address.";
  return null;
}

/**
 * The display-name rule, extracted for the same reason `validateUsername` was:
 * `/register` and `/settings/account` both enforce it now, and the settings
 * form must not accept a name the sign-up form rejects.
 *
 * The string is unchanged from when this was inline in `validateRegister`, so
 * the `validation_display_name_required` mapping in ./auth-error-message.ts
 * still hits.
 */
export function validateDisplayName(rawName: string): string | null {
  if (!rawName.trim()) return "Display Name is required.";
  return null;
}

/**
 * The bio field. Optional — an empty bio is valid and stored as null.
 *
 * Trimmed before measuring, which the enforcing hook deliberately does not do:
 * the form is about to trim what it sends, so the count a person sees must
 * match the value that will arrive, while the hook measures exactly the string
 * it is about to store.
 */
export function validateBio(rawBio: string): string | null {
  return isBioWithinLimit(rawBio.trim()) ? null : BIO_TOO_LONG_MESSAGE;
}

/** First violated rule, in submit-handler order, or `null` once all pass. */
export function validateRegister(fields: RegisterFields): string | null {
  const usernameError = validateUsername(fields.username);
  if (usernameError) return usernameError;
  const nameError = validateDisplayName(fields.name);
  if (nameError) return nameError;
  const emailError = validateEmail(fields.email);
  if (emailError) return emailError;
  if (fields.password.length < 8) return "Password must be at least 8 characters long.";
  if (fields.password !== fields.confirmPassword) return "Passwords do not match.";
  const dateOfBirthError = validateDateOfBirth(fields.dateOfBirth);
  if (dateOfBirthError) return dateOfBirthError;
  return null;
}

/**
 * The wire format. A bare "YYYY-MM-DD" would be parsed by Postgres in the
 * server's timezone, so the app pins it to UTC midnight — the same instant the
 * session store reports back, which is what makes the read-side helpers below
 * stable.
 */
export function dateOfBirthToIso(dateOfBirth: string): string {
  return `${dateOfBirth}T00:00:00.000Z`;
}

/**
 * The input format, read back through UTC date parts so no timezone can shift
 * the stored day. Accepts what the session store hands out (a Date) or a raw
 * ISO string; anything unparseable yields "".
 */
export function dateOfBirthInputValue(value: Date | string | null | undefined): string {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const y = parsed.getUTCFullYear();
  const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const d = String(parsed.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The login form's two fields. */
export type LoginFields = {
  identifier: string;
  password: string;
};

/** First violated rule, in submit-handler order, or `null` once all pass. */
export function validateLogin(fields: LoginFields): string | null {
  if (!fields.identifier.trim()) return "Please enter your username or email address.";
  if (!fields.password) return "Please enter your password.";
  return null;
}

/** The reset-password form's two fields. */
export type ResetPasswordFields = {
  newPassword: string;
  confirmPassword: string;
};

/**
 * The reset form. Length before mismatch, same order as `validateRegister` —
 * a short password that also doesn't match its confirmation should surface the
 * length rule first, because fixing it may change the mismatch.
 *
 * Passwords are not trimmed, per the file header: a space is a character the
 * person typed and BetterAuth hashes verbatim.
 */
export function validateResetPassword(fields: ResetPasswordFields): string | null {
  if (fields.newPassword.length < 8) return "Password must be at least 8 characters long.";
  if (fields.newPassword !== fields.confirmPassword) return "Passwords do not match.";
  return null;
}

/**
 * The second-factor code box.
 *
 * Only checks that something was typed. Length and shape are deliberately not
 * checked here: TOTP codes, emailed OTPs and backup codes have different
 * formats, the plugin's options can change all three, and a client-side guess
 * that disagrees with the server would reject a code that would have worked.
 * Emptiness is the one thing this side can know for certain.
 */
export function validateTwoFactorCode(code: string): string | null {
  if (!code.trim()) return "Please enter your verification code.";
  return null;
}
