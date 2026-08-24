/**
 * The account rules — the ones the browser, the Better Auth hooks and the oRPC
 * procedures must all agree on, stated once.
 *
 * ## Why this module lives in `packages/auth`
 *
 * `packages/auth` is where these rules are *enforced*: bios, preferences and
 * dates of birth are written through `authClient.updateUser`, so the database
 * hooks in `./dob.ts` and `./profile.ts` are the only place a rule actually
 * holds. `packages/api` already depends on `packages/auth`, so putting the
 * shared statement here lets every consumer reach it without closing a cycle —
 * `packages/auth` importing `@my-tuums/api` would.
 *
 * ## Why this file has no imports, and must not gain any
 *
 * The browser reads it as `@my-tuums/auth/rules`
 * (`apps/web/src/lib/auth-validation.ts`), which is the only part of this
 * package `apps/web` may import. The package root pulls in `better-auth` and
 * `@my-tuums/db`, and the latter reads `DATABASE_URL` at module scope and
 * throws on import — so the subpath is browser-safe exactly as long as its
 * module graph stays this one file. That is the same guarantee
 * `@my-tuums/api/constants` carries, and it is asserted the same way:
 * `packages/api/src/account-rules.test.ts` imports this module from the *unit*
 * project, which runs with no database environment at all.
 *
 * ## What is deliberately NOT here
 *
 * The rules, not the plumbing that applies them. `APIError` translation and
 * the Better Auth `additionalFields`/`input: false` declarations stay in
 * `./dob.ts`, `./profile.ts` and `./index.ts`; the provider-image and
 * original-image protections stay in `./profile.ts` because they are server
 * authority rather than shared knowledge; form orchestration and the browser's
 * "this field is required" policy stay in
 * `apps/web/src/lib/auth-validation.ts`. Nothing here throws, and nothing here
 * knows which side is calling.
 *
 * ## Why the messages are literals rather than built from the bounds
 *
 * Each string below is also a *lookup key* in
 * `apps/web/src/lib/auth-error-message.ts`, which maps it to translated copy
 * and passes anything unrecognised through. Interpolating the bound into the
 * sentence would silently break that lookup the day a bound changes — the
 * server rejection would render in English instead of the user's language,
 * with nothing failing. Written out, a bound change forces the message, the
 * table entry and the message catalogue to be updated together, and
 * `packages/api/src/account-rules.test.ts` pins that the number in the
 * sentence still matches the constant.
 */

// --------------------------------------------------------------------------
// Date of birth
// --------------------------------------------------------------------------

/** The day parts of a date of birth, always read and compared through UTC. */
export type DateOfBirthParts = { y: number; m: number; d: number };

/** The age floor for an account. Both halves of the 15+ rule read it from here. */
export const MINIMUM_AGE_YEARS = 15;

/** Rejection for a date of birth under {@link MINIMUM_AGE_YEARS}. */
export const DOB_UNDER_AGE_MESSAGE = "You must be at least 15 years old to create an account.";
/** Rejection for a malformed or calendar-impossible date of birth. */
export const DOB_INVALID_MESSAGE = "Please enter a valid date of birth.";

/** The date-only wire and input form: exactly `YYYY-MM-DD`, no shorter, no longer. */
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strict `YYYY-MM-DD`, calendar-checked.
 *
 * The round trip through `Date.UTC` and back out through UTC getters is what
 * catches an impossible date: the regex happily accepts "2025-02-30", which
 * `Date` rolls over to March 2 rather than rejecting. Reading the parts back
 * in UTC keeps any timezone out of the check entirely.
 *
 * This is the form the native date input produces, so it is what the browser
 * validates against — anything looser there would accept a value the server
 * then normalises to a different day.
 */
export function parseDateOnlyParts(value: string): DateOfBirthParts | null {
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/**
 * The wire-tolerant parse, for the server side of the rule.
 *
 * Deliberately looser than {@link parseDateOnlyParts}, because a hook does not
 * get to choose what arrives: Better Auth hands it whatever the caller sent —
 * the app's own `YYYY-MM-DDT00:00:00.000Z` (see `dateOfBirthToIso` in
 * `apps/web/src/lib/auth-validation.ts`), a bare `YYYY-MM-DD`, a `Date` the
 * adapter already coerced, or something else entirely.
 *
 * The calendar check still runs on the date half of whatever string arrived,
 * *before* `new Date()` sees it. Without that, "1995-02-30T00:00:00.000Z"
 * would roll over and be stored as a day that never existed.
 */
export function parseDateOfBirthParts<Value>(value: Value): DateOfBirthParts | null {
  if (value === null || value === undefined) return null;

  const representation = Object.prototype.toString.call(value);
  const stringValue =
    representation === "[object String]" ? String.prototype.valueOf.call(value) : null;
  const numberValue =
    representation === "[object Number]" ? Number.prototype.valueOf.call(value) : null;
  if (stringValue !== null) {
    const trimmed = stringValue.trim();
    if (!trimmed) return null;
    const dateHalf = trimmed.split(/[T ]/, 1)[0] ?? trimmed;
    if (DATE_ONLY_RE.test(dateHalf)) {
      const parts = parseDateOnlyParts(dateHalf);
      // An impossible calendar date is impossible whatever followed it.
      if (!parts) return null;
      // No time component at all — the strict parse already has the answer.
      if (dateHalf === trimmed) return parts;
    }
  }

  const parsed =
    value instanceof Date
      ? value
      : stringValue !== null
        ? new Date(stringValue)
        : numberValue !== null
          ? new Date(numberValue)
          : null;
  if (!parsed) return null;
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    y: parsed.getUTCFullYear(),
    m: parsed.getUTCMonth() + 1,
    d: parsed.getUTCDate(),
  };
}

