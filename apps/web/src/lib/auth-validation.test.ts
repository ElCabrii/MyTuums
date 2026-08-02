import { describe, expect, it } from "vitest";
import {
  validateLogin,
  validateRegister,
  validateTwoFactorCode,
  validateUsername,
  type RegisterFields,
} from "@/lib/auth-validation";

/** A fully valid baseline so each test only has to override the field(s) it cares about. */
const validFields: RegisterFields = {
  username: "alice",
  name: "Alice",
  email: "alice@example.com",
  password: "password1",
  confirmPassword: "password1",
};

describe("validateRegister", () => {
  it("returns null when every rule passes", () => {
    expect(validateRegister(validFields)).toBeNull();
  });

  it("rejects an empty username", () => {
    expect(validateRegister({ ...validFields, username: "" })).toBe("Username is required.");
  });

  it("rejects a username under 3 characters", () => {
    expect(validateRegister({ ...validFields, username: "ab" })).toBe(
      "Username must be between 3 and 20 characters long.",
    );
  });

  it("rejects a username over 20 characters", () => {
    expect(validateRegister({ ...validFields, username: "a".repeat(21) })).toBe(
      "Username must be between 3 and 20 characters long.",
    );
  });

  it("accepts a username of exactly 3 characters", () => {
    expect(validateRegister({ ...validFields, username: "abc" })).toBeNull();
  });

  it("accepts a username of exactly 20 characters", () => {
    expect(validateRegister({ ...validFields, username: "a".repeat(20) })).toBeNull();
  });

  it.each([["a.b"], ["a b"], ["a@b"]])(
    "rejects a username containing an invalid character (%s)",
    (username) => {
      expect(validateRegister({ ...validFields, username })).toBe(
        "Username can only contain letters, numbers, underscores, and hyphens.",
      );
    },
  );

  it("rejects an empty display name", () => {
    expect(validateRegister({ ...validFields, name: "" })).toBe("Display Name is required.");
  });

  it("rejects an email without an @", () => {
    expect(validateRegister({ ...validFields, email: "not-an-email" })).toBe(
      "Please enter a valid email address.",
    );
  });

  it("rejects a password under 8 characters", () => {
    expect(
      validateRegister({ ...validFields, password: "short12", confirmPassword: "short12" }),
    ).toBe("Password must be at least 8 characters long.");
  });

  it("accepts a password of exactly 8 characters", () => {
    expect(
      validateRegister({ ...validFields, password: "eightch1", confirmPassword: "eightch1" }),
    ).toBeNull();
  });

  it("rejects mismatched passwords", () => {
    expect(validateRegister({ ...validFields, password: "password1", confirmPassword: "password2" })).toBe(
      "Passwords do not match.",
    );
  });

  // Rule order is the point: a submission violating several rules at once must
  // surface the FIRST one a person would see fixed in the real form, not just
  // any true violation.
  describe("rule order — first violation wins even when several rules fail at once", () => {
    it("empty username beats every other violation", () => {
      expect(
        validateRegister({
          username: "",
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
        }),
      ).toBe("Username is required.");
    });

    it("username length beats username characters, name, and email", () => {
      expect(
        validateRegister({
          username: "a!", // too short AND invalid characters
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
        }),
      ).toBe("Username must be between 3 and 20 characters long.");
    });

    it("username characters beats name and email once length passes", () => {
      expect(
        validateRegister({
          username: "has space", // right length, wrong characters
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
        }),
      ).toBe("Username can only contain letters, numbers, underscores, and hyphens.");
    });

    it("display name beats email and password once the username passes", () => {
      expect(
        validateRegister({
          username: "alice",
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
        }),
      ).toBe("Display Name is required.");
    });

    it("email beats password length and mismatch once name passes", () => {
      expect(
        validateRegister({
          username: "alice",
          name: "Alice",
          email: "bad",
          password: "1",
          confirmPassword: "2",
        }),
      ).toBe("Please enter a valid email address.");
    });

    it("password length beats password mismatch once email passes", () => {
      expect(
        validateRegister({
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
          password: "short",
          confirmPassword: "different",
        }),
      ).toBe("Password must be at least 8 characters long.");
    });
  });

  describe("trimming — username/name/email trimmed, password is not", () => {
    it("trims surrounding whitespace off the username before validating it", () => {
      expect(validateRegister({ ...validFields, username: "  alice  " })).toBeNull();
    });

    it("trims surrounding whitespace off the name before validating it", () => {
      expect(validateRegister({ ...validFields, name: "  Alice  " })).toBeNull();
    });

    it("trims surrounding whitespace off the email before validating it", () => {
      expect(validateRegister({ ...validFields, email: "  alice@example.com  " })).toBeNull();
    });

    it("does NOT trim the password — 8 spaces is accepted as a length-8 password", () => {
      const eightSpaces = "        ";
      expect(eightSpaces).toHaveLength(8);
      expect(
        validateRegister({ ...validFields, password: eightSpaces, confirmPassword: eightSpaces }),
      ).toBeNull();
    });

    it("does NOT trim the password for the mismatch check — a trailing space makes it a different password", () => {
      expect(
        validateRegister({
          ...validFields,
          password: "password1",
          confirmPassword: "password1 ",
        }),
      ).toBe("Passwords do not match.");
    });
  });
});

