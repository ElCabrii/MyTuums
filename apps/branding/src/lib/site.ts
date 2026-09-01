/**
 * Where the app lives.
 *
 * The branding host serves no session and shares nothing with the SPA beyond
 * a registrar, so every entry point into the product is an absolute link to
 * the apex origin. Hardcoded rather than a `VITE_*` variable: there is
 * exactly one production value, and a build-time knob for a constant invites
 * an image that links somewhere it should not.
 */
export const APP_ORIGIN = "https://mytuums.com";

export const signInUrl = `${APP_ORIGIN}/login`;
export const signUpUrl = `${APP_ORIGIN}/register`;
