import { describe, expect, it } from "vitest";
import {
  BIO_MAX_LENGTH,
  BIO_TOO_LONG_MESSAGE,
  DOB_INVALID_MESSAGE,
  DOB_UNDER_AGE_MESSAGE,
  hasCompletedOnboarding,
  hasCurrentLegalConsent,
  isAllowedUsernameCharset,
  isAtLeastYearsOld,
  isBioWithinLimit,
  isLocalePreference,
  isThemePreference,
  LOCALE_PREFERENCE_INVALID_MESSAGE,
  LOCALE_PREFERENCES,
  MINIMUM_AGE_YEARS,
  normalizeUsername,
  parseDateOfBirthParts,
  parseDateOnlyParts,
  LEGAL_ACCEPTANCE_REQUIRED_MESSAGE,
  LEGAL_VERSION,
  THEME_PREFERENCE_INVALID_MESSAGE,
  THEME_PREFERENCES,
  USERNAME_CHARACTERS_MESSAGE,
  USERNAME_LENGTH_MESSAGE,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  usernameRuleViolation,
} from "@my-tuums/auth/rules";

/**
 * The account rules, tested through the one interface every surface uses.
 *
 * This file replaces a pair of drift assertions that only proved two copies of
 * the bio limit still agreed. There is one copy now, so the interesting
 * questions are about the rule itself: what a date-of-birth parse accepts,
 * where the age boundary falls, which handles pass. The Better Auth hooks
 * (`packages/auth/src/dob.ts`, `packages/auth/src/profile.ts`) and the browser
 * forms (`apps/web/src/lib/auth-validation.ts`) are tested only for what they
 * add on top — `APIError` translation and required-field policy respectively.
 *
 * It is a `*.test.ts` and not a `*.int.test.ts`, which is itself the point:
 * `@my-tuums/auth/rules` imports nothing, so it needs no database, no
 * environment and no Better Auth instance. The old test had to be an
 * integration test because reaching the same constants meant importing a
 * module that pulls in `@my-tuums/db`. That is the property that makes the
 * subpath safe for the browser bundle too.
 */

/** A fixed "today" so the age boundary is a property of the rule, not of the calendar. */
const TODAY = new Date(Date.UTC(2026, 7, 14));

describe("date-of-birth parsing", () => {
  it("accepts the strict YYYY-MM-DD form and nothing looser", () => {
    expect(parseDateOnlyParts("1995-01-01")).toEqual({ y: 1995, m: 1, d: 1 });

    for (const malformed of [
      "not-a-date",
      "1995/01/01",
      "01-01-1995",
      "1995-1-1",
      "19950101",
      "",
    ]) {
      expect(parseDateOnlyParts(malformed)).toBeNull();
    }
  });

  it("rejects calendar-impossible dates, which Date would roll over silently", () => {
    // Each of these is a day `new Date()` happily turns into a different one.
    expect(parseDateOnlyParts("1995-02-30")).toBeNull();
    expect(parseDateOnlyParts("2025-13-01")).toBeNull();
    expect(parseDateOnlyParts("2025-00-10")).toBeNull();
    // A real leap day is not impossible.
    expect(parseDateOnlyParts("1996-02-29")).toEqual({ y: 1996, m: 2, d: 29 });
  });

  it("reads the wire forms a hook actually receives", () => {
    // What `dateOfBirthToIso` sends, what the adapter may have coerced, and
    // the bare date-only form — all the same day, read through UTC.
    const expected = { y: 1995, m: 1, d: 1 };
    expect(parseDateOfBirthParts("1995-01-01")).toEqual(expected);
    expect(parseDateOfBirthParts("1995-01-01T00:00:00.000Z")).toEqual(expected);
    expect(parseDateOfBirthParts("  1995-01-01  ")).toEqual(expected);
    expect(parseDateOfBirthParts(new Date("1995-01-01T00:00:00.000Z"))).toEqual(expected);
    expect(parseDateOfBirthParts(Date.UTC(1995, 0, 1))).toEqual(expected);
  });

  it("rejects an impossible date even when a time component follows it", () => {
    // The regression this guards: without a calendar check on the date half,
    // "1995-02-30T…" reaches `new Date()` and is stored as March 2.
    expect(parseDateOfBirthParts("1995-02-30T00:00:00.000Z")).toBeNull();
  });

  it("treats absence as absence rather than as an invalid value", () => {
    // The hook distinguishes the two — an absent date of birth is legitimate
    // (OAuth sign-ups arrive with none) — so the parse must not conflate them
    // with garbage by, say, returning today.
    for (const absent of [null, undefined, "", "   "]) {
      expect(parseDateOfBirthParts(absent)).toBeNull();
    }
    expect(parseDateOfBirthParts("garbage")).toBeNull();
    expect(parseDateOfBirthParts(new Date("garbage"))).toBeNull();
    expect(parseDateOfBirthParts({ date: "1995-01-01" })).toBeNull();
  });
});

