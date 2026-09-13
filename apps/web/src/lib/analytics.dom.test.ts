import { afterEach, describe, expect, it, vi } from "vitest";

interface TestZarazApi {
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
  it("forwards page views only while app consent enables collection", async () => {
    const { zarazAnalytics } = await import("@/lib/analytics");
    const track = vi.fn();
    testWindow.zaraz = { track };

    document.cookie = "cfz_google-analytics-4_ga4=visitor; Path=/";
    document.cookie = "mytuums_zaraz_consent=granted; Path=/";
    zarazAnalytics.stop();
    expect(document.cookie).not.toContain("cfz_google-analytics-4_ga4");
    expect(document.cookie).not.toContain("mytuums_zaraz_consent");
    zarazAnalytics.trackPageView({ location: "https://example.com/private", title: "Private" });
    expect(track).not.toHaveBeenCalled();

    await zarazAnalytics.start();

    zarazAnalytics.trackPageView({
      location: "https://example.com/search",
      title: "Search",
    });
    expect(track).toHaveBeenCalledWith("MyTuumsPageview", {
      dl: "https://example.com/search",
      dt: "Search",
    });

    zarazAnalytics.stop();
    zarazAnalytics.trackPageView({ location: "https://example.com/private", title: "Private" });
    expect(track).toHaveBeenCalledTimes(1);
  });
});
