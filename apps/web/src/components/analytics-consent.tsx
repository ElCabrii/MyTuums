import { useEffect } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  analyticsConsentAtom,
  analyticsConsentExpiresAtAtom,
  analyticsPreferencesOpenAtom,
  type AnalyticsConsent as AnalyticsConsentDecision,
} from "@/atoms/analytics-consent";
import { Button } from "@/components/ui/button";
import { googleAnalytics, type AnalyticsAdapter } from "@/lib/analytics";
import { ANALYTICS_MEASUREMENT_ID } from "@/lib/analytics-config";
import { m } from "@/paraglide/messages.js";

interface AnalyticsConsentProps {
  analytics?: AnalyticsAdapter;
  measurementId?: string | null;
}

// setTimeout overflows past 2^31-1 ms, so a six-month expiry is scheduled in
// chunks rather than as a single timer.
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The single owner of analytics consent, tag lifecycle, and SPA page views.
 * It is mounted unconditionally at the root; an absent measurement id makes
 * the entire feature disappear without touching storage or the network.
 */
export function AnalyticsConsent({
  analytics = googleAnalytics,
  measurementId = ANALYTICS_MEASUREMENT_ID,
}: AnalyticsConsentProps) {
  if (!measurementId) return null;

  return <ConfiguredAnalyticsConsent analytics={analytics} measurementId={measurementId} />;
}

function ConfiguredAnalyticsConsent({
  analytics,
  measurementId,
}: {
  analytics: AnalyticsAdapter;
  measurementId: string;
}) {
  const { pathname } = useLocation();
  const consent = useAtomValue(analyticsConsentAtom);
  const expiresAt = useAtomValue(analyticsConsentExpiresAtAtom);
  const setConsent = useSetAtom(analyticsConsentAtom);
  const [preferencesOpen, setPreferencesOpen] = useAtom(analyticsPreferencesOpenAtom);

  useEffect(() => {
    if (consent === "denied") {
      analytics.stop(measurementId);
      return;
    }
    if (consent !== "granted") return;

    let current = true;
    void analytics
      .start(measurementId)
      .then(() => {
        if (!current) return;
        // Capability tokens live in the query string (`/reset-password`,
        // `/appeal`), so only the origin and pathname ever leave the device.
        analytics.trackPageView(measurementId, {
          location: new URL(pathname, window.location.origin).href,
          title: document.title,
        });
      })
      .catch(() => {
        console.error("Google Analytics failed to start");
      });

    return () => {
      current = false;
    };
  }, [analytics, consent, pathname, measurementId]);

  // The consent atom caches until storage changes, so without this a tab open
  // across the six-month boundary would keep a granted choice (and a running
  // tag) past expiry. Re-running on navigation also catches a clock jump that
  // lands past expiry while the tab was open.
  useEffect(() => {
    if (consent === null || expiresAt === null) return;

    if (expiresAt - Date.now() <= 0) {
      if (consent === "granted") analytics.stop(measurementId);
      setConsent(null);
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay: number): void => {
      // setTimeout clamps past 2^31-1 ms (~24.8 days), well under six months,
      // so chunk a far-future expiry instead of overflowing to an early fire.
      timeoutId = setTimeout(
        () => {
          if (cancelled) return;
          if (Date.now() >= expiresAt) {
            if (consent === "granted") analytics.stop(measurementId);
            setConsent(null);
            return;
          }
          schedule(expiresAt - Date.now());
        },
        Math.min(delay, MAX_TIMEOUT_MS),
      );
    };

    schedule(expiresAt - Date.now());

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [analytics, consent, expiresAt, measurementId, pathname, setConsent]);

  if (consent !== null && !preferencesOpen) return null;

  const choose = (decision: AnalyticsConsentDecision) => {
    setConsent(decision);
    setPreferencesOpen(false);
  };

  return (
    <aside
      role="region"
      aria-labelledby="analytics-consent-title"
      className="border-border bg-card fixed right-4 bottom-4 left-4 z-40 mx-auto max-w-3xl rounded-3xl border p-5 shadow-xl"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <h2 id="analytics-consent-title" className="font-semibold">
            {m.analytics_consent_title()}
          </h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {m.analytics_consent_description()} {m.analytics_consent_product_unchanged()}{" "}
            <Link to="/privacy" className="text-link font-medium hover:underline">
              {m.analytics_consent_learn_more()}
            </Link>
          </p>
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2">
          <Button variant="outline" onClick={() => choose("denied")}>
            {m.analytics_consent_refuse()}
          </Button>
          <Button variant="outline" onClick={() => choose("granted")}>
            {m.analytics_consent_accept()}
          </Button>
          {preferencesOpen && consent !== null && (
            <Button
              variant="ghost"
              className="col-span-2"
              onClick={() => setPreferencesOpen(false)}
            >
              {m.common_close()}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The shared footer affordance for reopening the app-wide preference banner. */
export function AnalyticsPreferencesButton({ className }: { className?: string }) {
  if (!ANALYTICS_MEASUREMENT_ID) return null;

  return <ConfiguredAnalyticsPreferencesButton className={className} />;
}

function ConfiguredAnalyticsPreferencesButton({ className }: { className?: string }) {
  const openPreferences = useSetAtom(analyticsPreferencesOpenAtom);

  return (
    <button type="button" className={className} onClick={() => openPreferences(true)}>
      {m.analytics_manage()}
    </button>
  );
}
