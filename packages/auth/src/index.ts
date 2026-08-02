import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  haveIBeenPwned,
  lastLoginMethod,
  oneTap,
  twoFactor,
  username,
} from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { i18n } from "@better-auth/i18n";
import { db } from "@my-tuums/db";
import { authRateLimitEnabled, passkeyRpId, webOrigin } from "./env.js";
import {
  localeFromRequest,
  otpEmail,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "./email.js";
import { fr } from "./i18n.js";
import { socialProviders, trustedProviders } from "./social.js";

export const auth = betterAuth({
  // Also the default TOTP issuer — this is the label that shows up beside the
  // code in an authenticator app, so without it every entry would read
  // "Better Auth" and be indistinguishable from any other app using it.
  appName: "MyTuums",

  database: drizzleAdapter(db, {
    provider: "pg",
  }),

  emailAndPassword: {
    enabled: true,
    // The server's half of the rule apps/web/src/lib/auth-validation.ts already
    // enforces in the browser. It happened to match Better Auth's default
    // before; pinning it means changing one no longer silently diverges from
    // the other.
    minPasswordLength: 8,
    // Off deliberately. Turning this on would lock out every account that
    // predates verification existing, which is all of them — it is a decision
    // to make once there is a verified population, not part of this change.
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }, request) => {
      await sendEmail({
        to: user.email,
        ...passwordResetEmail(url, localeFromRequest(request?.headers)),
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }, request) => {
      await sendEmail({
        to: user.email,
        ...verificationEmail(url, localeFromRequest(request?.headers)),
      });
    },
  },

  socialProviders,

  account: {
    accountLinking: {
      enabled: true,
      // See ./social.ts — this list is the security control, not a convenience.
      trustedProviders,
    },
  },

  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
      usernameValidator: (u) => /^[a-zA-Z0-9_-]+$/.test(u),
    }),

    twoFactor({
      // TOTP and backup codes work with no email transport configured at all,
      // which is why they are the primary path. `sendOTP` adds email as a
      // second option for people who don't want an authenticator app; with no
      // RESEND_API_KEY it degrades to a console log in dev and a loud failure
      // in production rather than a code nobody receives (see ./email.ts).
      otpOptions: {
        sendOTP: async ({ user, otp }, ctx) => {
          await sendEmail({
            to: user.email,
            ...otpEmail(otp, localeFromRequest(ctx?.request?.headers ?? ctx?.headers)),
          });
        },
      },
    }),

    passkey({
      rpID: passkeyRpId,
      rpName: "MyTuums",
      origin: webOrigin,
    }),

    // Registered unconditionally even though it is useless without Google
    // credentials. Spreading it in conditionally would make the plugin list
    // non-static, which is what degrades Better Auth's type inference across
    // the whole instance; the web client only ever calls it when
    // VITE_GOOGLE_CLIENT_ID is set, so an unconfigured deployment simply never
    // reaches the endpoint.
    oneTap(),

    // `storeInDatabase` so the hint survives a cleared cookie and a new device.
    // Note the column is deliberately NOT in `publicUserColumns`
    // (packages/api/src/users.ts) — which provider someone signs in with is
    // reconnaissance, not public profile data.
    lastLoginMethod({ storeInDatabase: true }),

    // Rejects passwords found in known breach corpora, at sign-up and at every
    // password change. Checked via k-anonymity — only a 5-character hash prefix
    // ever leaves the server, never the password.
    haveIBeenPwned(),

    // Translates Better Auth's own error messages, which the web app's
    // catalogue cannot reach. `PARAGLIDE_LOCALE` is the cookie the web app
    // already sets (CLAUDE.md §i18n), so one cookie decides the language of
    // both client copy and server errors. Header detection is the fallback for
    // a first visit, before any locale has been chosen.
    i18n({
      translations: { fr },
      detection: ["cookie", "header"],
      localeCookie: "PARAGLIDE_LOCALE",
    }),
  ],

  trustedOrigins: [webOrigin],

  rateLimit: {
    enabled: authRateLimitEnabled,
    storage: "database",
    // Everything not named here keeps Better Auth's default budget. These are
    // the endpoints where a low ceiling *is* the security control rather than
    // abuse protection: each one either lets an attacker test a secret, or
    // makes this server send mail on request.
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-in/username": { window: 60, max: 10 },
      // The plugin's own account lockout (10 consecutive failures) is the real
      // defence for these — it follows the account across IPs, where this
      // follows the IP across accounts. Both, because either alone is evadable.
      "/two-factor/verify-totp": { window: 60, max: 10 },
      "/two-factor/verify-otp": { window: 60, max: 10 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
      // Mail-sending endpoints, limited by what they cost rather than what they
      // reveal: without a ceiling either one turns this server into a way to
      // deliver unsolicited mail to an address of the caller's choosing.
      "/two-factor/send-otp": { window: 60, max: 3 },
      "/forget-password": { window: 300, max: 3 },
      "/send-verification-email": { window: 300, max: 3 },
    },
  },
});
