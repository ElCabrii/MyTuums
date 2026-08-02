import { m } from "@/paraglide/messages.js";

const validationMessages: Record<string, () => string> = {
  "Username is required.": () => m.validation_username_required(),
  "Username must be between 3 and 20 characters long.": () => m.validation_username_length(),
  "Username can only contain letters, numbers, underscores, and hyphens.": () =>
    m.validation_username_characters(),
  "Display Name is required.": () => m.validation_display_name_required(),
  "Please enter a valid email address.": () => m.validation_email_invalid(),
  "Password must be at least 8 characters long.": () => m.validation_password_length(),
  "Passwords do not match.": () => m.validation_password_mismatch(),
  "Please enter your username or email address.": () => m.validation_identifier_required(),
  "Please enter your password.": () => m.validation_password_required(),
  "Please enter your verification code.": () => m.validation_code_required(),
};

/** Translates the known client-side validation messages without hiding server errors. */
export function localizeAuthError(error: string): string {
  return validationMessages[error]?.() ?? error;
}

/**
 * OAuth failures arrive as a `?error=<code>` on the redirect back from
 * BetterAuth, which is a different namespace from the English literals above:
 * these are snake_case codes, not sentences, and there is no server message to
 * fall through to. An unmapped code would otherwise render as raw
 * `account_not_linked` in the alert banner.
 *
 * Only codes a person can actually provoke are mapped, and each says what to
 * *do* rather than what went wrong — `account_not_linked` in particular is not
 * a failure at all but a deliberate refusal, and without an instruction it
 * reads as the app being broken.
 */
const oauthErrorMessages: Record<string, () => string> = {
  // Raised when the provider's email matches an existing account whose own
  // email was never verified. BetterAuth's `requireLocalEmailVerified`
  // defaults to true and this is left on deliberately: it stops someone who
  // registered with your address (but never proved they own it) from having
  // your provider sign-in silently merged into their account.
  account_not_linked: () => m.auth_oauth_account_not_linked(),
  account_already_linked_to_different_user: () => m.auth_oauth_already_linked(),
  email_not_found: () => m.auth_oauth_no_email(),
  email_is_missing: () => m.auth_oauth_no_email(),
  "email_doesn't_match": () => m.auth_oauth_email_mismatch(),
  signup_disabled: () => m.auth_oauth_signup_disabled(),
  // The state round-trip failed — expired, replayed (back button), or the
  // flow was finished in a different browser than it started in.
  state_mismatch: () => m.auth_oauth_expired(),
  state_not_found: () => m.auth_oauth_expired(),
  state_invalid: () => m.auth_oauth_expired(),
};

export function localizeOAuthError(code: string): string {
  return oauthErrorMessages[code]?.() ?? m.auth_oauth_failed();
}
