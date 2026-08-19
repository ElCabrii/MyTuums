import { m } from "@/paraglide/messages.js";

const validationMessages = {
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
  // The date-of-birth strings from `@my-tuums/auth/rules`; the hook in
  // packages/auth/src/dob.ts throws them verbatim, so a server-rejected claim
  // lands here instead of rendering raw.
  "Date of Birth is required.": () => m.validation_dob_required(),
  "Please enter a valid date of birth.": () => m.validation_dob_invalid(),
  "You must be at least 15 years old to create an account.": () => m.validation_dob_age(),
  "You must accept the Terms of Service and Privacy Policy to create an account.": () =>
    m.validation_terms_required(),
  // Shared byte-for-byte with `BIO_TOO_LONG_MESSAGE` in
  // `@my-tuums/auth/rules`. The database hook in packages/auth/src/profile.ts
  // enforces it; the client check is a courtesy anyone can skip.
  "Your bio must be 160 characters or fewer.": () => m.validation_bio_length(),
  "Please choose a valid theme.": () => m.validation_preference_invalid(),
  "Please choose a valid language.": () => m.validation_preference_invalid(),
  "Profile images are set by uploading a file.": () => m.validation_image_managed(),
  // The upload procedure's rejections (packages/api/src/users.ts). The client
  // produces the same three strings from its own pre-checks in
  // `atoms/profile-edit.ts`, so both sides land on one entry each.
  "That image is too large.": () => m.validation_image_too_large(),
  "That image format isn't supported. Use a PNG, JPEG or WebP.": () => m.validation_image_type(),
  "That file doesn't look like an image.": () => m.validation_image_unreadable(),
  // The admin plugin's default `bannedUserMessage`, thrown verbatim by the
  // `session.create.before` hook on the password/username/passkey paths
  // (packages/auth/src/index.ts's `admin()` registration takes no override).
  // `signInAtom`/`signInWithPasskeyAtom` navigate to `/banned` on this code
  // before it ever reaches a banner (see atoms/auth.ts) — this entry is the
  // stopgap for any path that still falls through to one, per issue #74.
  "You have been banned from this application. Please contact support if you believe this is an error.":
    () => m.auth_oauth_banned(),
} satisfies Record<string, () => string>;

/** Translates the known client-side validation messages without hiding server errors. */
export function localizeAuthError(error: string): string {
  for (const [known, translate] of Object.entries(validationMessages)) {
    if (known === error) return translate();
  }
  return error;
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
const oauthErrorMessages = {
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
  // The stopgap for issue #74: `/login` navigates straight to `/banned` on
  // this code (see `login.tsx`) rather than ever calling `localizeOAuthError`
  // with it, so this entry only fires if some future path still falls
  // through to the generic banner instead of navigating.
  BANNED_USER: () => m.auth_oauth_banned(),
} satisfies Record<string, () => string>;

/**
 * Translates the `?error=<code>` a failed OAuth round trip returns; an unknown
 * code falls back to a generic sign-in-failed message rather than raw text.
 */
export function localizeOAuthError(code: string): string {
  for (const [known, translate] of Object.entries(oauthErrorMessages)) {
    if (known === code) return translate();
  }
  return m.auth_oauth_failed();
}
