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

/** A fully valid baseline so each case only has to override the field(s) it cares about. */
const validFields: RegisterFields = {
  username: "alice",
  name: "Alice",
  email: "alice@example.com",
  password: "password1",
  confirmPassword: "password1",
  dateOfBirth: "1995-01-01",
  termsAccepted: true,
};

// The exact strings the rules return. Named here so a table reads as the rule
// it encodes rather than as a wall of repeated sentences — and still asserted
// independently of the source, since these are the test's own copies.
const USERNAME_REQUIRED = "Username is required.";
const USERNAME_LENGTH = "Username must be between 3 and 20 characters long.";
const USERNAME_CHARS = "Username can only contain letters, numbers, underscores, and hyphens.";
const NAME_REQUIRED = "Display Name is required.";
const EMAIL_INVALID = "Please enter a valid email address.";
const PASSWORD_LENGTH = "Password must be at least 8 characters long.";
const PASSWORD_MISMATCH = "Passwords do not match.";
const DOB_REQUIRED = "Date of Birth is required.";
const DOB_INVALID = "Please enter a valid date of birth.";
const DOB_AGE = "You must be at least 15 years old to create an account.";
const TERMS_REQUIRED =
  "You must accept the Terms of Service and Privacy Policy to create an account.";

/** "YYYY-MM-DD" in UTC for the given date. */
function iso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * A date `years` ago (in UTC), nudged by `offsetDays` — used for the 15-year
 * boundary, which the rule computes against its own UTC "today". Relative so
 * the assertions can't quietly stop being true as the calendar moves.
 */
function yearsAgo(years: number, offsetDays = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return iso(d);
}

/**
 * Asserts a whole table in one shot. Comparing mapped arrays rather than
 * looping bare `expect`s means one failing row reports every row at once, with
 * the offending input visible in the diff instead of just the expected message
 * — which is what makes it reasonable to group a rule's boundaries into a
 * single test instead of one test per example.
 */
function expectTable<T>(
  cases: readonly (readonly [T, string | null])[],
  run: (input: T) => string | null,
): void {
  expect(cases.map(([input]) => [input, run(input)])).toEqual(
    cases.map(([input, expected]) => [input, expected]),
  );
}

