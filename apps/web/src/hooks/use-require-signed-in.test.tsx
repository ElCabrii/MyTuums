import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
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

describe("useRequireSignedIn", () => {
  it("sends a signed-out visitor on the home page to /login with the destination preserved", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/",
      signedInAs: false,
    });

    expect(router.state.location.pathname).toBe("/login");
    expect(redirectParam(router.state.location.searchStr)).toBe("/");
  });

  it("preserves a deep link with parameters through the redirect", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/discover?tab=following",
      signedInAs: false,
    });

    expect(router.state.location.pathname).toBe("/login");
    expect(redirectParam(router.state.location.searchStr)).toBe("/discover?tab=following");
  });

  it("leaves a signed-in visitor alone", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/",
      signedInAs: true,
    });

    expect(router.state.location.pathname).toBe("/");
  });

  it("does not redirect while the session is still pending — the cold-load guard", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/post/deep-link",
      signedInAs: false,
      sessionPending: true,
    });

    expect(router.state.location.pathname).toBe("/post/deep-link");
  });

  it("exempts the legal pages — a sign-in gate that hides the terms is its own problem", async () => {
    const { router } = await renderWithProviders(<GateProbe />, {
      initialPath: "/privacy",
      signedInAs: false,
    });

    expect(router.state.location.pathname).toBe("/privacy");
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

      expect(router.state.location.pathname).toBe(path);
    }
  });
});
