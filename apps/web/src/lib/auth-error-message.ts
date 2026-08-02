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