describe("age comparison", () => {
  it("passes someone born exactly the minimum age ago today — the cutoff is inclusive", () => {
    expect(isAtLeastYearsOld({ y: 2011, m: 8, d: 14 }, MINIMUM_AGE_YEARS, TODAY)).toBe(true);
  });

  it("fails someone one day short of it", () => {
    expect(isAtLeastYearsOld({ y: 2011, m: 8, d: 15 }, MINIMUM_AGE_YEARS, TODAY)).toBe(false);
  });

  it("passes anyone older and fails a date in the future", () => {
    expect(isAtLeastYearsOld({ y: 1995, m: 1, d: 1 }, MINIMUM_AGE_YEARS, TODAY)).toBe(true);
    expect(isAtLeastYearsOld({ y: 2027, m: 1, d: 1 }, MINIMUM_AGE_YEARS, TODAY)).toBe(false);
  });

  it("defaults to the app's own minimum age", () => {
    expect(isAtLeastYearsOld({ y: 2011, m: 8, d: 14 }, undefined, TODAY)).toBe(true);
    expect(isAtLeastYearsOld({ y: 2011, m: 8, d: 15 }, undefined, TODAY)).toBe(false);
  });
});

describe("username rules", () => {
  it("normalizes valid mixed-case input to the one stored and displayed form", () => {
    expect(normalizeUsername("Alex-Mercer_1")).toBe("alex-mercer_1");
  });

  it("enforces the bounds inclusively, then the charset", () => {
    const cases: readonly (readonly [string, string | null])[] = [
      ["alice", null],
      ["ok_-1", null],
      ["ab", USERNAME_LENGTH_MESSAGE],
      ["a".repeat(USERNAME_MAX_LENGTH + 1), USERNAME_LENGTH_MESSAGE],
      // Both bounds are inclusive.
      ["a".repeat(USERNAME_MIN_LENGTH), null],
      ["a".repeat(USERNAME_MAX_LENGTH), null],
      ["ali.ce", USERNAME_CHARACTERS_MESSAGE],
      ["ali ce", USERNAME_CHARACTERS_MESSAGE],
      ["alice!", USERNAME_CHARACTERS_MESSAGE],
      // Length is reported before charset — the rule a person fixes first.
      ["a!", USERNAME_LENGTH_MESSAGE],
    ];

    expect(cases.map(([handle]) => [handle, usernameRuleViolation(handle)])).toEqual(
      cases.map(([handle, expected]) => [handle, expected]),
    );
  });

  it("exposes the charset check on its own, for the BetterAuth plugin's usernameValidator", () => {
    // The plugin applies its own length bounds and calls this for the rest, so
    // this predicate must say nothing about length.
    expect(isAllowedUsernameCharset("a")).toBe(true);
    expect(isAllowedUsernameCharset("a".repeat(100))).toBe(true);
    expect(isAllowedUsernameCharset("a.b")).toBe(false);
    expect(isAllowedUsernameCharset("")).toBe(false);
  });

  it("does not carry regex state between calls", () => {
    // A `/g` regex would make `test` alternate for the same input; the two
    // handle forms and the plugin all share this one predicate.
    expect(isAllowedUsernameCharset("alice")).toBe(true);
    expect(isAllowedUsernameCharset("alice")).toBe(true);
  });
});

