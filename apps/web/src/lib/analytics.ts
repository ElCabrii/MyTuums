import { ANALYTICS_CONSENT_LIFETIME_MS } from "@/lib/analytics-config";

type Gtag = (...args: unknown[]) => void;

interface AnalyticsWindow extends Window {
  dataLayer?: IArguments[];
  gtag?: Gtag;
}

export interface AnalyticsAdapter {
  start(measurementId: string): Promise<void>;
  stop(measurementId: string): void;
  trackPageView(measurementId: string, page: { location: string; title: string }): void;
}

const SCRIPT_ID = "my-tuums-google-analytics";
const COOKIE_LIFETIME_SECONDS = Math.floor(ANALYTICS_CONSENT_LIFETIME_MS / 1000);

let scriptLoad: Promise<void> | null = null;
let configuredMeasurementId: string | null = null;
const disabledMeasurementIds = new Set<string>();

const analyticsWindow = (): AnalyticsWindow => window;

function setCollectionDisabled(measurementId: string, disabled: boolean): void {
  // Google documents this measurement-id-scoped flag as the synchronous way
  // to stop a loaded tag. Define the dynamic external property without
  // weakening the static Window type with an open-ended dictionary.
  Object.defineProperty(analyticsWindow(), `ga-disable-${measurementId}`, {
    configurable: true,
    value: disabled,
    writable: true,
  });

  if (disabled) {
    disabledMeasurementIds.add(measurementId);
  } else {
    disabledMeasurementIds.delete(measurementId);
  }
}

function installCommandQueue(): Gtag {
  const target = analyticsWindow();
  target.dataLayer ??= [];
  // Google's documented snippet queues the `arguments` object itself, not an
  // array: gtag.js ignores array entries, so an arrow function spreading into
  // `push(args)` loads the tag but never records config or page views.
  target.gtag ??= function () {
    // eslint-disable-next-line prefer-rest-params -- gtag.js requires the Arguments object; rest params would queue an Array it ignores, see above
    target.dataLayer?.push(arguments);
  };
  return target.gtag;
}

function loadTag(measurementId: string): Promise<void> {
  if (scriptLoad) return scriptLoad;

  const existing = document.getElementById(SCRIPT_ID);
  if (existing instanceof HTMLScriptElement && existing.dataset.loaded === "true") {
    return Promise.resolve();
  }

  scriptLoad = new Promise<void>((resolve, reject) => {
    const script =
      existing instanceof HTMLScriptElement ? existing : document.createElement("script");

    const loaded = () => {
      script.dataset.loaded = "true";
      resolve();
    };
    const failed = () => {
      scriptLoad = null;
      script.remove();
      reject(new Error("Google Analytics failed to load"));
    };

    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });

    if (!(existing instanceof HTMLScriptElement)) {
      const source = new URL("https://www.googletagmanager.com/gtag/js");
      source.searchParams.set("id", measurementId);
      script.id = SCRIPT_ID;
      script.async = true;
      script.src = source.href;
      document.head.append(script);
    }
  });

  return scriptLoad;
}

function clearAnalyticsCookies(): void {
  const names = document.cookie
    .split(";")
    .map((part) => part.trim().split("=", 1)[0])
    .filter((name) => name === "_ga" || name.startsWith("_ga_"));

  for (const name of names) {
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;

    // GA normally scopes its first-party cookies to the highest usable domain.
    // MyTuums runs at the apex, so deleting both host-only and explicit-domain
    // shapes covers the configured tag without guessing at a parent suffix.
    if (window.location.hostname.includes(".")) {
      document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${window.location.hostname}; SameSite=Lax`;
    }
  }
}

export const googleAnalytics: AnalyticsAdapter = {
  start(measurementId) {
    setCollectionDisabled(measurementId, false);
    const gtag = installCommandQueue();

    if (configuredMeasurementId !== measurementId) {
      gtag("js", new Date());
      // Manual SPA page views: `send_page_view: false` stops only the
      // tag-load event. The GA4 property must also disable Enhanced
      // Measurement's "Page changes based on browser history events"
      // (see docs/operations.md), otherwise every TanStack Router
      // navigation is counted twice — once automatically, once below.
      // https://developers.google.com/analytics/devguides/collection/ga4/views#disable_page_changes_based_on_browser_history_events
      gtag("config", measurementId, {
        allow_ad_personalization_signals: false,
        allow_google_signals: false,
        cookie_expires: COOKIE_LIFETIME_SECONDS,
        cookie_update: false,
        send_page_view: false,
      });
      configuredMeasurementId = measurementId;
    }

    return loadTag(measurementId);
  },

  stop(measurementId) {
    setCollectionDisabled(measurementId, true);
    clearAnalyticsCookies();
  },

  trackPageView(measurementId, page) {
    if (disabledMeasurementIds.has(measurementId)) return;

    analyticsWindow().gtag?.("event", "page_view", {
      page_location: page.location,
      page_title: page.title,
    });
  },
};
