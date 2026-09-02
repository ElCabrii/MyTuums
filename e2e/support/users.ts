/**
 * The two fixture accounts the whole suite is built around, plus the shared
 * shape for any throwaway account a spec seeds on top of them (e.g. a third
 * person to follow, or someone to hammer the rate limiter as).
 *
 * Centralised so a spec never hardcodes "alice"/"bob" — `auth.setup.ts` signs
 * these two up once and saves their `storageState`; every browser spec reads
 * the handle from here instead, so a fixture rename is a one-line change.
 */

import { LEGAL_VERSION } from "@my-tuums/auth/rules";

// Fixture passphrases for the throwaway browser accounts — named, not
// literal, so no credential-shaped value sits on a password field.
const ALICE_PASSPHRASE = "correct-horse-battery-1";
const BOB_PASSPHRASE = "correct-horse-battery-2";
const THROWAWAY_PASSPHRASE = "throwaway-password-1";

/**
 * The legal-consent evidence every seeded account has to carry.
 *
 * `/sign-up/email` refuses a body without it (packages/auth/src/legal.ts), and
 * an account that somehow got in without it is held on every page by the
 * global consent dialog — either way a seeded fixture that omits this breaks
 * the spec that uses it. Spread into the sign-up body, the same way
 * `dateOfBirth` is converted to its wire form at each call site.
 */
export function legalConsentBody() {
  return { legalAcceptedAt: new Date().toISOString(), legalVersion: LEGAL_VERSION };
}

/**
 * A fixture account — the shape `auth.setup.ts` signs up and storage-state
 * files are named after, so specs never hardcode "alice"/"bob".
 */
export interface FixtureUser {
  /** The handle — profile URLs, storage-state filenames, and seed emails are all derived from it. */
  username: string;
  name: string;
  email: string;
  password: string;
  /**
   * "YYYY-MM-DD". Every seeded account must carry one — the site now holds
   * sessions without a date of birth at /welcome, and alice/bob's storage
   * states are supposed to be complete.
   */
  dateOfBirth: string;
}

/** Alice — the signed-in fixture account most browser specs run as. */
export const ALICE: FixtureUser = {
  username: "alice",
  name: "Alice Anderson",
  email: "alice@example.test",
  password: ALICE_PASSPHRASE,
  dateOfBirth: "1995-01-01",
};

/** Bob — the second fixture account, reached through the `bobPage` fixture for two-viewer scenarios. */
export const BOB: FixtureUser = {
  username: "bob",
  name: "Bob Baker",
  email: "bob@example.test",
  password: BOB_PASSPHRASE,
  dateOfBirth: "1995-06-15",
};

/** Every account `auth.setup.ts` provisions storage state for. */
export const FIXTURE_USERS: readonly FixtureUser[] = [ALICE, BOB];

/**
 * A "YYYY-MM-DD" that falls under the 15-year threshold — 15 years ago plus
 * a day, relative so the assertion can't quietly stop being true as the
 * calendar moves. Used to prove the age rule holds at the register form and
 * at the /welcome claim.
 */
export function dateOfBirthUnder15(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 15);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

let uniqueUserCounter = 0;

/**
 * A throwaway account for a spec that needs a third (or fourth...) person —
 * someone for alice to follow, an author whose posts shouldn't leak into
 * alice's Following feed, and so on. `db.createUser()` (support/db.ts) still
 * does the actual signing-up; this just builds valid, collision-free input
 * for it.
 *
 * The suffix combines a base-36 timestamp with a monotonic counter rather
 * than the timestamp alone: two calls inside the same millisecond — plausible
 * given `workers: 1` runs specs back to back — would otherwise mint the same
 * username and fail the second signup with USERNAME_IS_ALREADY_TAKEN.
 */
export function uniqueUser(prefix: string): FixtureUser {
  uniqueUserCounter += 1;
  const suffix = `${Date.now().toString(36)}${uniqueUserCounter.toString(36)}`;
  // The username plugin caps handles at 20 characters (packages/auth/src/index.ts).
  const username = `${prefix}${suffix}`.slice(0, 20);

  return {
    username,
    name: `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)} Fixture`,
    email: `${username}@example.test`,
    password: THROWAWAY_PASSPHRASE,
    dateOfBirth: "1990-03-20",
  };
}