describe("onboarding completeness", () => {
  const complete = { username: "alice", dateOfBirth: "1995-01-01" };

  it("passes a claimed handle with a date of birth at or above the minimum age", () => {
    // The age boundary is the same `isAtLeastYearsOld` cutoff, checked against
    // the same fixed "today" the other age tests use.
    expect(hasCompletedOnboarding(complete, TODAY)).toBe(true);
    expect(hasCompletedOnboarding({ username: "alice", dateOfBirth: "2011-08-14" }, TODAY)).toBe(
      true,
    );
  });

  it("refuses a session that never claimed a handle — the OAuth-incomplete shape", () => {
    expect(hasCompletedOnboarding({ username: null, dateOfBirth: "1995-01-01" }, TODAY)).toBe(
      false,
    );
    expect(hasCompletedOnboarding({ username: undefined, dateOfBirth: "1995-01-01" }, TODAY)).toBe(
      false,
    );
    // An empty handle is a missing field, not a claimed one.
    expect(hasCompletedOnboarding({ username: "", dateOfBirth: "1995-01-01" }, TODAY)).toBe(false);
  });

  it("fails a session with no date of birth, whatever the handle", () => {
    for (const absent of [null, undefined, ""]) {
      expect(hasCompletedOnboarding({ username: "alice", dateOfBirth: absent }, TODAY)).toBe(false);
    }
  });

  it("fails a date of birth one day below the minimum age", () => {
    expect(hasCompletedOnboarding({ username: "alice", dateOfBirth: "2011-08-15" }, TODAY)).toBe(
      false,
    );
  });

  it("fails a malformed date of birth rather than trusting it", () => {
    expect(hasCompletedOnboarding({ username: "alice", dateOfBirth: "not-a-date" }, TODAY)).toBe(
      false,
    );
    expect(hasCompletedOnboarding({ username: "alice", dateOfBirth: "1995-02-30" }, TODAY)).toBe(
      false,
    );
  });

  it("reads the session shapes the adapter actually hands back", () => {
    // A `Date` (the timestamp column) and an ISO string must both count as a
    // declared date of birth — the gate reads the session, not the form.
    expect(
      hasCompletedOnboarding({ username: "alice", dateOfBirth: new Date("1995-01-01") }, TODAY),
    ).toBe(true);
    expect(
      hasCompletedOnboarding({ username: "alice", dateOfBirth: "1995-01-01T00:00:00.000Z" }, TODAY),
    ).toBe(true);
  });
});

describe("bio limit", () => {
  it("is inclusive at the bound", () => {
    expect(isBioWithinLimit("")).toBe(true);
    expect(isBioWithinLimit("x".repeat(BIO_MAX_LENGTH))).toBe(true);
    expect(isBioWithinLimit("x".repeat(BIO_MAX_LENGTH + 1))).toBe(false);
  });

  it("counts UTF-16 code units, the same unit String.length gives the hook", () => {
    // An emoji costing two is a rough edge, but it is one the counter under
    // the field and the server check share — that is the property that matters.
    expect("😀").toHaveLength(2);
    expect(isBioWithinLimit("😀".repeat(BIO_MAX_LENGTH / 2))).toBe(true);
    expect(isBioWithinLimit(`${"😀".repeat(BIO_MAX_LENGTH / 2)}x`)).toBe(false);
  });
});

