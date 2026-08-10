import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { offerTwoFactorAtom } from "@/atoms/onboarding";
import { twoFactorPanelAtom, twoFactorSetupAtom } from "@/atoms/two-factor";
import { authClient } from "@/lib/auth-client";
import { WelcomePage } from "@/routes/welcome";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The two-factor offer renders only for a *complete* session with the
 * one-shot flag set (see atoms/onboarding.ts) — the default signed-in fixture
 * has a handle and a date of birth, so `needsFields` is false and the offer is
 * the page's only content.
 */
function offerStore() {
  const store = createStore();
  act(() => store.set(offerTwoFactorAtom, true));
  return store;
}

describe("WelcomePage two-factor offer", () => {
  it("renders the offer for a complete session with the flag set", async () => {
    await renderWithProviders(<WelcomePage />, {
      store: offerStore(),
      initialPath: "/welcome",
      signedInAs: true,
    });

    expect(screen.getByRole("heading", { name: m.welcome_2fa_title() })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.welcome_2fa_setup() })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.welcome_2fa_skip() })).toBeInTheDocument();
  });

  it("renders nothing for a complete session without the flag", async () => {
    await renderWithProviders(<WelcomePage />, { initialPath: "/welcome", signedInAs: true });

    expect(screen.queryByRole("heading", { name: m.welcome_2fa_title() })).not.toBeInTheDocument();
  });

  it("skip dismisses the offer and leaves the page", async () => {
    const store = offerStore();
    await renderWithProviders(<WelcomePage />, {
      store,
      initialPath: "/welcome",
      signedInAs: true,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.welcome_2fa_skip() }));

    expect(store.get(offerTwoFactorAtom)).toBe(false);
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: m.welcome_2fa_title() }),
      ).not.toBeInTheDocument(),
    );
  });

  it("runs the password, QR/backup-code, and TOTP verification steps", async () => {
    vi.mocked(authClient.twoFactor.enable).mockResolvedValueOnce({
      data: { totpURI: "otpauth://totp/MyTuums:alex", backupCodes: ["backup-one", "backup-two"] },
      error: null,
    });
    const store = offerStore();
    await renderWithProviders(<WelcomePage />, {
      store,
      initialPath: "/welcome",
      signedInAs: true,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.welcome_2fa_setup() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "account-password");
    await user.click(screen.getByRole("button", { name: m.welcome_2fa_setup() }));

    expect(authClient.twoFactor.enable).toHaveBeenCalledWith({ password: "account-password" });
    expect(await screen.findByText("backup-one")).toBeInTheDocument();
    expect(screen.getByText("backup-two")).toBeInTheDocument();
    expect(store.get(twoFactorPanelAtom)).toBe("verify");

    await user.type(screen.getByLabelText(m.twofa_field_code()), "123456");
    await user.click(screen.getByRole("button", { name: m.twofa_confirm() }));

    await waitFor(() =>
      expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
        code: "123456",
        trustDevice: false,
      }),
    );
    // A successful enrolment dismisses the offer — the same exit as Skip.
    expect(store.get(offerTwoFactorAtom)).toBe(false);
  });

  it("keeps the panel and shows the error when enabling fails", async () => {
    vi.mocked(authClient.twoFactor.enable).mockResolvedValueOnce({
      data: null,
      error: { message: "Invalid password" },
    });
    const store = offerStore();
    await renderWithProviders(<WelcomePage />, {
      store,
      initialPath: "/welcome",
      signedInAs: true,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.welcome_2fa_setup() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "wrong-password");
    await user.click(screen.getByRole("button", { name: m.welcome_2fa_setup() }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid password"));
    // The banner's title names the step that failed — the 2FA offer, not the
    // date-of-birth claim the old ternary would have said.
    expect(screen.getByRole("alert")).toHaveTextContent(m.welcome_2fa_setup_failed());
    expect(store.get(twoFactorPanelAtom)).toBe("enable");
    expect(store.get(offerTwoFactorAtom)).toBe(true);
  });

  it("closes the enrolment panel on unmount", async () => {
    const store = offerStore();
    const result = await renderWithProviders(<WelcomePage />, {
      store,
      initialPath: "/welcome",
      signedInAs: true,
    });
    act(() => store.set(twoFactorPanelAtom, "verify"));
    act(() => store.set(twoFactorSetupAtom, { totpURI: "otpauth://secret", backupCodes: [] }));

    result.unmount();

    expect(store.get(twoFactorPanelAtom)).toBe("idle");
    expect(store.get(twoFactorSetupAtom)).toBeNull();
  });
});

describe("WelcomePage completion gate", () => {
  it("renders the handle form for a session without one, and names the handle claim in the failure banner", async () => {
    vi.mocked(authClient.updateUser).mockResolvedValueOnce({
      data: null,
      error: { message: "USERNAME_IS_ALREADY_TAKEN" },
    });
    await renderWithProviders(<WelcomePage />, {
      initialPath: "/welcome",
      signedInAs: { username: null, displayUsername: null },
    });
    const user = userEvent.setup();

    expect(screen.getByRole("heading", { name: m.welcome_title() })).toBeInTheDocument();
    await user.type(screen.getByLabelText(m.auth_field_username()), "alexmercer");
    await user.click(screen.getByRole("button", { name: m.welcome_claim() }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.getByRole("alert")).toHaveTextContent(m.welcome_claim_failed());
    expect(screen.getByRole("heading", { name: m.welcome_title() })).toBeInTheDocument();
  });

  it("renders the date-of-birth form for a session without one, and names the DOB claim in the failure banner", async () => {
    vi.mocked(authClient.updateUser).mockResolvedValueOnce({
      data: null,
      error: { message: "Something went wrong" },
    });
    const store = createStore();
    // The offer flag is what holds the page on /welcome: a DOB-only session
    // has a handle, so `useRedirectWhenSignedIn` would otherwise send it to
    // its profile (the real app's `useRequireHandle` bounces it back). The
    // flag's offer branch keeps the page put without changing what renders —
    // `needsFields` still wins over the offer.
    act(() => store.set(offerTwoFactorAtom, true));
    await renderWithProviders(<WelcomePage />, {
      store,
      initialPath: "/welcome",
      signedInAs: { dateOfBirth: null },
    });
    const user = userEvent.setup();

    expect(screen.getByRole("heading", { name: m.welcome_dob_title() })).toBeInTheDocument();
    expect(screen.queryByLabelText(m.auth_field_username())).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(m.auth_field_date_of_birth()), "1995-01-01");
    await user.click(screen.getByRole("button", { name: m.welcome_dob_claim() }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.getByRole("alert")).toHaveTextContent(m.welcome_dob_claim_failed());
    expect(screen.getByRole("heading", { name: m.welcome_dob_title() })).toBeInTheDocument();
  });
});
