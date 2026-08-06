import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderWithProviders, setTestSession } from "@/test/render";
import { useRequireSignedIn } from "@/hooks/use-require-signed-in";

/**
 * The hook redirects signed-out visitors to /login with their destination
 * preserved — the behaviour that makes the site private. Probed through a
 * component because the hook needs the router's `navigate`; assertions read
 * the memory router's final location.
 */
function GateProbe() {
  useRequireSignedIn();
  return null;
}

function redirectParam(searchStr: string): string | null {
  return new URLSearchParams(searchStr).get("redirect");
}

/**
 * The gate defers the bounce by `GATE_CONFIRM_MS` (150ms) in the hook, so
 * every navigation assertion goes through `waitFor` on real timers rather
 * than reading the pathname the tick after render. Tests that must prove NO
 * navigation fired wait this long past the window instead.
 */
const PAST_CONFIRM_WINDOW_MS = 300;

describe("useRequireSignedIn", () => {
  it("sends a signed-out visitor on the home page to /login with the destination preserved", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/",
      signedInAs: false,
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), {
      timeout: 1000,
    });
    expect(redirectParam(router.state.location.searchStr)).toBe("/");
  });

  it("preserves a deep link with parameters through the redirect", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/discover?tab=following",
      signedInAs: false,
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), {
      timeout: 1000,
    });
    expect(redirectParam(router.state.location.searchStr)).toBe("/discover?tab=following");
  });

  it("leaves a signed-in visitor alone", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/",
      signedInAs: true,
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/"), { timeout: 1000 });
  });

  it("does not redirect while the session is still pending — the cold-load guard", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/post/deep-link",
      signedInAs: false,
      sessionPending: true,
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/post/deep-link"), {
      timeout: 1000,
    });
  });

  it("exempts the legal pages — a sign-in gate that hides the terms is its own problem", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/privacy",
      signedInAs: false,
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/privacy"), {
      timeout: 1000,
    });
  });

  it("exempts the password-reset pages — a gate would lock out the recovery flow", async () => {
    // `/reset-password` is the subtle one: it must work while signed in, so
    // exempting it on the signed-out side is what lets a signed-in visitor
    // finish a reset without being bounced to /login mid-flow.
    for (const path of ["/forgot-password", "/reset-password"]) {
      const { router } = await renderWithProviders(<GateProbe />, {
        initialPath: path,
        signedInAs: false,
      });

      await waitFor(() => expect(router.state.location.pathname).toBe(path), {
        timeout: 1000,
      });
    }
  });

  it("exempts /appeal — the signed-out appeal link is the one surface a banned user has", async () => {
    // The moderation appeal email link lands here while the recipient cannot
    // sign in (that is the point of the HMAC capability token). A gate would
    // bounce the whole flow to /login.
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/appeal?token=abc",
      signedInAs: false,
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/appeal"), {
      timeout: 1000,
    });
  });

  /**
   * BetterAuth can transiently settle the store as signed-out while a real
   * session exists (an errored fetch keeps null data, a 401 blip clears it).
   * When the retry lands the session back inside the confirm window, the
   * gate's timer is cancelled — no bounce at all.
   */
  it("absorbs a transient signed-out settle that recovers within the confirm window", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/",
      signedInAs: true,
    });

    // The transient settle — indistinguishable from real sign-out at the
    // store level, and it must not start a bounce that survives the retry.
    act(() => {
      setTestSession({
        data: null,
        isPending: false,
        isRefetching: false,
        error: null,
        refetch: vi.fn(() => Promise.resolve()),
      });
    });
    // The retry lands a real session back before GATE_CONFIRM_MS elapses.
    act(() => {
      setTestSession({
        data: { user: { id: "u1", name: "Alex Mercer", username: "alexmercer" } },
        isPending: false,
        isRefetching: false,
        error: null,
        refetch: vi.fn(() => Promise.resolve()),
      });
    });

    // Wait past the window on real timers — the transient settle must not
    // have navigated.
    await new Promise((resolve) => setTimeout(resolve, PAST_CONFIRM_WINDOW_MS));
    expect(router.state.location.pathname).toBe("/");
  });

  /**
   * A settled error is "couldn't reach the server", not "signed out" — the
   * gate must hold the bounce and wait for a clean answer. A 500 would have
   * bounced without the error guard; this is the regression it exists for.
   */
  it("holds the bounce on a settled error that is not a 401", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/",
      signedInAs: false,
    });

    // The initial signed-out render schedules the bounce timer; landing an
    // error value cancels it, and the guard must not reschedule one.
    act(() => {
      setTestSession({
        data: null,
        isPending: false,
        isRefetching: false,
        error: { status: 500 },
        refetch: vi.fn(() => Promise.resolve()),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, PAST_CONFIRM_WINDOW_MS));
    expect(router.state.location.pathname).toBe("/");
  });
});
