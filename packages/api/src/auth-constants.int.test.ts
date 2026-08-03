import { describe, expect, it } from "vitest";
import { BIO_MAX_LENGTH as BIO_MAX_LENGTH_API } from "./constants.js";
import {
  BIO_MAX_LENGTH as BIO_MAX_LENGTH_AUTH,
  BIO_TOO_LONG_MESSAGE,
  LOCALE_PREFERENCES,
  THEME_PREFERENCES,
} from "@my-tuums/auth/profile";

/**
 * The seam between two intentional duplicates.
 *
 * `BIO_MAX_LENGTH` exists twice on purpose: `packages/auth` is where the rule is
 * *enforced* (bios are written through `updateUser`, so the Better Auth database
 * hook is the authority), while `packages/api/src/constants.ts` is the only
 * module the browser can import — it must stay dependency-free, and
 * `packages/auth` importing `@my-tuums/api` would close a dependency cycle.
 *
 * So they cannot share a module, which leaves this: a test that fails loudly if
 * one changes without the other. Without it the drift is silent and one-sided —
 * the form would happily accept a bio the server then rejects, and the only
 * symptom is a save that mysteriously fails.
 *
 * An `.int.test.ts` rather than a unit test because importing `@my-tuums/auth`
 * pulls in `@my-tuums/db`, whose module-scope `DATABASE_URL` check throws in the
 * unit project (see CLAUDE.md).
 */
describe("shared validation constants", () => {
  it("keeps the bio limit identical across the api and auth packages", () => {
    expect(BIO_MAX_LENGTH_API).toBe(BIO_MAX_LENGTH_AUTH);
  });

  it("keeps the server's rejection message byte-identical with the client's", () => {
    // `apps/web/src/lib/auth-validation.ts`'s `validateBio` returns this exact
    // string, which is what lets `localizeAuthError` translate a server
    // rejection and a client one through the same lookup entry.
    expect(BIO_TOO_LONG_MESSAGE).toBe("Your bio must be 160 characters or fewer.");
    expect(BIO_TOO_LONG_MESSAGE).toContain(String(BIO_MAX_LENGTH_AUTH));
  });

  it("keeps the preference enums in step with what the web app offers", () => {
    // `atoms/theme.ts` narrows to exactly these three, and `preferences-section.tsx`
    // renders one button per value. Paraglide's `locales` is the other half of
    // the locale list; a mismatch would render a button the server rejects.
    expect([...THEME_PREFERENCES]).toEqual(["light", "dark", "system"]);
    expect([...LOCALE_PREFERENCES]).toEqual(["en", "fr"]);
  });
});
