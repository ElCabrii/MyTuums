/**
 * The two fixture accounts the whole suite is built around, plus the shared
 * shape for any throwaway account a spec seeds on top of them (e.g. a third
 * person to follow, or someone to hammer the rate limiter as).
 *
 * Centralised so a spec never hardcodes "alice"/"bob" — `auth.setup.ts` signs
 * these two up once and saves their `storageState`; every browser spec reads
 * the handle from here instead, so a fixture rename is a one-line change.
 */
export interface FixtureUser {
  /** Also used as the display name's slug-free counterpart in seed data. */
  username: string;
  name: string;
  email: string;
  password: string;
}

export const ALICE: FixtureUser = {
  username: "alice",
  name: "Alice Anderson",
  email: "alice@example.test",
  password: "correct-horse-battery-1",
};

export const BOB: FixtureUser = {
  username: "bob",
  name: "Bob Baker",
  email: "bob@example.test",
  password: "correct-horse-battery-2",
};

/** Every account `auth.setup.ts` provisions storage state for. */
export const FIXTURE_USERS: readonly FixtureUser[] = [ALICE, BOB];

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
    password: "throwaway-password-1",
  };
}
