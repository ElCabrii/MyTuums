import { describe, expect, it } from "vitest";
import {
  dateOfBirthInputValue,
  dateOfBirthToIso,
  validateDateOfBirth,
  validateEmail,
  validateLogin,
  validateRegister,
  validateResetPassword,
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
  dateOfBirth: "1995-01-01",
};

/** "YYYY-MM-DD" in UTC for the given date. */
function iso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * A date `years` ago (in UTC), nudged by `offsetDays` — used for the 15-year
 * boundary, which the rule computes against its own UTC "today".
 */
function yearsAgo(years: number, offsetDays = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return iso(d);
}

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

  it("rejects a missing date of birth", () => {
    expect(validateRegister({ ...validFields, dateOfBirth: "" })).toBe(
      "Date of Birth is required.",
    );
  });

  it("rejects an under-15 date of birth", () => {
    expect(validateRegister({ ...validFields, dateOfBirth: yearsAgo(15, 1) })).toBe(
      "You must be at least 15 years old to create an account.",
    );
  });

  it("accepts a date of birth of exactly 15 years ago", () => {
    expect(validateRegister({ ...validFields, dateOfBirth: yearsAgo(15) })).toBeNull();
  });

  it("accepts a date of birth older than 15", () => {
    expect(validateRegister({ ...validFields, dateOfBirth: yearsAgo(15, -1) })).toBeNull();
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
          dateOfBirth: "",
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
          dateOfBirth: "",
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
          dateOfBirth: "",
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
          dateOfBirth: "",
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
          dateOfBirth: "",
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
          dateOfBirth: "",
        }),
      ).toBe("Password must be at least 8 characters long.");
    });

    it("password mismatch beats an under-15 date of birth once password length passes", () => {
      expect(
        validateRegister({
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
          password: "password1",
          confirmPassword: "password2",
          dateOfBirth: yearsAgo(15, 1),
        }),
      ).toBe("Passwords do not match.");
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
 * `validateEmail` was extracted from `validateRegister` so `/forgot-password`
 * can enforce the same email rule a sign-up goes through — same drift-guard as
 * `validateUsername` above.
 */
describe("validateEmail", () => {
  it("accepts an address with an @", () => {
    expect(validateEmail("alice@example.com")).toBeNull();
  });

  it("trims surrounding whitespace before checking", () => {
    expect(validateEmail("  alice@example.com  ")).toBeNull();
  });

  it.each([[""], ["   "]])("rejects %j as invalid", (raw) => {
    expect(validateEmail(raw)).toBe("Please enter a valid email address.");
  });

  it.each([["not-an-email"], ["no-at-sign.example"]])(
    "rejects the malformed address %j",
    (raw) => {
      expect(validateEmail(raw)).toBe("Please enter a valid email address.");
    },
  );

  // The rule is deliberately shallow — presence and an `@` — so "a@b@c"
  // passes here exactly as it passes the server-side shape check's register
  // path; the server's zod schema is the real validator.
  it("does not guess at shape beyond the @ — a stricter client rule would reject addresses the server accepts", () => {
    expect(validateEmail("a@b@c")).toBeNull();
  });

  it("agrees with validateRegister on every address — the two must not drift", () => {
    const emails = ["", "  ", "not-an-email", "a@b@c", "alice@example.com", " alice@example.com "];

    for (const email of emails) {
      expect(validateRegister({ ...validFields, email })).toBe(validateEmail(email));
    }
  });
});

describe("validateResetPassword", () => {
  it("returns null when the pair matches and is long enough", () => {
    expect(
      validateResetPassword({ newPassword: "password1", confirmPassword: "password1" }),
    ).toBeNull();
  });

  it("rejects a password under 8 characters", () => {
    expect(
      validateResetPassword({ newPassword: "short12", confirmPassword: "short12" }),
    ).toBe("Password must be at least 8 characters long.");
  });

  it("accepts a password of exactly 8 characters", () => {
    expect(
      validateResetPassword({ newPassword: "eightch1", confirmPassword: "eightch1" }),
    ).toBeNull();
  });

  it("rejects mismatched passwords", () => {
    expect(
      validateResetPassword({ newPassword: "password1", confirmPassword: "password2" }),
    ).toBe("Passwords do not match.");
  });

  it("length beats mismatch — the rule a person would fix first surfaces first", () => {
    expect(
      validateResetPassword({ newPassword: "short", confirmPassword: "different" }),
    ).toBe("Password must be at least 8 characters long.");
  });

  it("does NOT trim the password — 8 spaces is accepted as a length-8 password", () => {
    const eightSpaces = "        ";
    expect(eightSpaces).toHaveLength(8);
    expect(
      validateResetPassword({ newPassword: eightSpaces, confirmPassword: eightSpaces }),
    ).toBeNull();
  });

  it("does NOT trim the password for the mismatch check — a trailing space makes it a different password", () => {
    expect(
      validateResetPassword({ newPassword: "password1", confirmPassword: "password1 " }),
    ).toBe("Passwords do not match.");
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

describe("validateDateOfBirth", () => {
  it("accepts a date of birth older than 15", () => {
    expect(validateDateOfBirth("1995-01-01")).toBeNull();
  });

  it("accepts a date of birth exactly 15 years ago", () => {
    expect(validateDateOfBirth(yearsAgo(15))).toBeNull();
  });

  it("rejects a date of birth 15 years ago minus one day", () => {
    expect(validateDateOfBirth(yearsAgo(15, 1))).toBe(
      "You must be at least 15 years old to create an account.",
    );
  });

  it("rejects a future date of birth", () => {
    expect(validateDateOfBirth(yearsAgo(-1))).toBe(
      "You must be at least 15 years old to create an account.",
    );
  });

  it("trims surrounding whitespace before checking", () => {
    expect(validateDateOfBirth("  1995-01-01  ")).toBeNull();
  });

  it.each([[""], ["   "]])("rejects %j as required", (raw) => {
    expect(validateDateOfBirth(raw)).toBe("Date of Birth is required.");
  });

  it.each([
    ["not-a-date"],
    ["1995/01/01"],
    ["01-01-1995"],
    ["1995-1-1"],
    ["19950101"],
  ])("rejects the malformed date %j", (raw) => {
    expect(validateDateOfBirth(raw)).toBe("Please enter a valid date of birth.");
  });

  it.each([["1995-02-30"], ["2025-13-01"], ["2025-00-10"]])(
    "rejects the calendar-impossible date %j (Date would roll it over silently)",
    (raw) => {
      expect(validateDateOfBirth(raw)).toBe("Please enter a valid date of birth.");
    },
  );

  it("accepts a leap-day date of birth", () => {
    expect(validateDateOfBirth("1996-02-29")).toBeNull();
  });
});

describe("date-of-birth wire formats", () => {
  it("pins a date to UTC midnight for the wire", () => {
    expect(dateOfBirthToIso("1995-01-01")).toBe("1995-01-01T00:00:00.000Z");
  });

  it("reads a Date back as YYYY-MM-DD through UTC parts", () => {
    expect(dateOfBirthInputValue(new Date("1995-01-01T00:00:00.000Z"))).toBe("1995-01-01");
  });

  it("reads an ISO string back as YYYY-MM-DD", () => {
    expect(dateOfBirthInputValue("1995-01-01T00:00:00.000Z")).toBe("1995-01-01");
  });

  it.each([[null], [undefined], [""], ["garbage"]])("yields '' for %j", (value) => {
    expect(dateOfBirthInputValue(value as never)).toBe("");
  });
});
