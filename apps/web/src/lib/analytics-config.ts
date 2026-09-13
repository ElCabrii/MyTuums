/**
 * CNIL currently recommends remembering both consent and refusal for six
 * months. Use a fixed 180-day ceiling so a choice can never outlive that
 * recommendation because of variable calendar-month lengths.
 */
export const ANALYTICS_CONSENT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The public build flag for the consent-gated Cloudflare Zaraz integration.
 * The GA4 measurement ID lives in Zaraz rather than in the browser bundle.
 */
export const ANALYTICS_ENABLED = import.meta.env.VITE_GOOGLE_ANALYTICS === "enabled";
