/**
 * CNIL currently recommends remembering both consent and refusal for six
 * months. Use a fixed 180-day ceiling so a choice can never outlive that
 * recommendation because of variable calendar-month lengths.
 */
export const ANALYTICS_CONSENT_LIFETIME_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The public GA4 measurement id baked into the web bundle by Vite. An absent
 * or blank value disables the whole feature: no banner, script, storage write,
 * page-view call, or analytics-specific CSP source.
 */
export const ANALYTICS_MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim() || null;