/**
 * `dob + years <= today`, compared as integer `YYYYMMDD` tuples so no clock
 * arithmetic and no timezone can move the boundary. Someone born exactly
 * `years` ago today passes.
 */
export function isAtLeastYearsOld(
  dob: DateOfBirthParts,
  years: number = MINIMUM_AGE_YEARS,
  today: Date = new Date(),
): boolean {
  const dobTuple = dob.y * 10000 + dob.m * 100 + dob.d;
  const cutoff = new Date(
    Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()),
  );
  const cutoffTuple =
    cutoff.getUTCFullYear() * 10000 + (cutoff.getUTCMonth() + 1) * 100 + cutoff.getUTCDate();
  return dobTuple <= cutoffTuple;
}

// --------------------------------------------------------------------------
// Username
// --------------------------------------------------------------------------

/**
 * The handle bounds, inclusive at both ends.
 *
 * Read by the Better Auth `username()` plugin registration
 * (`./index.ts`, `./testing.ts`), by `usernameInput` in
 * `packages/api/src/users.ts`, and by the two forms that claim a handle
 * (`/register` and `/welcome`). Four surfaces, one pair of numbers.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/** Rejection for a handle outside the bounds. */
export const USERNAME_LENGTH_MESSAGE = "Username must be between 3 and 20 characters long.";
/** Rejection for a handle carrying anything outside the allowed charset. */
export const USERNAME_CHARACTERS_MESSAGE =
  "Username can only contain letters, numbers, underscores, and hyphens.";
/** Rejection for trying to mutate Better Auth's derived display handle on its own. */
export const USERNAME_CANONICAL_WRITE_MESSAGE =
  "Change a handle through the username field, not the display username field.";

/**
 * The canonical stored and displayed handle form.
 *
 * Handles are ASCII-only, so locale-independent lowercasing is sufficient.
 * Callers still validate the raw value: uppercase input is accepted and
 * normalised rather than forcing someone to retype an otherwise valid handle.
 */
export function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

/**
 * The handle charset. Anchored and without the `g` flag on purpose — `test` on
 * a global regex carries `lastIndex` between calls, which would make this
 * return alternating answers for the same input.
 */
const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Whether a handle carries only the allowed characters. Says nothing about length. */
export function isAllowedUsernameCharset(username: string): boolean {
  return USERNAME_RE.test(username);
}

/**
 * The first rule an already-trimmed handle violates, or `null`.
 *
 * Length before charset, because that is the order a person fixes them in and
 * the order both forms have always reported. Presence is *not* checked here:
 * an empty handle is a missing field, which is the browser form's own policy
 * (the server never sees a partially-filled form), so
 * `apps/web/src/lib/auth-validation.ts` owns that message and delegates the
 * rest here.
 */
export function usernameRuleViolation(username: string): string | null {
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return USERNAME_LENGTH_MESSAGE;
  }
  if (!isAllowedUsernameCharset(username)) return USERNAME_CHARACTERS_MESSAGE;
  return null;
}

// --------------------------------------------------------------------------
// Legal acceptance
// --------------------------------------------------------------------------

/**
 * The machine-readable version of the Legal documents
 * accepted at sign-up. The legal pages render the same date as
 * `legal_terms_updated` / `legal_privacy_updated`; this value is what the
 * database stores so consent can be demonstrated without parsing prose.
 */
export const LEGAL_VERSION = "2026-08-02";

/**
 * Rejection for an email/password sign-up that did not record consent. The
 * wording names the two documents, not the internal "legal" model, because
 * this exact string is a key of `apps/web/src/lib/auth-error-message.ts`.
 */
export const LEGAL_ACCEPTANCE_REQUIRED_MESSAGE =
  "You must accept the Terms of Service and Privacy Policy to create an account.";