describe("validateLogin", () => {
  it("returns null when both fields are present", () => {
    expect(validateLogin({ identifier: "alice", password: "whatever" })).toBeNull();
  });

  it("rejects a whitespace-only identifier", () => {
    expect(validateLogin({ identifier: "   ", password: "whatever" })).toBe(
      "Please enter your username or email address.",
    );
  });

  it("rejects an empty password", () => {
    expect(validateLogin({ identifier: "alice", password: "" })).toBe(
      "Please enter your password.",
    );
  });
});

/**
 * `validateUsername` was extracted from `validateRegister` so `/welcome` can
 * enforce the same handle rules a social sign-up never went through. The
 * property worth locking down is that the two agree — if they ever diverge,
 * one form accepts a handle the other rejects and both look broken.
 */
describe("validateUsername", () => {
  it("accepts a valid handle", () => {
    expect(validateUsername("alice")).toBeNull();
  });

  it("trims before measuring, so padding can't smuggle a short handle through", () => {
    expect(validateUsername("  ab  ")).toBe("Username must be between 3 and 20 characters long.");
    expect(validateUsername("  alice  ")).toBeNull();
  });

  it.each([
    ["", "Username is required."],
    ["   ", "Username is required."],
    ["ab", "Username must be between 3 and 20 characters long."],
    ["a".repeat(21), "Username must be between 3 and 20 characters long."],
    ["alice!", "Username can only contain letters, numbers, underscores, and hyphens."],
    ["ali ce", "Username can only contain letters, numbers, underscores, and hyphens."],
    ["ali.ce", "Username can only contain letters, numbers, underscores, and hyphens."],
  ])("rejects %j", (username, expected) => {
    expect(validateUsername(username)).toBe(expected);
  });

  it.each([["abc"], ["a".repeat(20)]])("accepts the boundary length %j", (username) => {
    expect(validateUsername(username)).toBeNull();
  });

  it("agrees with validateRegister on every handle — the two must not drift", () => {
    const handles = ["", "  ", "ab", "abc", "a".repeat(20), "a".repeat(21), "ok_-1", "bad!"];

    for (const username of handles) {
      const standalone = validateUsername(username);
      const throughRegister = validateRegister({ ...validFields, username });

      // `validateRegister` only continues past the handle once it is valid, so
      // a null here means the later rules took over — which for `validFields`
      // also means null.
      expect(throughRegister).toBe(standalone);
    }
  });
});

describe("validateTwoFactorCode", () => {
  it("accepts anything non-empty", () => {
    expect(validateTwoFactorCode("123456")).toBeNull();
    // Backup codes are not digits, and the same box accepts them.
    expect(validateTwoFactorCode("ABCD-EFGH")).toBeNull();
  });

  it.each([[""], ["   "]])("rejects %j", (code) => {
    expect(validateTwoFactorCode(code)).toBe("Please enter your verification code.");
  });

  it("does not guess at length — a client-side format rule would reject codes the server accepts", () => {
    expect(validateTwoFactorCode("1")).toBeNull();
    expect(validateTwoFactorCode("12345678901234567890")).toBeNull();
  });
});
