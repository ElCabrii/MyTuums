import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import {
  forgotPasswordEmailAtom,
  forgotPasswordValidationAtom,
  loginIdentifierAtom,
  loginPasswordAtom,
  loginValidationAtom,
  registerConfirmPasswordAtom,
  registerDateOfBirthAtom,
  registerEmailAtom,
  registerNameAtom,
  registerPasswordAtom,
  registerLegalAcceptedAtom,
  registerUsernameAtom,
  registerValidationAtom,
  resetForgotPasswordFormAtom,
  resetLoginFormAtom,
  resetRegisterFormAtom,
  resetPasswordConfirmAtom,
  resetPasswordNewAtom,
  resetPasswordValidationAtom,
  resetResetPasswordFormAtom,
} from "@/atoms/auth-form";
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

describe("field atoms", () => {
  it("default to empty strings and are individually settable", () => {
    const store = createStore();
    expect(store.get(loginIdentifierAtom)).toBe("");
    expect(store.get(registerUsernameAtom)).toBe("");

    store.set(loginIdentifierAtom, "alice");
    expect(store.get(loginIdentifierAtom)).toBe("alice");
    // Setting one field doesn't touch another.
    expect(store.get(loginPasswordAtom)).toBe("");
  });
});

describe("loginValidationAtom", () => {
  it("derives from the exact same rule lib/auth-validation.ts enforces at submit", () => {
    const store = createStore();
    store.set(loginIdentifierAtom, "   ");
    store.set(loginPasswordAtom, "whatever");

    const expected = validateLogin({ identifier: "   ", password: "whatever" });
    expect(expected).not.toBeNull();
    expect(store.get(loginValidationAtom)).toBe(expected);
  });

  it("is null once both fields pass", () => {
    const store = createStore();
    store.set(loginIdentifierAtom, "alice");
    store.set(loginPasswordAtom, "whatever");
    expect(store.get(loginValidationAtom)).toBeNull();
  });
});

describe("registerValidationAtom", () => {
  it("derives from the exact same rule lib/auth-validation.ts enforces at submit", () => {
    const store = createStore();
    const fields = {
      username: "alice",
      name: "",
      email: "not-an-email",
      password: "short",
      confirmPassword: "different",
      dateOfBirth: "",
      legalAccepted: false,
    };
    store.set(registerUsernameAtom, fields.username);
    store.set(registerNameAtom, fields.name);
    store.set(registerEmailAtom, fields.email);
    store.set(registerPasswordAtom, fields.password);
    store.set(registerConfirmPasswordAtom, fields.confirmPassword);
    store.set(registerDateOfBirthAtom, fields.dateOfBirth);

    const expected = validateRegister(fields);
    expect(expected).toBe("Display Name is required.");
    expect(store.get(registerValidationAtom)).toBe(expected);
  });

  it("is null once every field passes", () => {
    const store = createStore();
    store.set(registerUsernameAtom, "alice");
    store.set(registerNameAtom, "Alice");
    store.set(registerEmailAtom, "alice@example.com");
    store.set(registerPasswordAtom, "password1");
    store.set(registerConfirmPasswordAtom, "password1");
    store.set(registerDateOfBirthAtom, "1995-01-01");
    store.set(registerLegalAcceptedAtom, true);
    expect(store.get(registerValidationAtom)).toBeNull();
  });

  it("rejects an under-15 date of birth even when every other field passes", () => {
    const store = createStore();
    // 15 years ago plus one day — relative so the assertion can't quietly
    // stop being true as the calendar moves past it.
    const under15 = new Date();
    under15.setUTCFullYear(under15.getUTCFullYear() - 15);
    under15.setUTCDate(under15.getUTCDate() + 1);
    const under15Iso =
      `${under15.getUTCFullYear()}-` +
      `${String(under15.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(under15.getUTCDate()).padStart(2, "0")}`;

    store.set(registerUsernameAtom, "alice");
    store.set(registerNameAtom, "Alice");
    store.set(registerEmailAtom, "alice@example.com");
    store.set(registerPasswordAtom, "password1");
    store.set(registerConfirmPasswordAtom, "password1");
    store.set(registerDateOfBirthAtom, under15Iso);
    store.set(registerLegalAcceptedAtom, true);
    expect(store.get(registerValidationAtom)).toBe(
      "You must be at least 15 years old to create an account.",
    );
  });

  it("rejects when every field passes but the legal box is unticked", () => {
    const store = createStore();
    store.set(registerUsernameAtom, "alice");
    store.set(registerNameAtom, "Alice");
    store.set(registerEmailAtom, "alice@example.com");
    store.set(registerPasswordAtom, "password1");
    store.set(registerConfirmPasswordAtom, "password1");
    store.set(registerDateOfBirthAtom, "1995-01-01");
    store.set(registerLegalAcceptedAtom, false);
    expect(store.get(registerValidationAtom)).toBe(
      "You must accept the Terms of Service and Privacy Policy to create an account.",
    );
  });
});

