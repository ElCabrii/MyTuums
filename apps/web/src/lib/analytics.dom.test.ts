import { afterEach, describe, expect, it, vi } from "vitest";

interface TestAnalyticsWindow extends Window {
  dataLayer?: ArrayLike<unknown>[];
  gtag?: (...args: unknown[]) => void;
}

// SAFETY: test-only view of the jsdom window; analytics.ts adds these
// optional fields at runtime when the command queue is installed.
const testWindow = window as TestAnalyticsWindow;

afterEach(() => {
  for (const script of document.head.querySelectorAll("script#my-tuums-google-analytics")) {
    script.remove();
  }
  delete testWindow.dataLayer;
  delete testWindow.gtag;
});

describe("googleAnalytics command queue", () => {
  it("queues gtag commands as arguments objects for gtag.js", async () => {
    vi.resetModules();
    const { googleAnalytics } = await import("@/lib/analytics");

    void googleAnalytics.start("G-TEST");

    const queue = testWindow.dataLayer ?? [];
    expect(queue).toHaveLength(2);
    for (const entry of queue) {
      expect(Array.isArray(entry)).toBe(false);
      expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
    }
    expect(queue[0]?.[0]).toBe("js");
    expect(queue[1]?.[0]).toBe("config");

    googleAnalytics.trackPageView("G-TEST", {
      location: "https://example.com/search",
      title: "Search",
    });

    const afterPageView = testWindow.dataLayer ?? [];
    expect(afterPageView).toHaveLength(3);
    expect(Array.isArray(afterPageView[2])).toBe(false);
    expect(Object.prototype.toString.call(afterPageView[2])).toBe("[object Arguments]");
  });
});
