import { describe, expect, it } from "vitest";
import { validateLogin, validateRegister } from "./auth-validation";

const validRegister = {
  username: "alexmercer",
  name: "Alex Mercer",
  email: "alex@example.com",
  password: "password1",
  confirmPassword: "password1",
};

describe("validateRegister", () => {
  it("accepts a fully valid set of fields", () => {
    expect(validateRegister(validRegister)).toBeNull();
  });

  it("requires a username, trimming whitespace-only input to empty", () => {
    expect(validateRegister({ ...validRegister, username: "" })).toBe("Username is required.");
    expect(validateRegister({ ...validRegister, username: "   " })).toBe(
      "Username is required.",
    );
  });

  it("rejects a username under 3 characters", () => {
    expect(validateRegister({ ...validRegister, username: "ab" })).toBe(
      "Username must be between 3 and 20 characters long.",
    );
  });

  it("accepts a username at the 3-character floor", () => {
    expect(validateRegister({ ...validRegister, username: "abc" })).toBeNull();
  });

  it("accepts a username at the 20-character ceiling", () => {
    expect(validateRegister({ ...validRegister, username: "a".repeat(20) })).toBeNull();
  });

  it("rejects a username over 20 characters", () => {
    expect(validateRegister({ ...validRegister, username: "a".repeat(21) })).toBe(
      "Username must be between 3 and 20 characters long.",
    );
  });

  it("rejects a username with characters outside [a-zA-Z0-9_-]", () => {
    expect(validateRegister({ ...validRegister, username: "alex mercer" })).toBe(
      "Username can only contain letters, numbers, underscores, and hyphens.",
    );
    expect(validateRegister({ ...validRegister, username: "alex@mercer" })).toBe(
      "Username can only contain letters, numbers, underscores, and hyphens.",
    );
  });

  it("accepts underscores and hyphens in a username", () => {
    expect(validateRegister({ ...validRegister, username: "alex_mercer-2" })).toBeNull();
  });

  it("requires a display name, trimming whitespace-only input to empty", () => {
    expect(validateRegister({ ...validRegister, name: "" })).toBe("Display Name is required.");
    expect(validateRegister({ ...validRegister, name: "   " })).toBe(
      "Display Name is required.",
    );
  });

  it("requires an email address", () => {
    expect(validateRegister({ ...validRegister, email: "" })).toBe(
      "Please enter a valid email address.",
    );
  });

  it("rejects an email without an @", () => {
    expect(validateRegister({ ...validRegister, email: "not-an-email" })).toBe(
      "Please enter a valid email address.",
    );
  });

  it("rejects a password under 8 characters", () => {
    expect(validateRegister({ ...validRegister, password: "short1", confirmPassword: "short1" })).toBe(
      "Password must be at least 8 characters long.",
    );
  });

  it("accepts a password at the 8-character floor", () => {
    expect(
      validateRegister({ ...validRegister, password: "eightlet", confirmPassword: "eightlet" }),
    ).toBeNull();
  });

  it("does not trim passwords before checking length", () => {
    // 7 real characters plus a leading space is 8 long untrimmed — proves
    // the length check runs on the raw string, not `.trim()`ed.
    const padded = " sevenxx";
    expect(validateRegister({ ...validRegister, password: padded, confirmPassword: padded })).toBeNull();
  });

  it("rejects mismatched passwords", () => {
    expect(validateRegister({ ...validRegister, confirmPassword: "different1" })).toBe(
      "Passwords do not match.",
    );
  });

  it("treats a trailing-space difference between password and confirmPassword as a mismatch", () => {
    // Proves confirmPassword isn't trimmed either — the two are compared
    // as typed.
    expect(
      validateRegister({ ...validRegister, password: "password1", confirmPassword: "password1 " }),
    ).toBe("Passwords do not match.");
  });
});

describe("validateLogin", () => {
  it("accepts a valid identifier and password", () => {
    expect(validateLogin({ identifier: "alexmercer", password: "anything" })).toBeNull();
  });

  it("requires an identifier, trimming whitespace-only input to empty", () => {
    expect(validateLogin({ identifier: "", password: "anything" })).toBe(
      "Please enter your username or email address.",
    );
    expect(validateLogin({ identifier: "   ", password: "anything" })).toBe(
      "Please enter your username or email address.",
    );
  });

  it("requires a password", () => {
    expect(validateLogin({ identifier: "alexmercer", password: "" })).toBe(
      "Please enter your password.",
    );
  });

  it("does not trim the password before checking it's present", () => {
    // A password of only whitespace is truthy and must pass this guard —
    // proves the check is `!password`, not `!password.trim()`.
    expect(validateLogin({ identifier: "alexmercer", password: " " })).toBeNull();
  });
});
