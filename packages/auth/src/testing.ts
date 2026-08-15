/**
 * A second BetterAuth instance, for tests only.
 *
 * `testUtils()` hangs privileged helpers off `ctx.test` — mint a session for
 * any user id, persist and delete user rows, read back OTPs that were "sent".
 * Those are exactly the capabilities an auth system exists to withhold, so the
 * production instance in ./index.ts must never carry them. Better Auth's own
 * guidance is the same, and it notes that the obvious alternative —
 * conditionally spreading `testUtils()` into the production plugin array —
 * makes the array non-static and stops `ctx.test` being inferred at all.
 *
 * Two instances against one database is not a problem: they share
 * `BETTER_AUTH_SECRET` and the same `session` table, so a session minted here
 * validates against the production `auth` that `packages/api/src/context.ts`
 * resolves requests with. That is the whole point — a test can skip the
 * password hashing round trip and still exercise the real request path.
 *
 * Importing this file from application code is a mistake this comment is meant
 * to make obvious. It is reachable only as `@my-tuums/auth/testing`.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { testUtils, username } from "better-auth/plugins";
import { db } from "@my-tuums/db";
import { webOrigin } from "./env.js";
import { isAllowedUsernameCharset, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "./rules.js";

/** The test-only Better Auth instance, carrying the privileged testUtils helpers (file header explains why). */
export const authTest = betterAuth({
  appName: "MyTuums",
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: { enabled: true },

  // Same additionalFields as production (./index.ts), for the same reason
  // `username()` is in the plugin list below: the user table has the columns
  // and the adapter needs to know about them. No databaseHooks here on purpose
  // — fixture creation must be able to mint rows the production rules would
  // reject (an under-15 date of birth, an over-long bio) when that is exactly
  // what a test needs to hold.
  user: {
    additionalFields: {
      dateOfBirth: { type: "date", required: false },
      bio: { type: "string", required: false },
      bannerImage: { type: "string", required: false },
      imageOriginal: { type: "string", required: false },
      bannerImageOriginal: { type: "string", required: false },
      themePreference: { type: "string", required: false },
      localePreference: { type: "string", required: false },
    },
  },

  /**
   * Deliberately a much smaller plugin list than production's.
   *
   * This instance exists to *create* fixtures, not to reproduce the app —
   * anything a test wants to assert about two-factor, passkeys or rate limits
   * has to go through the real `auth`, or it would be asserting against a
   * configuration nothing ships. `username()` is here only because the user
   * table has the columns and the adapter needs to know about them.
   *
   * `captureOTP` records codes as they are generated, so an email-OTP flow is
   * testable without stubbing Resend.
   */
  plugins: [
    username({
      minUsernameLength: USERNAME_MIN_LENGTH,
      maxUsernameLength: USERNAME_MAX_LENGTH,
      usernameValidator: isAllowedUsernameCharset,
    }),
    testUtils({ captureOTP: true }),
  ],

  trustedOrigins: [webOrigin],
  // Never rate-limit fixture creation: a suite that seeds forty users in a
  // loop is not the traffic the production limits are aimed at.
  rateLimit: { enabled: false },
});

/** Resolves the privileged helpers (session minting, OTP capture, row writes) off the test instance. */
export async function testHelpers() {
  const ctx = await authTest.$context;
  return ctx.test;
}
