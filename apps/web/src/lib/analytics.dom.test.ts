import { afterEach, describe, expect, it, vi } from "vitest";

interface TestZarazApi {
  consent: { APIReady: boolean; set: ReturnType<typeof vi.fn> };
  track: ReturnType<typeof vi.fn>;
}

interface TestAnalyticsWindow extends Window {
  zaraz?: TestZarazApi;
}

// SAFETY: the test only adds and removes the same optional runtime field that
// analytics.ts owns on Window.
const testWindow = window as TestAnalyticsWindow;

afterEach(() => {
  delete testWindow.zaraz;
  vi.resetModules();
});

describe("Cloudflare Zaraz analytics", () => {
  it("does not write a Zaraz denial before collection has started", async () => {
    const consentSet = vi.fn();
    testWindow.zaraz = { consent: { APIReady: true, set: consentSet }, track: vi.fn() };
    const { zarazAnalytics } = await import("@/lib/analytics");

    zarazAnalytics.stop();

    expect(consentSet).not.toHaveBeenCalled();
  });

  it("uses the native consent API and forwards only enabled page views", async () => {
    const { zarazAnalytics } = await import("@/lib/analytics");

    document.cookie = "cfz_google-analytics-4_ga4=visitor; Path=/";
    document.cookie = "mytuums_zaraz_consent=granted; Path=/";
    zarazAnalytics.stop();
    expect(document.cookie).not.toContain("cfz_google-analytics-4_ga4");
    expect(document.cookie).not.toContain("mytuums_zaraz_consent");

    const started = zarazAnalytics.start();
    const consentSet = vi.fn();
    const track = vi.fn();
    testWindow.zaraz = { consent: { APIReady: true, set: consentSet }, track };
    document.dispatchEvent(new Event("zarazConsentAPIReady"));
    await started;

    expect(consentSet).toHaveBeenCalledWith({ analytics: true });
    zarazAnalytics.trackPageView({
      location: "https://example.com/search",
      title: "Search",
    });
    expect(track).toHaveBeenCalledWith("MyTuumsPageview", {
      dl: "https://example.com/search",
      dt: "Search",
    });

    zarazAnalytics.stop();
    expect(consentSet).toHaveBeenLastCalledWith({ analytics: false });
    zarazAnalytics.trackPageView({ location: "https://example.com/private", title: "Private" });
    expect(track).toHaveBeenCalledTimes(1);
  });
});