describe("validateRegister", () => {
  it("returns null when every rule passes", () => {
    expect(validateRegister(validFields)).toBeNull();
  });

  it("enforces the username rules: required, 3-20 characters, and the charset", () => {
    expectTable(
      [
        ["", USERNAME_REQUIRED],
        ["ab", USERNAME_LENGTH],
        ["a".repeat(21), USERNAME_LENGTH],
        // Both bounds are inclusive.
        ["abc", null],
        ["a".repeat(20), null],
        ["a.b", USERNAME_CHARS],
        ["a b", USERNAME_CHARS],
        ["a@b", USERNAME_CHARS],
      ] as const,
      (username) => validateRegister({ ...validFields, username }),
    );
  });

  it("requires a display name", () => {
    expect(validateRegister({ ...validFields, name: "" })).toBe(NAME_REQUIRED);
  });

  it("requires an email with an @", () => {
    expect(validateRegister({ ...validFields, email: "not-an-email" })).toBe(EMAIL_INVALID);
  });

  it("enforces the 8-character password minimum and the confirmation match", () => {
    expectTable(
      [
        [["short12", "short12"], PASSWORD_LENGTH],
        // The minimum is inclusive.
        [["eightch1", "eightch1"], null],
        [["password1", "password2"], PASSWORD_MISMATCH],
      ] as const,
      ([password, confirmPassword]) =>
        validateRegister({ ...validFields, password, confirmPassword }),
    );
  });

  it("requires a date of birth and enforces the 15-year floor at the boundary", () => {
    expectTable(
      [
        ["", DOB_REQUIRED],
        // One day short of 15 fails; exactly 15 and older pass.
        [yearsAgo(15, 1), DOB_AGE],
        [yearsAgo(15), null],
        [yearsAgo(15, -1), null],
      ] as const,
      (dateOfBirth) => validateRegister({ ...validFields, dateOfBirth }),
    );
  });

  it("requires the Terms of Service and Privacy Policy acceptance box", () => {
    expect(validateRegister({ ...validFields, termsAccepted: false })).toBe(TERMS_REQUIRED);
    expect(validateRegister({ ...validFields, termsAccepted: true })).toBeNull();
  });

  // Rule order is the point: a submission violating several rules at once must
  // surface the FIRST one a person would see fixed in the real form, not just
  // any true violation. Each row loosens exactly one field relative to the row
  // above it, so the table reads as the precedence chain itself.
  it("surfaces the first violation when several rules fail at once", () => {
    const cases: readonly (readonly [string, RegisterFields, string])[] = [
      [
        "empty username beats everything",
        {
          username: "",
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
          dateOfBirth: "",
          termsAccepted: true,
        },
        USERNAME_REQUIRED,
      ],
      [
        "username length beats charset, name and email",
        // Too short AND invalid characters.
        {
          username: "a!",
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
          dateOfBirth: "",
          termsAccepted: true,
        },
        USERNAME_LENGTH,
      ],
      [
        "username charset beats name and email",
        // Right length, wrong characters.
        {
          username: "has space",
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
          dateOfBirth: "",
          termsAccepted: true,
        },
        USERNAME_CHARS,
      ],
      [
        "display name beats email and password",
        {
          username: "alice",
          name: "",
          email: "bad",
          password: "1",
          confirmPassword: "2",
          dateOfBirth: "",
          termsAccepted: true,
        },
        NAME_REQUIRED,
      ],
      [
        "email beats password length and mismatch",
        {
          username: "alice",
          name: "Alice",
          email: "bad",
          password: "1",
          confirmPassword: "2",
          dateOfBirth: "",
          termsAccepted: true,
        },
        EMAIL_INVALID,
      ],
      [
        "password length beats password mismatch",
        {
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
          password: "short",
          confirmPassword: "different",
          dateOfBirth: "",
          termsAccepted: true,
        },
        PASSWORD_LENGTH,
      ],
      [
        "password mismatch beats an under-15 date of birth",
        {
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
          password: "password1",
          confirmPassword: "password2",
          dateOfBirth: yearsAgo(15, 1),
          termsAccepted: true,
        },
        PASSWORD_MISMATCH,
      ],
      [
        "date of birth beats terms acceptance",
        {
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
          password: "password1",
          confirmPassword: "password1",
          dateOfBirth: yearsAgo(15, 1),
          termsAccepted: false,
        },
        DOB_AGE,
      ],
      [
        "terms acceptance is the last gate before submit",
        {
          username: "alice",
          name: "Alice",
          email: "alice@example.com",
          password: "password1",
          confirmPassword: "password1",
          dateOfBirth: yearsAgo(15),
          termsAccepted: false,
        },
        TERMS_REQUIRED,
      ],
    ];

    expect(cases.map(([label, fields]) => [label, validateRegister(fields)])).toEqual(
      cases.map(([label, , expected]) => [label, expected]),
    );
  });

  it("trims username, name and email before validating — but never the password", () => {
    expect(validateRegister({ ...validFields, username: "  alice  " })).toBeNull();
    expect(validateRegister({ ...validFields, name: "  Alice  " })).toBeNull();
    expect(validateRegister({ ...validFields, email: "  alice@example.com  " })).toBeNull();

    // 8 spaces is a legitimate length-8 password...
    const eightSpaces = "        ";
    expect(eightSpaces).toHaveLength(8);
    expect(
      validateRegister({ ...validFields, password: eightSpaces, confirmPassword: eightSpaces }),
    ).toBeNull();

    // ...and a trailing space makes it a different password, not the same one.
    expect(
      validateRegister({ ...validFields, password: "password1", confirmPassword: "password1 " }),
    ).toBe(PASSWORD_MISMATCH);
  });
});

describe("validateLogin", () => {
  it("requires both fields, and names the one that is missing", () => {
    expect(validateLogin({ identifier: "alice", password: "whatever" })).toBeNull();
    expect(validateLogin({ identifier: "   ", password: "whatever" })).toBe(
      "Please enter your username or email address.",
    );
    expect(validateLogin({ identifier: "alice", password: "" })).toBe(
      "Please enter your password.",
    );
  });
});

/**
 * `validateEmail` was extracted from `validateRegister` so `/forgot-password`
 * can enforce the same email rule a sign-up goes through — same drift-guard as
 * `validateUsername` below.
 */
describe("validateEmail", () => {
  it("requires presence and an @, trimming first", () => {
    expectTable(
      [
        ["alice@example.com", null],
        ["  alice@example.com  ", null],
        ["", EMAIL_INVALID],
        ["   ", EMAIL_INVALID],
        ["not-an-email", EMAIL_INVALID],
        ["no-at-sign.example", EMAIL_INVALID],
        // The rule is deliberately shallow — presence and an `@` — so "a@b@c"
        // passes here exactly as it passes the register path. A stricter client
        // rule would reject addresses the server's zod schema accepts, and that
        // schema is the real validator.
        ["a@b@c", null],
      ] as const,
      validateEmail,
    );
  });

  it("agrees with validateRegister on every address — the two must not drift", () => {
    const emails = ["", "  ", "not-an-email", "a@b@c", "alice@example.com", " alice@example.com "];

    expect(emails.map((email) => [email, validateRegister({ ...validFields, email })])).toEqual(
      emails.map((email) => [email, validateEmail(email)]),
    );
  });
});