/**
 * Refusal for a signed-in account whose recorded consent is absent or not
 * `LEGAL_VERSION`. Distinct from the sign-up string above, which talks about
 * creating an account: by the time this one is reached the account exists and
 * the ask is to accept the current documents before carrying on.
 */
export const LEGAL_CONSENT_REQUIRED_MESSAGE =
  "You must accept the current Terms of Service and Privacy Policy to continue.";

/**
 * Whether a recorded acceptance is the current one.
 *
 * The single reader of "is this account's consent good?", shared by the oRPC
 * gate in packages/api and the web app's consent dialog so the server and the
 * browser cannot disagree about who has to be asked. Absent evidence is not
 * consent: an account created before the record existed, or through a path
 * that could not carry it, reads as stale here.
 */
export function hasCurrentLegalConsent(consent: {
  legalAcceptedAt?: Date | string | null;
  legalVersion?: string | null;
}): boolean {
  return Boolean(consent.legalAcceptedAt) && consent.legalVersion === LEGAL_VERSION;
}

// --------------------------------------------------------------------------
// Onboarding completeness
// --------------------------------------------------------------------------

/**
 * Refusal for a signed-in account that never finished onboarding — no claimed
 * handle, or no date of birth old enough for {@link MINIMUM_AGE_YEARS}.
 * Distinct from the sign-up strings above, which talk about creating an
 * account: by the time this one is reached the account exists, and the ask is
 * to finish `/welcome` before carrying on.
 */
export const ONBOARDING_REQUIRED_MESSAGE =
  "You must finish setting up your account before you can do that.";

/**
 * Whether a session user has completed onboarding.
 *
 * OAuth and passkey sign-ups land with neither a handle nor a date of birth —
 * no form exists to put them in — so the web app holds them at `/welcome`
 * until both are declared (`needsCompletionAtom`). A client-side redirect is a
 * courtesy anyone can skip, so this is the half that holds: the oRPC
 * `protectedProcedure` gate in packages/api reads it off the session user
 * fresh on every request, the same way it reads `hasCurrentLegalConsent`, and
 * an incomplete account gets FORBIDDEN rather than reaching a product RPC by
 * calling it directly.
 *
 * `dateOfBirth` arrives on the session user as whatever the adapter handed
 * back — a `Date` for the timestamp column, or an ISO string — so it is run
 * through {@link parseDateOfBirthParts} rather than compared raw, and the age
 * check reuses {@link isAtLeastYearsOld} so the 15+ boundary cannot differ
 * between the write hook and this read.
 */
export function hasCompletedOnboarding(
  user: {
    username?: string | null;
    dateOfBirth?: unknown;
  },
  today: Date = new Date(),
): boolean {
  if (!user.username) return false;
  const dob = parseDateOfBirthParts(user.dateOfBirth);
  if (!dob) return false;
  return isAtLeastYearsOld(dob, MINIMUM_AGE_YEARS, today);
}

// --------------------------------------------------------------------------
// Bio
// --------------------------------------------------------------------------

/**
 * Short enough to stay a one-line strapline rather than a second post.
 *
 * Counted in UTF-16 code units rather than grapheme clusters, matching what
 * `String.length` gives the enforcing hook. An emoji costing two is a rough
 * edge, but it is one both the counter and the check share — which is the
 * property that matters.
 */
export const BIO_MAX_LENGTH = 160;

/** Rejection for a bio over {@link BIO_MAX_LENGTH}. */
export const BIO_TOO_LONG_MESSAGE = "Your bio must be 160 characters or fewer.";

/** Whether a bio fits. Callers decide whether to trim first — the two sides differ, deliberately. */
export function isBioWithinLimit(bio: string): boolean {
  return bio.length <= BIO_MAX_LENGTH;
}

// --------------------------------------------------------------------------
// Stored preferences
// --------------------------------------------------------------------------

/** The themes the settings page offers and the server will accept. */
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
/** The locales the settings page offers and the server will accept. */
export const LOCALE_PREFERENCES = ["en", "fr"] as const;

/** A valid `themePreference` value. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
/** A valid `localePreference` value. */
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

/** Whether an untrusted value is one of the stored theme preferences. */
export function isThemePreference<Value>(value: Value): value is Value & ThemePreference {
  return THEME_PREFERENCES.some((preference) => Object.is(preference, value));
}

/** Whether an untrusted value is one of the stored locale preferences. */
export function isLocalePreference<Value>(value: Value): value is Value & LocalePreference {
  return LOCALE_PREFERENCES.some((preference) => Object.is(preference, value));
}

/** Rejection for a theme outside {@link THEME_PREFERENCES}. */
export const THEME_PREFERENCE_INVALID_MESSAGE = "Please choose a valid theme.";
/** Rejection for a locale outside {@link LOCALE_PREFERENCES}. */
export const LOCALE_PREFERENCE_INVALID_MESSAGE = "Please choose a valid language.";
