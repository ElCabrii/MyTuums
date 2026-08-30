import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { authErrorAtom, verifyEmailAtom, verifyEmailSentAtom } from "@/atoms/auth";
import { authClient } from "@/lib/auth-client";
import { VerifyEmailPage } from "@/routes/verify-email";
import { m } from "@/paraglide/messages.js";

/**
 * The check-your-email screen (issue #172).
 *
 * Two properties are worth pinning here rather than leaving to the E2E suite:
 * that every failure code collapses to ONE generic panel (the page must not
 * become an account-existence oracle), and that the resend button is offered
 * only when an address is actually in hand.
 */
beforeEach(() => {
  vi.clearAllMocks();
});

describe("VerifyEmailPage", () => {
  it("shows the pending copy, and no resend, when the address is unknown", async () => {
    await renderWithProviders(<VerifyEmailPage />, { initialPath: "/verify-email" });

    expect(screen.getByRole("heading", { name: m.auth_verify_title() })).toBeInTheDocument();
    // A reload drops `verifyEmailAtom`, and a username sign-in never set it —
    // there is no address to resend to, so the button must not be offered.
    expect(screen.queryByRole("button", { name: m.auth_verify_resend() })).not.toBeInTheDocument();
  });

  it("offers a resend for the pending address and reports it generically", async () => {
    const store = createStore();
    act(() => store.set(verifyEmailAtom, "pending@example.com"));
    await renderWithProviders(<VerifyEmailPage />, { store, initialPath: "/verify-email" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.auth_verify_resend() }));

    await waitFor(() => expect(authClient.sendVerificationEmail).toHaveBeenCalled());
    expect(authClient.sendVerificationEmail).toHaveBeenCalledWith({
      email: "pending@example.com",
      callbackURL: `${window.location.origin}/verify-email`,
    });
    await waitFor(() => expect(store.get(verifyEmailSentAtom)).toBe(true));
    expect(screen.getByText(m.auth_verify_sent())).toBeInTheDocument();
  });

  it("surfaces a rejected resend in the banner", async () => {
    const store = createStore();
    act(() => store.set(verifyEmailAtom, "pending@example.com"));
    vi.mocked(authClient.sendVerificationEmail).mockResolvedValueOnce({
      data: null,
      error: { code: "TOO_MANY_REQUESTS", message: "Too many requests" },
    });
    await renderWithProviders(<VerifyEmailPage />, { store, initialPath: "/verify-email" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.auth_verify_resend() }));

    await waitFor(() => expect(store.get(authErrorAtom)).toBe("Too many requests"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(store.get(verifyEmailSentAtom)).toBe(false);
  });

  it("clears a failed resend on unmount, so /login does not inherit the error", async () => {
    const store = createStore();
    act(() => store.set(verifyEmailAtom, "pending@example.com"));
    vi.mocked(authClient.sendVerificationEmail).mockResolvedValueOnce({
      data: null,
      error: { code: "TOO_MANY_REQUESTS", message: "Too many requests" },
    });
    const { unmount } = await renderWithProviders(<VerifyEmailPage />, {
      store,
      initialPath: "/verify-email",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.auth_verify_resend() }));

    unmount();

    expect(store.get(authErrorAtom)).toBeNull();
    expect(store.get(verifyEmailSentAtom)).toBe(false);
    // The pending address belongs to the sign-up in progress, not this page —
    // /login sets it on the way here, so it must survive.
    expect(store.get(verifyEmailAtom)).toBe("pending@example.com");
  });

  it("carries the pre-login destination into the resend and the post-verify redirect", async () => {
    const store = createStore();
    act(() => store.set(verifyEmailAtom, "pending@example.com"));
    await renderWithProviders(<VerifyEmailPage />, {
      store,
      initialPath: "/verify-email?redirect=%2Fsettings%2Faccount",
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.auth_verify_resend() }));

    // The destination someone was sent to /login from must survive the whole
    // detour through email verification (issue #172 review).
    await waitFor(() =>
      expect(authClient.sendVerificationEmail).toHaveBeenCalledWith({
        email: "pending@example.com",
        callbackURL: `${window.location.origin}/verify-email?redirect=%2Fsettings%2Faccount`,
      }),
    );
  });

  // The anti-enumeration property: Better Auth appends a different code for a
  // token that expired, one that was tampered with, and one whose account no
  // longer exists. A visitor must not be able to tell those apart — all three
  // render the same panel, with no resend (the address is unknown on a fresh
  // link arrival).
  it.each(["TOKEN_EXPIRED", "INVALID_TOKEN", "USER_NOT_FOUND", "INVALID_USER"])(
    "renders one generic invalid-link panel for ?error=%s",
    async (code) => {
      await renderWithProviders(<VerifyEmailPage />, {
        initialPath: `/verify-email?error=${code}`,
      });

      expect(
        screen.getByRole("heading", { name: m.auth_verify_invalid_title() }),
      ).toBeInTheDocument();
      expect(screen.getByText(m.auth_verify_invalid_hint())).toBeInTheDocument();
      // The code itself must never reach the screen.
      expect(screen.queryByText(new RegExp(code, "i"))).not.toBeInTheDocument();
      // Pending copy belongs to the other state; showing both would tell the
      // visitor which failure they hit.
      expect(
        screen.queryByRole("heading", { name: m.auth_verify_title() }),
      ).not.toBeInTheDocument();
    },
  );
});
