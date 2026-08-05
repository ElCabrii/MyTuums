/**
 * Pure validation guards, extracted byte-for-byte from the sequential
 * `if`s that used to live in `register.tsx`'s and `login.tsx`'s submit
 * handlers. Kept here — rather than inline — so they're unit-testable
 * without mounting a form, and so `atoms/auth-form.ts` can derive a live
 * validation atom from the same rules the submit path enforces.
 *
 * `username`/`name`/`email` are trimmed before checking: leading/trailing
 * whitespace was never significant to the server. Passwords are NOT
 * trimmed — a leading or trailing space is a character the person typed
 * and BetterAuth hashes verbatim, so silently stripping it here would let
 * this function accept input the server treats as a different password.
 */

/**
 * The handle rules, on their own so `/welcome` enforces exactly what
 * `/register` does.
 *
 * Extracted rather than duplicated because a social sign-up claims its handle
 * on a different page from the one it was registered on, and two copies of
 * "3 to 20 characters" would eventually disagree — at which point one form
 * accepts what the other rejects and both look broken. These bounds also mirror
 * the server: `username()` in packages/auth/src/index.ts and `usernameInput` in
 * packages/api/src/users.ts.
 *
 * The strings are unchanged from when these three checks were inline below, so
 * the `validation_username_*` mappings in ./auth-error-message.ts still hit.
 */
export function validateUsername(rawUsername: string): string | null {
  const username = rawUsername.trim();

  if (!username) return "Username is required.";
  if (username.length < 3 || username.length > 20)
    return "Username must be between 3 and 20 characters long.";
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return "Username can only contain letters, numbers, underscores, and hyphens.";
  return null;
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
 * The client half of the 15+ rule. The server half is
 * `validateDateOfBirthHook` in packages/auth/src/dob.ts, and the two must
 * agree — that is what lets a server-rejected claim surface the same message
 * the client would have. The strings here are the English literals the
 * `validation_dob_*` mappings in ./auth-error-message.ts translate; the
 * server throws byte-identical ones so the pass-through lookup hits both.
 *
 * The age comparison reads UTC date parts only: the date-of-birth the app
 * stores is a UTC midnight, so any local-time arithmetic could shift the
 * declared day.
 */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function validateDateOfBirth(rawDateOfBirth: string): string | null {
  const dateOfBirth = rawDateOfBirth.trim();

  if (!dateOfBirth) return "Date of Birth is required.";
  const match = DATE_ONLY_RE.exec(dateOfBirth);
  if (!match) return "Please enter a valid date of birth.";

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Calendar check: the regex accepts "2025-02-30", which Date rolls over to
  // March 2. Round-tripping through Date.UTC and reading back UTC parts is
  // what catches impossible dates without any timezone involved.
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m - 1 ||
    check.getUTCDate() !== d
  ) {
    return "Please enter a valid date of birth.";
  }

  if (!isAtLeastYearsOld({ y, m, d }, 15)) {
    return "You must be at least 15 years old to create an account.";
  }
  return null;
}

/** `dob + years <= today`, as integer `YYYYMMDD` tuples — same rule as dob.ts. */
function isAtLeastYearsOld(
  dob: { y: number; m: number; d: number },
  years: number,
  today: Date = new Date(),
): boolean {
  const dobTuple = dob.y * 10000 + dob.m * 100 + dob.d;
  const cutoff = new Date(
    Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()),
  );
  const cutoffTuple =
    cutoff.getUTCFullYear() * 10000 + (cutoff.getUTCMonth() + 1) * 100 + cutoff.getUTCDate();
  return dobTuple <= cutoffTuple;
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
 * The bio rule. Optional — an empty bio is valid and stored as null.
 *
 * The length and the message are byte-identical with `BIO_MAX_LENGTH` and
 * `BIO_TOO_LONG_MESSAGE` in packages/auth/src/profile.ts, which is where the
 * rule is actually enforced (bios are written through `updateUser`, so the
 * Better Auth database hook is the authority). Keeping the strings identical is
 * what lets a server rejection fall through ./auth-error-message.ts's lookup
 * onto the same translated copy this check would have produced — the same
 * arrangement the date-of-birth rule already uses.
 *
 * Counted in code units rather than grapheme clusters, matching what the server
 * checks with `String.length`. An emoji costing two is a rough edge both halves
 * share, which is the property that matters here.
 */
export function validateBio(rawBio: string): string | null {
  if (rawBio.trim().length > 160) return "Your bio must be 160 characters or fewer.";
  return null;
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
