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
    const { router } = await renderWithProviders(<RedirectProbe redirect="/discover" />, {
      signedInAs: { dateOfBirth: null },
    });

    expect(router.state.location.pathname).toBe("/@alexmercer");
  });

  it("sends a session without a handle to /welcome, redirect or not", async () => {
    const { router } = await renderWithProviders(<RedirectProbe redirect="/discover" />, {
      signedInAs: { username: null, displayUsername: null },
    });

    // `/welcome` is not in the stub route tree, so the navigation resolves
    // asynchronously through the unmatched-match path — flush it before
    // asserting (the registered-route cases above commit synchronously).
    await act(async () => {
      await Promise.resolve();
    });

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

  /**
   * Navigating to the path the hook is already standing on would remount the
   * route — and the `/welcome` page resets its drafts on unmount
   * (`resetHandleClaimAtom`), discarding a handle the person has typed. The
   * E2E suite caught this as a lost fill: the input reverted to empty, the
   * native `required` validation swallowed the submit, and the claim never
   * ran. The self-navigation is a no-op by construction, so it is skipped.
   */
  describe("already on /welcome", () => {
    it("does not re-navigate a handle-less session that is already on /welcome", async () => {
      const { router } = await renderWithProviders(<RedirectProbe />, {
        initialPath: "/welcome",
        signedInAs: { username: null, displayUsername: null },
      });

      expect(router.state.location.pathname).toBe("/welcome");
    });

    it("still sends a complete session away to its profile — only the self-navigation is skipped", async () => {
      const { router } = await renderWithProviders(<RedirectProbe />, {
        initialPath: "/welcome",
        signedInAs: true,
      });

      expect(router.state.location.pathname).toBe("/@alexmercer");
    });

    it("does not re-navigate when the two-factor offer is already rendering on /welcome", async () => {
      const store = createStore();
      store.set(offerTwoFactorAtom, true);

      const { router } = await renderWithProviders(<RedirectProbe />, {
        store,
        initialPath: "/welcome",
        signedInAs: true,
      });

      expect(router.state.location.pathname).toBe("/welcome");
    });
  });
});
