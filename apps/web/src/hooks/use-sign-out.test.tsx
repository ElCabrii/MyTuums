import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { useSignOut } from "@/hooks/use-sign-out";
import { setTestSignedOut } from "@/test/auth-fixture";
import { renderWithProviders } from "@/test/render";
import { authErrorAtom } from "@/atoms/auth";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages.js";

/**
 * `useSignOut` owns the post-sign-out destination, and the invariant that
 * matters is a deferral: it awaits `signOutAtom`, which awaits
 * `waitForSignedOut()` (apps/web/src/lib/session-sync.ts) — the session store
 * actually emptying — before resolving, and only then navigates to /login.
 *
 * Navigating the moment BetterAuth's `/sign-out` call resolves would race the
 * cache/family teardown in `clearViewerState` and leave stale viewer-owned rows
 * behind on /login. This was the behaviour the `SignOutSection` test pinned
 * before that section was removed from the settings page (issue #217). The
 * section is back (issue #282), but the assertion stays here, against the hook
 * directly: the contract is the hook's, and the section's own test pins only
 * its composition — restating it per surface would prove nothing new.
 */
function SignOutButton() {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={() => void signOut()}>
      {m.auth_sign_out()}
    </button>
  );
}

describe("useSignOut", () => {
  it("stays on the page until the session is actually signed out, then lands on /login", async () => {
    let release!: () => void;
    vi.mocked(authClient.signOut).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {}, error: null });
        }),
    );
    const { router } = await renderWithProviders(<SignOutButton />, {
      initialPath: "/settings/account",
      signedInAs: true,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.auth_sign_out() }));

    // `/sign-out` has not resolved yet — still on the page.
    expect(router.state.location.pathname).toBe("/settings/account");

    act(() => {
      release();
    });
    // `signOut` resolved but the store is still signed-in: `waitForSignedOut`
    // is still waiting, so navigation must not have happened yet.
    expect(router.state.location.pathname).toBe("/settings/account");

    act(() => {
      setTestSignedOut();
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  // Pinned here since the profile page dropped its own sign-out button
  // (issue #282): the catch branch is the hook's single error path, shared
  // by every surface, so it is proven once against the hook rather than
  // per consumer.
  it("stays on the page, logs, and surfaces the shared auth error when sign-out rejects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authClient.signOut).mockRejectedValueOnce(new Error("network down"));

    const store = createStore();
    const { router } = await renderWithProviders(<SignOutButton />, {
      store,
      initialPath: "/settings/account",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.auth_sign_out() }));

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith("Failed to sign out", expect.anything()),
    );
    expect(router.state.location.pathname).toBe("/settings/account");
    expect(store.get(authErrorAtom)).toBe(m.common_something_went_wrong());
    consoleError.mockRestore();
  });
});
