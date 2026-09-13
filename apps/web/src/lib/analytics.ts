interface ZarazApi {
  track(eventName: string, properties?: Readonly<Record<string, string>>): void;
}

interface AnalyticsWindow extends Window {
  zaraz?: ZarazApi;
}

export interface AnalyticsAdapter {
  start(): Promise<void>;
  stop(): void;
  trackPageView(page: { location: string; title: string }): void;
}

const PAGE_VIEW_EVENT = "MyTuumsPageview";
const CONSENT_COOKIE_NAME = "mytuums_zaraz_consent";

let collectionDisabled = true;

const analyticsWindow = (): AnalyticsWindow => window;

function clearCookie(name: string): void {
  const attributes = ["Path=/", "Max-Age=0", "SameSite=Lax"];
  document.cookie = `${name}=; ${attributes.join("; ")}`;

  const hostnameParts = window.location.hostname.split(".");
  if (hostnameParts.length < 2) return;

  // Zaraz is configured for the shared mytuums.com domain. Clear both the
  // current host and the registrable domain when consent expires or changes.
  const registrableDomain = hostnameParts.slice(-2).join(".");
  for (const domain of new Set([window.location.hostname, registrableDomain])) {
    document.cookie = `${name}=; ${attributes.join("; ")}; Domain=${domain}`;
  }
}

function clearAnalyticsCookies(): void {
  const names = document.cookie
    .split(";")
    .map((part) => part.trim().split("=", 1)[0])
    .filter(
      (name) =>
        name === "_ga" ||
        name.startsWith("_ga_") ||
        name.startsWith("cfz_") ||
        name === CONSENT_COOKIE_NAME,
    );

  for (const name of names) clearCookie(name);
}

/** Consent-gated page views sent through Cloudflare's native GA4 Managed Component. */
export const zarazAnalytics: AnalyticsAdapter = {
  start() {
    collectionDisabled = false;
    return Promise.resolve();
  },

  stop() {
    collectionDisabled = true;
    clearAnalyticsCookies();
  },

  trackPageView(page) {
    if (collectionDisabled) return;
    analyticsWindow().zaraz?.track(PAGE_VIEW_EVENT, {
      dl: page.location,
      dt: page.title,
    });
  },
};
