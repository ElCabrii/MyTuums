import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { analyticsConsentAtom, analyticsPreferencesOpenAtom } from "@/atoms/analytics-consent";
import { AnalyticsConsent } from "@/components/analytics-consent";
import type { AnalyticsAdapter } from "@/lib/analytics";
import { renderWithProviders } from "@/test/render";
import { m } from "@/paraglide/messages.js";

function analyticsDouble() {
  return {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    trackPageView: vi.fn(),
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
});
