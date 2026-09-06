import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { analyticsConsentAtom, analyticsPreferencesOpenAtom } from "@/atoms/analytics-consent";
import { AnalyticsConsent } from "@/components/analytics-consent";
import type { AnalyticsAdapter } from "@/lib/analytics";
import { ANALYTICS_CONSENT_LIFETIME_MS } from "@/lib/analytics-config";
import { renderWithProviders } from "@/test/render";
import { m } from "@/paraglide/messages.js";

function analyticsDouble() {
  return {
    start: vi.fn<AnalyticsAdapter["start"]>(() => Promise.resolve()),
    stop: vi.fn<AnalyticsAdapter["stop"]>(),
    trackPageView: vi.fn<AnalyticsAdapter["trackPageView"]>(),
  } satisfies AnalyticsAdapter;
}

describe("AnalyticsConsent", () => {
  it("does nothing when no measurement id is configured", async () => {
    const analytics = analyticsDouble();

    await renderWithProviders(<AnalyticsConsent analytics={analytics} measurementId={null} />, {
      initialPath: "/login",
    });

    expect(
      screen.queryByRole("region", { name: m.analytics_consent_title() }),
    ).not.toBeInTheDocument();
    expect(analytics.start).not.toHaveBeenCalled();
    expect(analytics.stop).not.toHaveBeenCalled();
    expect(analytics.trackPageView).not.toHaveBeenCalled();
  });

  it("offers equally prominent accept/refuse actions and never starts GA after refusal", async () => {
    const analytics = analyticsDouble();
    const user = userEvent.setup();

    await renderWithProviders(<AnalyticsConsent analytics={analytics} measurementId="G-TEST" />, {
      initialPath: "/login",
    });

    const refuse = screen.getByRole("button", { name: m.analytics_consent_refuse() });
    const accept = screen.getByRole("button", { name: m.analytics_consent_accept() });
    expect(refuse.className).toBe(accept.className);

    await user.click(refuse);

    expect(
      screen.queryByRole("region", { name: m.analytics_consent_title() }),
    ).not.toBeInTheDocument();
    expect(analytics.start).not.toHaveBeenCalled();
    expect(analytics.stop).toHaveBeenCalledWith("G-TEST");
  });

  it("starts after acceptance, tracks SPA navigation, and stops after withdrawal", async () => {
    const analytics = analyticsDouble();
    const store = createStore();
    const user = userEvent.setup();
    const rendered = await renderWithProviders(
      <AnalyticsConsent analytics={analytics} measurementId="G-TEST" />,
      { initialPath: "/login", store },
    );

    await user.click(screen.getByRole("button", { name: m.analytics_consent_accept() }));

    await waitFor(() => expect(analytics.start).toHaveBeenCalledWith("G-TEST"));
    await waitFor(() => expect(analytics.trackPageView).toHaveBeenCalledTimes(1));

    await act(async () => {
      await rendered.router.navigate({ to: "/privacy" });
    });
    await waitFor(() => expect(analytics.trackPageView).toHaveBeenCalledTimes(2));

    act(() => store.set(analyticsPreferencesOpenAtom, true));
    await user.click(screen.getByRole("button", { name: m.analytics_consent_refuse() }));

    expect(store.get(analyticsConsentAtom)).toBe("denied");
    expect(analytics.stop).toHaveBeenCalledWith("G-TEST");
  });

  it("strips query and hash from the tracked page location (issue #345)", async () => {
    const analytics = analyticsDouble();
    const user = userEvent.setup();

    await renderWithProviders(<AnalyticsConsent analytics={analytics} measurementId="G-TEST" />, {
      initialPath: "/reset-password?token=secret-token#hash",
    });

    await user.click(screen.getByRole("button", { name: m.analytics_consent_accept() }));

    await waitFor(() => expect(analytics.trackPageView).toHaveBeenCalledTimes(1));
    const trackedLocation = String(analytics.trackPageView.mock.calls[0]?.[1]?.location ?? "");
    expect(trackedLocation).toBe(new URL("/reset-password", window.location.origin).href);
    expect(trackedLocation).not.toContain("secret-token");
  });

  it("tracks query-only navigations while keeping the location sanitized", async () => {
    const analytics = analyticsDouble();
    const user = userEvent.setup();

    const rendered = await renderWithProviders(
      <AnalyticsConsent analytics={analytics} measurementId="G-TEST" />,
      { initialPath: "/search?q=one" },
    );

    await user.click(screen.getByRole("button", { name: m.analytics_consent_accept() }));

    await waitFor(() => expect(analytics.trackPageView).toHaveBeenCalledTimes(1));

    await act(async () => {
      await rendered.router.navigate({ to: "/search", search: { q: "two" } });
    });

    await waitFor(() => expect(analytics.trackPageView).toHaveBeenCalledTimes(2));
    const secondLocation = String(analytics.trackPageView.mock.calls[1]?.[1]?.location ?? "");
    expect(secondLocation).toBe(new URL("/search", window.location.origin).href);
    expect(secondLocation).not.toContain("two");
  });

  it("expires a granted choice without a reload (issue #345)", async () => {
    const analytics = analyticsDouble();
    const store = createStore();
    localStorage.setItem(
      "my-tuums.analytics-consent",
      JSON.stringify({
        decision: "granted",
        decidedAt: Date.now() - ANALYTICS_CONSENT_LIFETIME_MS + 200,
      }),
    );

    await renderWithProviders(<AnalyticsConsent analytics={analytics} measurementId="G-TEST" />, {
      initialPath: "/login",
      store,
    });

    // Still valid on mount, so the banner stays hidden until the boundary.
    expect(
      screen.queryByRole("region", { name: m.analytics_consent_title() }),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: m.analytics_consent_title() }),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(store.get(analyticsConsentAtom)).toBeNull());
    expect(analytics.stop).toHaveBeenCalledWith("G-TEST");
  });
});