describe("stored preferences", () => {
  it("offers exactly the values the settings page renders", () => {
    // `apps/web/src/atoms/theme.ts` narrows to exactly these three and
    // `preferences-section.tsx` renders one button per value; Paraglide's
    // `locales` is the other half of the locale list. A value here the app
    // does not render is a dead option; one the app renders and this list
    // omits is a button the server rejects.
    expect([...THEME_PREFERENCES]).toEqual(["light", "dark", "system"]);
    expect([...LOCALE_PREFERENCES]).toEqual(["en", "fr"]);
  });

  it("excludes anything else — the list is the whole rule", () => {
    const unknown = ["", "  ", "sepia", "System", "en-GB", "de"];
    expect(THEME_PREFERENCES.every(isThemePreference)).toBe(true);
    expect(LOCALE_PREFERENCES.every(isLocalePreference)).toBe(true);
    expect(unknown.filter(isThemePreference)).toEqual([]);
    expect(unknown.filter(isLocalePreference)).toEqual([]);
  });
});

/**
 * The messages are written out rather than built from the bounds, because each
 * one is also a lookup key in `apps/web/src/lib/auth-error-message.ts` — an
 * interpolated sentence would silently stop matching the day a bound changed,
 * and a server rejection would render untranslated with nothing failing. These
 * assertions are what turn that into a failing test instead.
 */
/**
 * Moved here from `procedures.int.test.ts`, where the two pure-condition cases
 * were being proved through Postgres fixtures for a predicate with no database
 * in it. The consent gate's *wiring* (that `protectedProcedure` actually calls
 * this) stays over there.
 */
describe("legal consent predicate", () => {
  it("accepts a current acceptance", () => {
    expect(
      hasCurrentLegalConsent({ legalAcceptedAt: new Date(), legalVersion: LEGAL_VERSION }),
    ).toBe(true);
  });

  it("refuses an acceptance of a superseded version", () => {
    expect(
      hasCurrentLegalConsent({
        legalAcceptedAt: new Date("2020-01-01T00:00:00.000Z"),
        legalVersion: "2020-01-01",
      }),
    ).toBe(false);
  });

  it("refuses a timestamp with no version, and a version with no timestamp — neither half is consent on its own", () => {
    expect(hasCurrentLegalConsent({ legalAcceptedAt: new Date(), legalVersion: null })).toBe(false);
    expect(hasCurrentLegalConsent({ legalAcceptedAt: null, legalVersion: LEGAL_VERSION })).toBe(
      false,
    );
  });
});

describe("rejection messages", () => {
  it("states the bound each one is about", () => {
    expect(BIO_TOO_LONG_MESSAGE).toContain(String(BIO_MAX_LENGTH));
    expect(USERNAME_LENGTH_MESSAGE).toContain(String(USERNAME_MIN_LENGTH));
    expect(USERNAME_LENGTH_MESSAGE).toContain(String(USERNAME_MAX_LENGTH));
    expect(DOB_UNDER_AGE_MESSAGE).toContain(String(MINIMUM_AGE_YEARS));
  });

  it("matches the English literals the web app's translation table is keyed on", () => {
    expect(BIO_TOO_LONG_MESSAGE).toBe("Your bio must be 160 characters or fewer.");
    expect(USERNAME_LENGTH_MESSAGE).toBe("Username must be between 3 and 20 characters long.");
    expect(USERNAME_CHARACTERS_MESSAGE).toBe(
      "Username can only contain letters, numbers, underscores, and hyphens.",
    );
    expect(DOB_INVALID_MESSAGE).toBe("Please enter a valid date of birth.");
    expect(DOB_UNDER_AGE_MESSAGE).toBe("You must be at least 15 years old to create an account.");
    expect(LEGAL_ACCEPTANCE_REQUIRED_MESSAGE).toBe(
      "You must accept the Terms of Service and Privacy Policy to create an account.",
    );
    expect(THEME_PREFERENCE_INVALID_MESSAGE).toBe("Please choose a valid theme.");
    expect(LOCALE_PREFERENCE_INVALID_MESSAGE).toBe("Please choose a valid language.");
  });

  it("pins the legal version to the legal pages' last-updated date", () => {
    expect(LEGAL_VERSION).toBe("2026-09-07");
  });
});
