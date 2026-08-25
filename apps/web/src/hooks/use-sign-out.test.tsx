import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSignOut } from "@/hooks/use-sign-out";
import { renderWithProviders, setTestSignedOut } from "@/test/render";
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
 * before that section was removed from the settings page (issue #217); the
 * section is gone but the hook and its contract are not, so the assertion lives
 * here now, against the hook directly.
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
});
