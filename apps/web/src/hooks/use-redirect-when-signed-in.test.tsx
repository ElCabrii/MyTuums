import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { createStore } from "jotai";
import { renderWithProviders } from "@/test/render";
import { offerTwoFactorAtom } from "@/atoms/onboarding";
import { useRedirectWhenSignedIn } from "@/hooks/use-redirect-when-signed-in";

/**
 * `useRedirectWhenSignedIn` is the whole post-sign-in/sign-up redirect. The
 * `?redirect=` param the signed-in gate set is honoured only for a *complete*
 * session (handle + date of birth); anything else falls back to the profile
 * or /welcome. Probed through a component, exactly like the gate test.
 */
function RedirectProbe({ redirect }: { redirect?: string | null }) {
  useRedirectWhenSignedIn(redirect);
  return null;
}

describe("useRedirectWhenSignedIn", () => {
  it("sends a complete session to the sanitized redirect target, search and all", async () => {
    const { router } = await renderWithProviders(
      <RedirectProbe redirect="/discover?tab=following" />,
      { signedInAs: true },
    );

    expect(router.state.location.pathname).toBe("/discover");
    expect(router.state.location.searchStr).toContain("tab=following");
  });

  it("falls back to the profile when the redirect is one of the auth pages", async () => {
    const { router } = await renderWithProviders(<RedirectProbe redirect="/login" />, {
      signedInAs: true,
    });

    expect(router.state.location.pathname).toBe("/@alexmercer");
  });

  it("falls back to the profile when there is no redirect at all", async () => {
    const { router } = await renderWithProviders(<RedirectProbe />, { signedInAs: true });

    expect(router.state.location.pathname).toBe("/@alexmercer");
  });

  it("sends a session without a date of birth to its profile, ignoring the redirect — the completeness guard", async () => {
    const { router } = await renderWithProviders(
      <RedirectProbe redirect="/discover" />,
      { signedInAs: { dateOfBirth: null } },
    );

    expect(router.state.location.pathname).toBe("/@alexmercer");
  });

  it("sends a session without a handle to /welcome, redirect or not", async () => {
    const { router } = await renderWithProviders(
      <RedirectProbe redirect="/discover" />,
      { signedInAs: { username: null, displayUsername: null } },
    );

    expect(router.state.location.pathname).toBe("/welcome");
  });

  /**
   * The two-factor offer is a one-shot flag `signUpAtom` raises, and this hook
   * is what acts on it — the offer must not depend on the route knowing about
   * it, and the hook must stay the single owner of navigation.
   */
  describe("the post-sign-up two-factor offer", () => {
    it("sends a freshly signed-up session to /welcome, ahead of its profile", async () => {
      const store = createStore();
      store.set(offerTwoFactorAtom, true);

      const { router } = await renderWithProviders(<RedirectProbe />, {
        store,
        signedInAs: true,
      });

      expect(router.state.location.pathname).toBe("/welcome");
    });

    it("beats a ?redirect=, so the offer is never silently skipped", async () => {
      const store = createStore();
      store.set(offerTwoFactorAtom, true);

      const { router } = await renderWithProviders(<RedirectProbe redirect="/discover" />, {
        store,
        signedInAs: true,
      });

      expect(router.state.location.pathname).toBe("/welcome");
    });

    it("falls through to the normal rule once the flag is cleared", async () => {
      // Skipping and enrolling both clear the flag; this is what turns that
      // into "and now you land on your profile" without a second navigate().
      const store = createStore();
      store.set(offerTwoFactorAtom, true);

      const { router } = await renderWithProviders(<RedirectProbe />, {
        store,
        signedInAs: true,
      });
      expect(router.state.location.pathname).toBe("/welcome");

      await act(async () => {
        store.set(offerTwoFactorAtom, false);
        await Promise.resolve();
      });

      expect(router.state.location.pathname).toBe("/@alexmercer");
    });
  });

  it("does nothing for a signed-out visitor", async () => {
    const { router } = await renderWithProviders(<RedirectProbe redirect="/discover" />, {
      initialPath: "/login",
      signedInAs: false,
    });

    expect(router.state.location.pathname).toBe("/login");
  });
});
