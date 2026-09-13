interface ZarazConsentApi {
  APIReady: boolean;
  set(preferences: Readonly<Record<string, boolean>>): void;
}

interface ZarazApi {
  consent?: ZarazConsentApi;
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

const CONSENT_READY_EVENT = "zarazConsentAPIReady";
const ANALYTICS_PURPOSE_ID = "analytics";
const PAGE_VIEW_EVENT = "MyTuumsPageview";
const CONSENT_COOKIE_NAME = "mytuums_zaraz_consent";
const INITIALIZATION_TIMEOUT_MS = 10_000;

let collectionDisabled = true;

const analyticsWindow = (): AnalyticsWindow => window;

function waitForConsentApi(): Promise<void> {
  const existingApi = analyticsWindow().zaraz;
  if (existingApi?.consent?.APIReady) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      document.removeEventListener(CONSENT_READY_EVENT, ready);
    };
    const ready = () => {
      if (!analyticsWindow().zaraz?.consent?.APIReady || settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Cloudflare Zaraz consent API failed to initialize"));
    };
    const timeout = setTimeout(failed, INITIALIZATION_TIMEOUT_MS);

    document.addEventListener(CONSENT_READY_EVENT, ready);
    ready();
  });
}

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
  async start() {
    collectionDisabled = false;
    try {
      await waitForConsentApi();
      analyticsWindow().zaraz?.consent?.set({ [ANALYTICS_PURPOSE_ID]: true });
    } catch (error) {
      collectionDisabled = true;
      throw error;
    }
  },

  stop() {
    const wasCollecting = !collectionDisabled;
    collectionDisabled = true;
    const consent = analyticsWindow().zaraz?.consent;
    if (wasCollecting && consent?.APIReady) consent.set({ [ANALYTICS_PURPOSE_ID]: false });
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