describe("resetLoginFormAtom", () => {
  it("clears both fields and the shared auth error", () => {
    const store = createStore();
    store.set(loginIdentifierAtom, "alice");
    store.set(loginPasswordAtom, "secret");
    store.set(authErrorAtom, "Invalid credentials");

    store.set(resetLoginFormAtom);

    expect(store.get(loginIdentifierAtom)).toBe("");
    expect(store.get(loginPasswordAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("resetRegisterFormAtom", () => {
  it("clears every field, including both passwords, and the shared auth error", () => {
    const store = createStore();
    store.set(registerUsernameAtom, "alice");
    store.set(registerNameAtom, "Alice");
    store.set(registerEmailAtom, "alice@example.com");
    store.set(registerPasswordAtom, "password1");
    store.set(registerConfirmPasswordAtom, "password1");
    store.set(registerDateOfBirthAtom, "1995-01-01");
    store.set(registerLegalAcceptedAtom, true);
    store.set(authErrorAtom, "Username already taken");

    store.set(resetRegisterFormAtom);

    expect(store.get(registerUsernameAtom)).toBe("");
    expect(store.get(registerNameAtom)).toBe("");
    expect(store.get(registerEmailAtom)).toBe("");
    expect(store.get(registerPasswordAtom)).toBe("");
    expect(store.get(registerConfirmPasswordAtom)).toBe("");
    expect(store.get(registerDateOfBirthAtom)).toBe("");
    expect(store.get(registerLegalAcceptedAtom)).toBe(false);
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("forgot-password field atoms", () => {
  it("default to empty strings and are individually settable", () => {
    const store = createStore();
    expect(store.get(forgotPasswordEmailAtom)).toBe("");

    store.set(forgotPasswordEmailAtom, "alice@example.com");
    expect(store.get(forgotPasswordEmailAtom)).toBe("alice@example.com");
  });
});

describe("forgotPasswordValidationAtom", () => {
  it("derives from the exact same rule lib/auth-validation.ts enforces at submit", () => {
    const store = createStore();
    store.set(forgotPasswordEmailAtom, "not-an-email");

    const expected = validateEmail("not-an-email");
    expect(expected).not.toBeNull();
    expect(store.get(forgotPasswordValidationAtom)).toBe(expected);
  });

  it("is null once the email passes", () => {
    const store = createStore();
    store.set(forgotPasswordEmailAtom, "alice@example.com");
    expect(store.get(forgotPasswordValidationAtom)).toBeNull();
  });
});

describe("reset-password field atoms", () => {
  it("default to empty strings and are individually settable", () => {
    const store = createStore();
    expect(store.get(resetPasswordNewAtom)).toBe("");
    expect(store.get(resetPasswordConfirmAtom)).toBe("");

    store.set(resetPasswordNewAtom, "password1");
    expect(store.get(resetPasswordNewAtom)).toBe("password1");
    // Setting one field doesn't touch the other.
    expect(store.get(resetPasswordConfirmAtom)).toBe("");
  });
});

describe("resetPasswordValidationAtom", () => {
  it("derives from the exact same rule lib/auth-validation.ts enforces at submit", () => {
    const store = createStore();
    const fields = { newPassword: "short", confirmPassword: "different" };
    store.set(resetPasswordNewAtom, fields.newPassword);
    store.set(resetPasswordConfirmAtom, fields.confirmPassword);

    const expected = validateResetPassword(fields);
    expect(expected).toBe("Password must be at least 8 characters long.");
    expect(store.get(resetPasswordValidationAtom)).toBe(expected);
  });

  it("is null once the pair matches and is long enough", () => {
    const store = createStore();
    store.set(resetPasswordNewAtom, "password1");
    store.set(resetPasswordConfirmAtom, "password1");
    expect(store.get(resetPasswordValidationAtom)).toBeNull();
  });
});

describe("resetForgotPasswordFormAtom", () => {
  it("clears the email field, the shared auth error and the sent flag", () => {
    const store = createStore();
    store.set(forgotPasswordEmailAtom, "alice@example.com");
    store.set(authErrorAtom, "Too many requests");
    store.set(forgotPasswordSentAtom, true);

    store.set(resetForgotPasswordFormAtom);

    expect(store.get(forgotPasswordEmailAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
    expect(store.get(forgotPasswordSentAtom)).toBe(false);
  });
});

describe("resetResetPasswordFormAtom", () => {
  it("clears both password fields, the shared auth error and the outcome flags", () => {
    const store = createStore();
    store.set(resetPasswordNewAtom, "password1");
    store.set(resetPasswordConfirmAtom, "password1");
    store.set(authErrorAtom, "Invalid token");
    store.set(resetPasswordDoneAtom, true);
    store.set(resetPasswordInvalidAtom, true);

    store.set(resetResetPasswordFormAtom);

    expect(store.get(resetPasswordNewAtom)).toBe("");
    expect(store.get(resetPasswordConfirmAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
    expect(store.get(resetPasswordDoneAtom)).toBe(false);
    expect(store.get(resetPasswordInvalidAtom)).toBe(false);
  });
});
