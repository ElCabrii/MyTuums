/**
 * Every environment variable this package reads, resolved once at module load.
 *
 * Deliberately does *not* throw on anything missing. `apps/server/src/env.ts`
 * is the loud boot-time validator for the variables the app cannot run
 * without; everything added here is *optional* by design, because the whole
 * point is that a fresh clone — and CI, which sets no OAuth or email secrets —
 * still boots with email/password auth working and the extra providers simply
 * absent. A required-by-default OAuth secret would turn "I haven't set up
 * Google yet" into "the server won't start".
 */

/** `undefined` for unset *and* for whitespace-only, which is what a half-filled `.env` line leaves behind. */
function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The web app's origin, defaulting to the Vite dev server.
 *
 * Optional with a dev-friendly default, matching the fallback in
 * apps/server/src/env.ts (the loud boot-time validator for the app).
 */
export const webOrigin = optionalEnv("WEB_ORIGIN") ?? "http://localhost:5173";

/** Whether the process runs with NODE_ENV=production. */
export const isProduction = process.env.NODE_ENV === "production";

/** Both halves of one OAuth provider's credential pair. */
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Credentials for one provider, or `undefined` when either half is missing.
 *
 * Both halves are required together on purpose: a `clientId` with no secret
 * would let Better Auth register the provider and render a sign-in button that
 * fails at the token exchange — an error the user sees only *after* leaving the
 * site and coming back. Absent is a better failure mode than broken.
 */
export function oauthCredentials(prefix: string): OAuthCredentials | undefined {
  const clientId = optionalEnv(`${prefix}_CLIENT_ID`);
  const clientSecret = optionalEnv(`${prefix}_CLIENT_SECRET`);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Resend API key, or undefined when email delivery is unconfigured. */
export const resendApiKey = optionalEnv("RESEND_API_KEY");

/**
 * Better Auth's own rate limiting, on unless explicitly switched off.
 *
 * Its default is "production only", which left development *and* the E2E stack
 * with no limiting on the auth endpoints at all — so the tightened rules in
 * ./index.ts would never have been exercised before they mattered. On by
 * default fixes that.
 *
 * The escape hatch exists for one specific case: the Playwright suite drives
 * every sign-in, sign-up and 2FA challenge from 127.0.0.1, so it looks exactly
 * like the credential-stuffing traffic these limits are meant to stop. It is a
 * variable of its own rather than a `NODE_ENV === "test"` check because the E2E
 * stack deliberately runs as `development` (see e2e/playwright.config.ts) —
 * overloading NODE_ENV would have silently changed other behaviour with it.
 */
export const authRateLimitEnabled = optionalEnv("AUTH_RATE_LIMIT") !== "false";

/**
 * The From address on every sent email, defaulting to Resend's onboarding one.
 *
 * Resend rejects a `from` outside a verified domain, so this has no useful
 * default in production — but it also must not throw at import time. An unset
 * value surfaces as a send failure from ./email.ts, which names the variable.
 */
export const emailFrom = optionalEnv("EMAIL_FROM") ?? "MyTuums <onboarding@resend.dev>";

/**
 * The WebAuthn Relying Party ID: the *browser-visible* origin's hostname, not
 * the API's. A passkey is bound to the site the person is looking at, and this
 * app is same-origin (the server sits behind the Vite proxy in dev and is
 * expected to share a domain in production — see `/api/auth` CORS in
 * apps/server/src/index.ts).
 *
 * Note WebAuthn keys the RP ID on hostname alone — no scheme, no port — so
 * `http://localhost:5173` and `http://localhost:5273` (the E2E web port) both
 * yield `localhost`, and a passkey registered under one works under the other.
 */
export const passkeyRpId = optionalEnv("PASSKEY_RP_ID") ?? hostnameOf(webOrigin);

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    // WEB_ORIGIN is malformed. "localhost" keeps local dev working rather than
    // taking the process down over a variable that only matters for passkeys.
    return "localhost";
  }
}
