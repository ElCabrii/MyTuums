/**
 * Where the app lives.
 *
 * The branding host serves no session and shares nothing with the SPA beyond
 * a registrar, so every entry point into the product is an absolute link to
 * the PoC app origin. This experimental branch deliberately targets only
 * the isolated Cloudflare deployment; production retains its own main branch.
 */
export const APP_ORIGIN = "https://cf-poc.mytuums.com";

export const signInUrl = `${APP_ORIGIN}/login`;
export const signUpUrl = `${APP_ORIGIN}/register`;

/** The app's public legal pages — SIGNED_OUT_PATHS members, no session needed. */
export const termsUrl = `${APP_ORIGIN}/terms`;
export const privacyUrl = `${APP_ORIGIN}/privacy`;
