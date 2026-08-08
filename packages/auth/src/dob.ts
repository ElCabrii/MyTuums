/**
 * The server half of the 15+ age rule, wired in via `databaseHooks` in
 * `./index.ts` (and deliberately NOT in `./testing.ts` — fixtures are allowed
 * to mint any row, including under-15 ones a test needs to hold).
 *
 * The messages are English literals on purpose: they are what the API throws,
 * and the web app's render-boundary lookup (`apps/web/src/lib/auth-error-
 * message.ts`) maps them to translated copy while passing anything
 * unrecognised through. Keeping the string here and in the client's
 * `validateDateOfBirth` (`apps/web/src/lib/auth-validation.ts`) byte-identical
 * is what lets a server-rejected claim render in the user's language — the
 * same arrangement the username bounds already use.
 */
import { APIError } from "better-auth/api";

/** Message thrown for an under-15 declaration — keep byte-identical with apps/web/src/lib/auth-validation.ts. */
export const DOB_UNDER_AGE_MESSAGE = "You must be at least 15 years old to create an account.";
/** Message thrown for a malformed date of birth — same byte-identical invariant. */
export const DOB_INVALID_MESSAGE = "Please enter a valid date of birth.";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day parts of a date-of-birth value, read through UTC so no server or
 * browser timezone can shift the stored day. Accepts the "YYYY-MM-DD" form the
 * web app sends, anything `new Date()` can parse (an ISO string or a Date),
 * and rejects calendar-impossible dates ("2025-02-30" would otherwise roll
 * over to March 2).
 */
export function parseDateOfBirthParts(value: unknown): { y: number; m: number; d: number } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // The calendar check runs on the date half of whatever string arrived —
    // "YYYY-MM-DD" or the app's "YYYY-MM-DDT00:00:00.000Z". Without it,
    // "1995-02-30T..." would roll over to March 2 inside `new Date()` and be
    // stored as a date that never existed.
    const match = DATE_ONLY_RE.exec(trimmed.split(/[T ]/, 1)[0] ?? trimmed);
    if (match) {
      const y = Number(match[1]);
      const m = Number(match[2]);
      const d = Number(match[3]);
      const check = new Date(Date.UTC(y, m - 1, d));
      if (
        check.getUTCFullYear() !== y ||
        check.getUTCMonth() !== m - 1 ||
        check.getUTCDate() !== d
      ) {
        return null;
      }
      if (DATE_ONLY_RE.test(trimmed)) return { y, m, d };
    }
  }
  const parsed = value instanceof Date ? value : new Date(value as never);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    y: parsed.getUTCFullYear(),
    m: parsed.getUTCMonth() + 1,
    d: parsed.getUTCDate(),
  };
}

/**
 * Date-only comparison, immune to timezone drift: `dob + years <= today`,
 * compared as integer `YYYYMMDD` tuples. Someone born exactly `years` ago
 * today passes.
 */
export function isAtLeastYearsOld(
  dob: { y: number; m: number; d: number },
  years = 15,
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

/**
 * The rule Better Auth runs before a user row is created or updated.
 *
 * Returns early when no date of birth is present — OAuth sign-ups arrive with
 * none, and this hook runs on every creation path, so throwing on absence
 * would break every social sign-up (see the `required: false` comment in
 * `./index.ts`). It rejects only a present declaration that is malformed or
 * under the threshold; a user who simply never provides one is the
 * `/welcome` gate's business on the client, not this hook's.
 *
 * Not `async` on purpose: the rule is synchronous, so the function returns
 * `Promise.resolve()` explicitly instead — Better Auth's hook type demands a
 * promise, and the linter's `require-await` forbids an `async` function with
 * nothing to await. The index-signature intersection is required too: a bare
 * `{ dateOfBirth?: unknown }` is a *weak type*, and TypeScript refuses to
 * assign the hook's real user object to it because the two share no property
 * names.
 */
export function validateDateOfBirthHook(
  user: Record<string, unknown> & { dateOfBirth?: unknown },
): Promise<void> {
  const raw = user.dateOfBirth;
  if (raw === undefined || raw === null || raw === "") return Promise.resolve();
  const parts = parseDateOfBirthParts(raw);
  if (!parts) {
    throw new APIError("BAD_REQUEST", { message: DOB_INVALID_MESSAGE });
  }
  if (!isAtLeastYearsOld(parts, 15)) {
    throw new APIError("BAD_REQUEST", { message: DOB_UNDER_AGE_MESSAGE });
  }
  return Promise.resolve();
}