describe("validateResetPassword", () => {
  it("enforces the 8-character minimum and the match, length first", () => {
    expectTable(
      [
        [["password1", "password1"], null],
        [["short12", "short12"], PASSWORD_LENGTH],
        // The minimum is inclusive.
        [["eightch1", "eightch1"], null],
        [["password1", "password2"], PASSWORD_MISMATCH],
        // Length beats mismatch — the rule a person would fix first surfaces first.
        [["short", "different"], PASSWORD_LENGTH],
      ] as const,
      ([newPassword, confirmPassword]) => validateResetPassword({ newPassword, confirmPassword }),
    );
  });

  it("never trims the password, for either the length or the match check", () => {
    const eightSpaces = "        ";
    expect(eightSpaces).toHaveLength(8);
    expect(
      validateResetPassword({ newPassword: eightSpaces, confirmPassword: eightSpaces }),
    ).toBeNull();
    expect(validateResetPassword({ newPassword: "password1", confirmPassword: "password1 " })).toBe(
      PASSWORD_MISMATCH,
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
  it("enforces required, the 3-20 bound and the charset, trimming first", () => {
    expectTable(
      [
        ["alice", null],
        ["", USERNAME_REQUIRED],
        ["   ", USERNAME_REQUIRED],
        ["ab", USERNAME_LENGTH],
        ["a".repeat(21), USERNAME_LENGTH],
        // Both bounds are inclusive.
        ["abc", null],
        ["a".repeat(20), null],
        // Trimmed before measuring, so padding can't smuggle a short handle through.
        ["  ab  ", USERNAME_LENGTH],
        ["  alice  ", null],
        ["alice!", USERNAME_CHARS],
        ["ali ce", USERNAME_CHARS],
        ["ali.ce", USERNAME_CHARS],
      ] as const,
      validateUsername,
    );
  });

  it("agrees with validateRegister on every handle — the two must not drift", () => {
    const handles = ["", "  ", "ab", "abc", "a".repeat(20), "a".repeat(21), "ok_-1", "bad!"];

    // `validateRegister` only continues past the handle once it is valid, so a
    // null here means the later rules took over — which for `validFields` also
    // means null.
    expect(
      handles.map((username) => [username, validateRegister({ ...validFields, username })]),
    ).toEqual(handles.map((username) => [username, validateUsername(username)]));
  });
});

describe("validateTwoFactorCode", () => {
  it("requires presence and nothing more — no length or format guess", () => {
    expectTable(
      [
        ["123456", null],
        // Backup codes are not digits, and the same box accepts them.
        ["ABCD-EFGH", null],
        ["", "Please enter your verification code."],
        ["   ", "Please enter your verification code."],
        // A client-side format rule would reject codes the server accepts.
        ["1", null],
        ["12345678901234567890", null],
      ] as const,
      validateTwoFactorCode,
    );
  });
});

describe("validateDateOfBirth", () => {
  it("requires a well-formed YYYY-MM-DD date", () => {
    expectTable(
      [
        ["1995-01-01", null],
        ["  1995-01-01  ", null],
        ["", DOB_REQUIRED],
        ["   ", DOB_REQUIRED],
        ["not-a-date", DOB_INVALID],
        ["1995/01/01", DOB_INVALID],
        ["01-01-1995", DOB_INVALID],
        ["1995-1-1", DOB_INVALID],
        ["19950101", DOB_INVALID],
      ] as const,
      validateDateOfBirth,
    );
  });

  it("rejects calendar-impossible dates, which Date would roll over silently", () => {
    expectTable(
      [
        ["1995-02-30", DOB_INVALID],
        ["2025-13-01", DOB_INVALID],
        ["2025-00-10", DOB_INVALID],
        // A real leap day is not impossible.
        ["1996-02-29", null],
      ] as const,
      validateDateOfBirth,
    );
  });

  it("enforces the 15-year floor at the boundary, and rejects the future", () => {
    expectTable(
      [
        ["1995-01-01", null],
        [yearsAgo(15), null],
        [yearsAgo(15, 1), DOB_AGE],
        [yearsAgo(-1), DOB_AGE],
      ] as const,
      validateDateOfBirth,
    );
  });
});

describe("date-of-birth wire formats", () => {
  it("round-trips YYYY-MM-DD through UTC midnight", () => {
    expect(dateOfBirthToIso("1995-01-01")).toBe("1995-01-01T00:00:00.000Z");
    expect(dateOfBirthInputValue(new Date("1995-01-01T00:00:00.000Z"))).toBe("1995-01-01");
    expect(dateOfBirthInputValue("1995-01-01T00:00:00.000Z")).toBe("1995-01-01");
  });

  it("yields '' for anything unparseable", () => {
    expectTable(
      [
        [null, ""],
        [undefined, ""],
        ["", ""],
        ["garbage", ""],
      ] as const,
      (value) => {
        // SAFETY: the fixture table feeds every entry through the one parsing
        // entry-point under test; the cast keeps the table heterogeneous.
        return dateOfBirthInputValue(value);
      },
    );
  });
});
