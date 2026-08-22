import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, lastLoginMethod, oneTap, twoFactor, username } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { i18n } from "@better-auth/i18n";
import { db } from "@my-tuums/db";
import { authRateLimitEnabled, passkeyRpId, webOrigin } from "./env.js";
import { validateDateOfBirthHook } from "./dob.js";
import { validateProfileFieldsHook } from "./profile.js";
import { validateLegalAcceptanceHook } from "./legal.js";
import { isAllowedUsernameCharset, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from "./rules.js";
import {
  localeFromRequest,
  otpEmail,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "./email.js";
import { fr } from "./i18n.js";
import { socialProviders, trustedProviders } from "./social.js";

/**
 * Every rule that must hold before a user row is written, in one hook because
 * Better Auth takes exactly one `before` per operation.
 *
 * Composed rather than merged into a single function so each rule stays
 * separately readable and separately testable — `./dob.ts` and `./profile.ts`
 * are both pure and neither knows about the other. Order does not matter: they
 * validate disjoint fields, and the first violation throws.
 */
type AuthUserWrite = Parameters<typeof validateDateOfBirthHook>[0] &
  Parameters<typeof validateProfileFieldsHook>[0];

const validateUserWrite = async (user: AuthUserWrite): Promise<void> => {
  await validateDateOfBirthHook(user);
  await validateProfileFieldsHook(user);
};

/**
 * The create path also carries the legal-acceptance rule, which the update
 * path must NOT: consent is a condition of *creating* an account, and
 * `lastLoginMethod({ storeInDatabase: true })` updates the row it just made
 * from inside the same `/sign-up/email` request. Running the rule on that
 * update rejected it — the body is `{ lastLoginMethod }` and carries no
 * consent — which left `last_login_method` unset on every sign-up and logged
 * a Better Auth error on each one.
 */
const validateUserCreate = async (
  user: AuthUserWrite & Parameters<typeof validateLegalAcceptanceHook>[0],
  context: Parameters<typeof validateLegalAcceptanceHook>[1],
): Promise<void> => {
  await validateUserWrite(user);
  await validateLegalAcceptanceHook(user, context);
};

/**
 * The single Better Auth instance the whole app runs on: mounted at `/api/auth`
 * by apps/server (toNodeHandler), and used by packages/api/src/context.ts to
 * resolve every request's session. Every setting below carries a load-bearing
 * inline comment — treat them as pinned invariants, not defaults to tweak.
 */
export const auth = betterAuth({
  // Also the default TOTP issuer — this is the label that shows up beside the
  // code in an authenticator app, so without it every entry would read
  // "Better Auth" and be indistinguishable from any other app using it.
  appName: "MyTuums",

  database: drizzleAdapter(db, {
    provider: "pg",
  }),

  // The session cookie cache is pinned OFF explicitly. It happens to be the
  // upstream default (`enabled: false`), but the guarantee is load-bearing:
  // the cached `GET /get-session` path serves the signed `session_data` cookie
  // WITHOUT re-validating the session token against the database
  // (better-auth/api/routes/session.mjs), so a revoked session would keep
  // authenticating for up to the cache cookie's lifetime — 5 minutes by
  // default (`cookieCache.maxAge`) — exactly the window
  // `revokeSessionsOnPasswordReset` below (and the moderation ban flow) exists
  // to close. Pinning it makes the config carry the guarantee rather than
  // inheriting it, so a future tweak here cannot silently re-enable the cache.
  // The cold-load splash the cache would shorten is already solved client-side
  // by the static splash in apps/web/index.html.
  session: {
    cookieCache: { enabled: false },
  },

  emailAndPassword: {
    enabled: true,
    // The server's half of the rule apps/web/src/lib/auth-validation.ts already
    // enforces in the browser. It happened to match Better Auth's default
    // before; pinning it means changing one no longer silently diverges from
    // the other.
    minPasswordLength: 8,
    // On: a password sign-up creates the account and sends the verification
    // email, but issues NO session — and a password sign-in is rejected until
    // the email is verified (see `sendOnSignIn` below for the recovery resend).
    // An unverified password account therefore never holds a session, which is
    // what lets the existing session gates — the server page gate and
    // `protectedProcedure` in packages/api — cover every access path without a
    // separate `emailVerified` check (a blanket one would lock out OAuth
    // accounts whose provider returned an unverified email, which this config
    // deliberately leaves alone). Existing accounts were grandfathered by the
    // `email_verified = true` backfill migration so this flip did not lock
    // them out; see packages/db/drizzle and docs/security.md.
    requireEmailVerification: true,
    // Reset is the one moment the old password is known-or-likely-compromised;
    // leaving existing sessions alive would let whoever held the old password
    // (or the email inbox) keep acting as the user. Revoking every session
    // forces re-authentication everywhere, in the same class as the
    // two-factor plugin's account lockout.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }, request) => {
      await sendEmail({
        to: user.email,
        ...passwordResetEmail(url, localeFromRequest(request?.headers)),
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    // The recovery path for an expired, lost, or never-arrived verification
    // link: an unverified password sign-in is rejected (above) AND re-sends the
    // verification email, so "try to sign in" is how someone asks for a new
    // link without a separate surface. The sign-in error this produces is
    // translated in apps/web/src/lib/auth-error-message.ts.
    sendOnSignIn: true,
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

  user: {
    // Every one of these is `required: false`, and that is load-bearing rather
    // than a courtesy: Better Auth throws MISSING_FIELD at parse time for any
    // required field absent from the body, and OAuth sign-ups arrive with none
    // of them — required would break every social sign-up. The columns are
    // nullable for the same reason.
    additionalFields: {
      // The 15+ age rule's data, enforced by the hooks below (see ./dob.ts).
      // The web app holds accounts that never declared one at /welcome until
      // they do.
      dateOfBirth: { type: "date", required: false },

      // The editable profile (see ./profile.ts for the rules). `bannerImage`
      // is the banner's counterpart to Better Auth's own `image`, and both
      // hold either a provider URL or a `/media/<key>` path written by the
      // upload procedure.
      bio: { type: "string", required: false },
      bannerImage: { type: "string", required: false },

      // The untouched original of each upload, kept beside the display form
      // so a future crop/reposition editor has every pixel the user picked
      // (the display form is the browser-made WebP the feeds render).
      //
      // `input: false` — deliberately not client-writable, unlike every other
      // field here. The upload procedure is the ONLY legitimate writer, and it
      // writes through Drizzle, which bypasses hooks entirely; a client write
      // reaching this field is illegitimate by construction, so Better Auth
      // should not even accept it as input. `returned` stays default-true so
      // the session carries them to the settings page.
      imageOriginal: { type: "string", required: false, input: false },
      bannerImageOriginal: { type: "string", required: false, input: false },

      // Stored *defaults* for theme and language, not the live values. The
      // header and footer switchers still write to localStorage and the
      // PARAGLIDE_LOCALE cookie, which win on the device that set them; these
      // are what a device with no choice of its own falls back to, so a
      // preference follows someone to a new browser. See apps/web/src/atoms/
      // theme.ts and locale.ts for the resolution order.
      themePreference: { type: "string", required: false },
      localePreference: { type: "string", required: false },

      // Consent evidence for the Legal documents. The
      // email/password sign-up path requires both; existing accounts and
      // OAuth/passkey sign-ups leave them null until the web app's global
      // legal consent dialog records them.
      legalAcceptedAt: { type: "date", required: false },
      legalVersion: { type: "string", required: false },
    },
  },

  databaseHooks: {
    user: {
      // Both creation paths — email/password and OAuth — run these. The
      // date-of-birth and profile rules return early on an absent value, so a
      // sign-up that supplies none of those fields passes through untouched;
      // legal acceptance is the exception and is required, on `/sign-up/email`
      // only (see ./legal.ts and validateUserCreate above).
      create: { before: validateUserCreate },
      // updateUser is how the /welcome claim and every settings edit arrive;
      // the same field rules, and this is the only place they actually hold —
      // the columns are bare `text` and the client's checks are skippable.
      // Deliberately not the legal rule: see validateUserCreate.
      update: { before: validateUserWrite },
    },
  },

  plugins: [
    // Registration only — the bounds and the charset come from ./rules.js, so
    // the plugin, `usernameInput` in packages/api/src/users.ts and the two
    // forms that claim a handle cannot disagree about what a handle is. The
    // plugin's own normalisation (lowercasing into `username`, keeping the
    // typed form in `displayUsername`) is deliberately left to it.
    username({
      minUsernameLength: USERNAME_MIN_LENGTH,
      maxUsernameLength: USERNAME_MAX_LENGTH,
      usernameValidator: isAllowedUsernameCharset,
    }),

    // The roles and ban fields the moderation system runs on (issue #38).
    //
    // `defaultRole` is what makes every account `user` until someone is
    // promoted — the admin plugin's `user.create.before` hook injects the
    // default into the insert, so the column does land in `user` for every
    // account created through Better Auth. It is NOT a database default: the
    // column is bare nullable text, so a row written outside the auth flow
    // (a direct Drizzle insert) holds NULL — which is why `packages/api`'s
    // gates and `setRole`'s audit trail read `role ?? "user"`.
    // `session.user.role` is typed from this plugin, so `packages/api`'s
    // role-gated procedures read it off the session without any
    // `additionalFields` wiring.
    //
    // Two deliberate non-uses, both covered elsewhere:
    // - The plugin's own `/api/auth/admin/*` endpoints are unreachable —
    //   `apps/server/src/request-handler.ts` 404s the prefix. They gate on
    //   `adminRoles` only, which cannot express our staff-vs-admin hierarchy,
    //   and every moderation action must go through the `/rpc` procedures,
    //   which enforce that hierarchy AND write the audit log.
    // - There is no `auditLog` option in better-auth 1.6.25; the
    //   `moderation_action` table (packages/db) is the hand-rolled audit log.
    admin({ defaultRole: "user" }),

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

    // Deliberate decision (code review, priority #5): a passkey IS the second
    // factor. A 2FA-enabled account signing in with a passkey skips the
    // TOTP/OTP challenge on purpose — the passkey itself is the second factor,
    // so a code challenge would be a second second factor. The alternative —
    // blocking passkey registration for 2FA-enabled accounts — was considered
    // and rejected.
    //
    // `userVerification: "required"` (vs the plugin default "preferred") is
    // requested at REGISTRATION: the browser refuses to create a passkey on
    // an authenticator that cannot prove the person (fingerprint/PIN). That is
    // the whole enforcement — the plugin's sign-in side never re-checks the
    // uv flag (it hardcodes "preferred" and `requireUserVerification: false`),
    // so the guarantee is "requested at registration, trusted thereafter".
    // Passkeys registered before this option shipped are not upgraded.
    passkey({
      rpID: passkeyRpId,
      rpName: "MyTuums",
      origin: webOrigin,
      authenticatorSelection: {
        userVerification: "required",
      },
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

    // Translates Better Auth's own error messages, which the web app's
    // catalogue cannot reach. `PARAGLIDE_LOCALE` is the cookie the web app
    // already sets (see docs/product.md), so one cookie decides the language
    // of both client copy and server errors. Header detection is the fallback
    // for a first visit, before any locale has been chosen.
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
      // deliver unsolicited mail to an address of the caller's choosing. The
      // path is /request-password-reset in 1.6.25 core — "/forget-password"
      // (the email-otp plugin's spelling) would be a dead key, which is why
      // the endpoint was silently running on Better Auth's weaker default.
      "/two-factor/send-otp": { window: 60, max: 3 },
      "/request-password-reset": { window: 300, max: 3 },
      "/send-verification-email": { window: 300, max: 3 },
    },
  },
});

// Re-exported for packages/api — the one external consumer. The moderation
// router (packages/api/src/moderation-actions.ts) builds its email copy here
// and sends through the same `sendEmail` pipe as the auth flows, reads the
// locale the same way, and points appeal links at `webOrigin`. The package's
// exports map exposes only `.`, `./testing` and `./rules`, so the public
// surface is whatever this file names — plus the browser-safe account rules,
// which are the one part of this package `apps/web` may import.
export {
  localeFromRequest,
  moderationBanEmail,
  moderationCaseResolutionEmail,
  moderationRemovalEmail,
  moderationResolutionEmail,
  moderationRestoreEmail,
  moderationRoleEmail,
  moderationSuspensionEmail,
  moderationUnbanEmail,
  moderationUnsuspensionEmail,
  sendEmail,
  type EmailLocale,
  type OutgoingEmail,
} from "./email.js";
export { webOrigin } from "./env.js";
