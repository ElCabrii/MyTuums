import { atom } from "jotai";
import { atomWithStorage, RESET } from "jotai/utils";
import { z } from "zod";
import { ANALYTICS_CONSENT_LIFETIME_MS } from "@/lib/analytics-config";
import { jsonStorage } from "@/lib/json-storage";

const STORAGE_KEY = "my-tuums.analytics-consent";

export type AnalyticsConsent = "granted" | "denied";

const storedConsentSchema = z.object({
  decision: z.enum(["granted", "denied"]),
  decidedAt: z.number().finite().nonnegative(),
});

/**
 * The raw per-device preference. localStorage is user-editable and outlives
 * deployments, so it stays `unknown` until the derived atom validates it.
 * `getOnInit` prevents a stored refusal from flashing the banner for one frame.
 */
const storedAnalyticsConsentAtom = atomWithStorage<unknown>(STORAGE_KEY, null, jsonStorage(), {
  getOnInit: true,
});

/**
 * The current, unexpired analytics preference for this device. A malformed,
 * future-dated, or six-month-old value is absence, which makes the root banner
 * ask again. Writes always replace it with a fresh timestamp; `null` removes
 * the key entirely.
 */
export const analyticsConsentAtom = atom(
  (get): AnalyticsConsent | null => {
    const parsed = storedConsentSchema.safeParse(get(storedAnalyticsConsentAtom));
    if (!parsed.success) return null;

    const age = Date.now() - parsed.data.decidedAt;
    if (age < 0 || age >= ANALYTICS_CONSENT_LIFETIME_MS) return null;

    return parsed.data.decision;
  },
  (_get, set, decision: AnalyticsConsent | null) => {
    if (decision === null) {
      set(storedAnalyticsConsentAtom, RESET);
      return;
    }

    set(storedAnalyticsConsentAtom, { decision, decidedAt: Date.now() });
  },
);

/** Opens the app-wide preference banner from the footer or account settings. */
export const analyticsPreferencesOpenAtom = atom(false);
