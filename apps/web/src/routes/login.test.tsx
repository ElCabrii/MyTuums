import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPage } from "@/routes/login";
import { authClient } from "@/lib/auth-client";
import { m } from "@/paraglide/messages.js";

/**
 * Regression coverage for issue #74: a banned sign-in must land on `/banned`
 * instead of the generic `?error=` banner, on every entry path that can
 * report it. Before this file, none of the three `navigate({ to: "/banned" })`
 * call sites (the `?error=BANNED_USER` effect and the submit branch in
 * `login.tsx`, and the passkey branch in `sign-in-options.tsx`) had a test
 * that would fail if the navigate were reverted to the old banner behaviour —
 * `signInAtom`/`signInWithPasskeyAtom`'s tests only assert the returned
 * outcome, and `localizeOAuthError("BANNED_USER")` already returns plausible
 * copy on its own thanks to the stopgap mapping. These mount the real
 * `LoginPage` (which renders `SignInOptions`) and assert the router's final
 * location, the same pattern `not-found-page.test.tsx` and
 * `use-require-signed-in.test.tsx` use for navigation assertions.
 */
describe("LoginPage — banned account routing (issue #74)", () => {
  it("navigates to /banned and drops the query string when the OAuth callback reports BANNED_USER", async () => {
    const { router } = await renderWithProviders(<LoginPage />, {
      initialPath: "/login?error=BANNED_USER",
    });

    await waitFor(() => expect(router.state.location.pathname).toBe("/banned"));
    // `replace: true` in the effect is what keeps the code from lingering in
    // the address bar — asserting the pathname alone wouldn't catch a
    // regression that navigated to `/banned` but forwarded the search along.
    expect(router.state.location.search).toEqual({});
  });

  it("navigates to /banned when signing in with a password reports BANNED_USER", async () => {
    vi.mocked(authClient.signIn.username).mockResolvedValueOnce({
      data: null,
      error: {
        code: "BANNED_USER",
        message:
          "You have been banned from this application. Please contact support if you believe this is an error.",
      },
    });

    const { router } = await renderWithProviders(<LoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.auth_field_identifier()), "bannedguy");
    await user.type(screen.getByLabelText(m.auth_field_password()), "whatever1");
    await user.click(screen.getByRole("button", { name: m.auth_log_in() }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/banned"));
  });

  it("navigates to /banned when signing in with a passkey reports BANNED_USER", async () => {
    // WebAuthn support gates whether `SignInOptions` even renders the button
    // (see its `supportsPasskeys` check) — jsdom has no such global by default.
    vi.stubGlobal("PublicKeyCredential", class {});
    vi.mocked(authClient.signIn.passkey).mockResolvedValueOnce({
      data: null,
      error: {
        code: "BANNED_USER",
        message:
          "You have been banned from this application. Please contact support if you believe this is an error.",
        status: 403,
        statusText: "Forbidden",
      },
    });

    const { router } = await renderWithProviders(<LoginPage />);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.auth_continue_with_passkey() }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/banned"));
  });
});
