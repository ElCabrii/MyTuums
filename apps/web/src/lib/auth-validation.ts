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

export type RegisterFields = {
  username: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
};

/** First violated rule, in submit-handler order, or `null` once all pass. */
export function validateRegister(fields: RegisterFields): string | null {
  const username = fields.username.trim();
  const name = fields.name.trim();
  const email = fields.email.trim();

  if (!username) return "Username is required.";
  if (username.length < 3 || username.length > 20)
    return "Username must be between 3 and 20 characters long.";
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return "Username can only contain letters, numbers, underscores, and hyphens.";
  if (!name) return "Display Name is required.";
  if (!email || !email.includes("@")) return "Please enter a valid email address.";
  if (fields.password.length < 8) return "Password must be at least 8 characters long.";
  if (fields.password !== fields.confirmPassword) return "Passwords do not match.";
  return null;
}

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
