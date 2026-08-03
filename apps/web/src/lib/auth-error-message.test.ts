import { describe, expect, it } from "vitest";
import { localizeAuthError } from "@/lib/auth-error-message";
import { m } from "@/paraglide/messages.js";

describe("localizeAuthError", () => {
  const knownMessages: [string, () => string][] = [
    ["Username is required.", m.validation_username_required],
    ["Username must be between 3 and 20 characters long.", m.validation_username_length],
    [
      "Username can only contain letters, numbers, underscores, and hyphens.",
      m.validation_username_characters,
    ],
    ["Display Name is required.", m.validation_display_name_required],
    ["Please enter a valid email address.", m.validation_email_invalid],
    ["Password must be at least 8 characters long.", m.validation_password_length],
    ["Passwords do not match.", m.validation_password_mismatch],
    ["Please enter your username or email address.", m.validation_identifier_required],
    ["Please enter your password.", m.validation_password_required],
    ["Date of Birth is required.", m.validation_dob_required],
    ["Please enter a valid date of birth.", m.validation_dob_invalid],
    ["You must be at least 15 years old to create an account.", m.validation_dob_age],
  ];

  it.each(knownMessages)("translates %s", (raw, expected) => {
    expect(localizeAuthError(raw)).toBe(expected());
  });

  // The critical case: a server error that was never one of the client-side
  // validation strings must reach the user verbatim, not disappear into `??`
  // returning `undefined` or some generic fallback. A lookup miss silently
  // swallowing an error is worse than not translating it.
  it("passes an unrecognised string through verbatim", () => {
    expect(localizeAuthError("Invalid email or password")).toBe("Invalid email or password");
  });

  it("passes an empty string through verbatim", () => {
    expect(localizeAuthError("")).toBe("");
  });
});
