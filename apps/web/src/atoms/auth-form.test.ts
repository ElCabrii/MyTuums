import { describe, expect, it } from "vitest";
import { createStore } from "jotai";
import {
  loginIdentifierAtom,
  loginPasswordAtom,
  loginValidationAtom,
  registerConfirmPasswordAtom,
  registerEmailAtom,
  registerNameAtom,
  registerPasswordAtom,
  registerUsernameAtom,
  registerValidationAtom,
  resetLoginFormAtom,
  resetRegisterFormAtom,
} from "@/atoms/auth-form";
import { authErrorAtom } from "@/atoms/auth";
import { validateLogin, validateRegister } from "@/lib/auth-validation";

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
    };
    store.set(registerUsernameAtom, fields.username);
    store.set(registerNameAtom, fields.name);
    store.set(registerEmailAtom, fields.email);
    store.set(registerPasswordAtom, fields.password);
    store.set(registerConfirmPasswordAtom, fields.confirmPassword);

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
    expect(store.get(registerValidationAtom)).toBeNull();
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
    store.set(authErrorAtom, "Username already taken");

    store.set(resetRegisterFormAtom);

    expect(store.get(registerUsernameAtom)).toBe("");
    expect(store.get(registerNameAtom)).toBe("");
    expect(store.get(registerEmailAtom)).toBe("");
    expect(store.get(registerPasswordAtom)).toBe("");
    expect(store.get(registerConfirmPasswordAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
  });
});
