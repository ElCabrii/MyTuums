/**
 * The server half of the editable-profile rules, wired in via `databaseHooks`
 * in `./index.ts` alongside `./dob.ts` (and deliberately NOT in `./testing.ts`,
 * for the same reason: fixtures are allowed to mint rows a test needs).
 *
 * These fields are `additionalFields`, which default to `input: true` — a
 * client can put any string in any of them through `updateUser`. Nothing else
 * validates them: the column types are all bare `text`, and the web app's
 * checks are a courtesy that anyone can skip by calling the endpoint directly.
 * This hook is the only place the rules actually hold.
 *
 * The messages are English literals on purpose, exactly as in `./dob.ts`: they
 * are what the API throws, and `apps/web/src/lib/auth-error-message.ts` maps
 * them to translated copy at the render boundary while passing anything
 * unrecognised through. Keeping them byte-identical with the client's
 * `apps/web/src/lib/auth-validation.ts` is what lets a server rejection render
 * in the user's language.
 */
import { APIError } from "better-auth/api";

/**
 * Short enough to stay a one-line strapline rather than a second post, and the
 * same number the web app's `validateBio` uses. Changing it means changing
 * both, and the message string below.
 */
export const BIO_MAX_LENGTH = 160;

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export const LOCALE_PREFERENCES = ["en", "fr"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];

export const BIO_TOO_LONG_MESSAGE = "Your bio must be 160 characters or fewer.";
export const THEME_PREFERENCE_INVALID_MESSAGE = "Please choose a valid theme.";
export const LOCALE_PREFERENCE_INVALID_MESSAGE = "Please choose a valid language.";
export const MANAGED_IMAGE_MESSAGE = "Profile images are set by uploading a file.";

/** Absent in the sense every one of these rules means: nothing to check. */
const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || value === "";

/**
 * `image` and `banner_image` hold one of exactly two things: an absolute URL an
 * OAuth provider gave us at sign-up, or a `/media/<key>` path pointing at this
 * app's own object storage.
 *
 * Only the second kind is ours to trust, and only the upload procedure
 * (`packages/api/src/users.ts`) may write it — it writes through Drizzle, which
 * bypasses Better Auth's hooks entirely, so nothing reaching *this* function is
 * ever a legitimate `/media/` write. Allowing one here would let anyone point
 * their avatar at another user's object key by calling `updateUser` directly,
 * since the key embeds the owner's id and nothing downstream re-checks it.
 *
 * Requiring an absolute http(s) URL rather than merely banning the `/media/`
 * prefix closes the rest of the space in the same line: no `data:` payloads
 * inflating the row, no relative path aimed at some other route of ours.
 *
 * Both columns carry the same rule and deliberately the same message, so the
 * client's lookup needs one entry rather than two that say the same thing.
 */
function assertProviderImage(value: unknown): void {
  if (isBlank(value)) return;
  if (typeof value !== "string") {
    throw new APIError("BAD_REQUEST", { message: MANAGED_IMAGE_MESSAGE });
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new APIError("BAD_REQUEST", { message: MANAGED_IMAGE_MESSAGE });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new APIError("BAD_REQUEST", { message: MANAGED_IMAGE_MESSAGE });
  }
}

function assertOneOf(value: unknown, allowed: readonly string[], message: string): void {
  if (isBlank(value)) return;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new APIError("BAD_REQUEST", { message });
  }
}

/**
 * The original-image columns are the one place "no client writes, ever" is the
 * rule. They are declared `input: false` in the auth config so Better Auth
 * rejects them as input outright; this is the second line for anything that
 * bypasses that — the hook sees *every* user write, and any non-blank value
 * here is illegitimate by construction, because the only legitimate writer is
 * the upload procedure, which writes through Drizzle and skips these hooks.
 */
function assertNoClientOriginalImageWrite(value: unknown): void {
  if (!isBlank(value)) {
    throw new APIError("BAD_REQUEST", { message: MANAGED_IMAGE_MESSAGE });
  }
}

/**
 * The rule Better Auth runs before a user row is created or updated, beside
 * `validateDateOfBirthHook`.
 *
 * Every check returns early on an absent value, because this hook sees *partial*
 * updates: someone changing only their display name arrives here with `bio`,
 * `themePreference` and the rest all undefined, and treating absence as a
 * violation would reject every unrelated write.
 *
 * Not `async`, and returning `Promise.resolve()` explicitly — same reason as
 * `./dob.ts`: the rules are synchronous, Better Auth's hook type demands a
 * promise, and `require-await` forbids an `async` function with nothing to
 * await. The index-signature intersection dodges TypeScript's weak-type check
 * for the same reason it does there.
 */
export function validateProfileFieldsHook(
  user: Record<string, unknown> & {
    bio?: unknown;
    image?: unknown;
    bannerImage?: unknown;
    imageOriginal?: unknown;
    bannerImageOriginal?: unknown;
    themePreference?: unknown;
    localePreference?: unknown;
  },
): Promise<void> {
  if (!isBlank(user.bio)) {
    if (typeof user.bio !== "string" || user.bio.length > BIO_MAX_LENGTH) {
      throw new APIError("BAD_REQUEST", { message: BIO_TOO_LONG_MESSAGE });
    }
  }

  assertProviderImage(user.image);
  assertProviderImage(user.bannerImage);
  // No legitimate client write ever touches these — see the helper's comment.
  assertNoClientOriginalImageWrite(user.imageOriginal);
  assertNoClientOriginalImageWrite(user.bannerImageOriginal);

  assertOneOf(user.themePreference, THEME_PREFERENCES, THEME_PREFERENCE_INVALID_MESSAGE);
  assertOneOf(user.localePreference, LOCALE_PREFERENCES, LOCALE_PREFERENCE_INVALID_MESSAGE);

  return Promise.resolve();
}
