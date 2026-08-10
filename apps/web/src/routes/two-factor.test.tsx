import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { authErrorAtom, twoFactorMethodsAtom } from "@/atoms/auth";
import {
  selectedTwoFactorMethodAtom,
  trustDeviceAtom,
  twoFactorCodeAtom,
} from "@/atoms/two-factor";
import { authClient } from "@/lib/auth-client";
import { TwoFactorPage } from "@/routes/two-factor";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TwoFactorPage", () => {
  it("renders the TOTP challenge by default and offers every method on a direct hit", async () => {
    await renderWithProviders(<TwoFactorPage />, { initialPath: "/two-factor" });

    expect(
      screen.getByRole("heading", { name: m.twofa_challenge_title() }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(m.twofa_field_code())).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: m.twofa_trust_device() })).not.toBeChecked();
    expect(screen.getByRole("button", { name: m.twofa_verify() })).toBeInTheDocument();
    // Direct hit: no methods were reported by a sign-in, so the page offers
    // every escape hatch rather than an error — the challenge cookie is
    // server-side and outlives the atom.
    expect(screen.getByRole("button", { name: m.twofa_use_email_code() })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.twofa_use_backup_code() })).toBeInTheDocument();
  });

  it("hides the email-code option when the challenge only accepts TOTP", async () => {
    const store = createStore();
    act(() => store.set(twoFactorMethodsAtom, ["totp"]));
    await renderWithProviders(<TwoFactorPage />, { store, initialPath: "/two-factor" });

    expect(
      screen.queryByRole("button", { name: m.twofa_use_email_code() }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.twofa_use_backup_code() })).toBeInTheDocument();
  });

  it("switches methods, clearing the half-typed code and the previous error", async () => {
    const store = createStore();
    act(() => store.set(twoFactorMethodsAtom, ["totp", "otp"]));
    await renderWithProviders(<TwoFactorPage />, { store, initialPath: "/two-factor" });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.twofa_field_code()), "123456");
    act(() => store.set(authErrorAtom, "Previous failure"));

    await user.click(screen.getByRole("button", { name: m.twofa_use_email_code() }));
    await waitFor(() => expect(authClient.twoFactor.sendOtp).toHaveBeenCalled());
    expect(store.get(selectedTwoFactorMethodAtom)).toBe("otp");
    expect(store.get(twoFactorCodeAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
    expect(screen.getByText(m.twofa_challenge_email_subtitle())).toBeInTheDocument();
    // The email-code escape hatch is the button that put us here — it must
    // not linger while the email form is already on screen.
    expect(
      screen.queryByRole("button", { name: m.twofa_use_email_code() }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: m.twofa_use_backup_code() }));
    expect(store.get(selectedTwoFactorMethodAtom)).toBe("backup");
    expect(screen.getByLabelText(m.twofa_field_backup_code())).toBeInTheDocument();
    expect(screen.getByText(m.twofa_challenge_backup_subtitle())).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: m.twofa_use_authenticator() }));
    expect(store.get(selectedTwoFactorMethodAtom)).toBe("totp");
    expect(screen.getByText(m.twofa_challenge_totp_subtitle())).toBeInTheDocument();
  });

  it("verifies a TOTP code with the trust-device flag and clears the code on success", async () => {
    const store = createStore();
    await renderWithProviders(<TwoFactorPage />, { store, initialPath: "/two-factor" });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.twofa_field_code()), "123456");
    await user.click(screen.getByRole("checkbox", { name: m.twofa_trust_device() }));
    await user.click(screen.getByRole("button", { name: m.twofa_verify() }));

    await waitFor(() =>
      expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
        code: "123456",
        trustDevice: true,
      }),
    );
    expect(store.get(twoFactorCodeAtom)).toBe("");
  });

  it("dispatches backup codes to the backup endpoint", async () => {
    await renderWithProviders(<TwoFactorPage />, { initialPath: "/two-factor" });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.twofa_use_backup_code() }));
    await user.type(screen.getByLabelText(m.twofa_field_backup_code()), "backup-1");
    await user.click(screen.getByRole("button", { name: m.twofa_verify() }));

    await waitFor(() =>
      expect(authClient.twoFactor.verifyBackupCode).toHaveBeenCalledWith({
        code: "backup-1",
        trustDevice: false,
      }),
    );
  });

  it("surfaces a server rejection in the error banner and stays on the page", async () => {
    const store = createStore();
    vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValueOnce({
      data: null,
      error: { message: "Invalid code" },
    });
    await renderWithProviders(<TwoFactorPage />, { store, initialPath: "/two-factor" });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.twofa_field_code()), "000000");
    await user.click(screen.getByRole("button", { name: m.twofa_verify() }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid code"));
    expect(store.get(authErrorAtom)).toBe("Invalid code");
    expect(screen.getByRole("heading", { name: m.twofa_challenge_title() })).toBeInTheDocument();
  });

  it("renders with a ?redirect= param without acting on it while signed out", async () => {
    await renderWithProviders(<TwoFactorPage />, {
      initialPath: "/two-factor?redirect=/settings/account",
    });

    expect(
      screen.getByRole("heading", { name: m.twofa_challenge_title() }),
    ).toBeInTheDocument();
  });

  it("resets the challenge state on unmount", async () => {
    const store = createStore();
    const result = await renderWithProviders(<TwoFactorPage />, { store, initialPath: "/two-factor" });
    act(() => {
      store.set(twoFactorCodeAtom, "123456");
      store.set(trustDeviceAtom, true);
      store.set(selectedTwoFactorMethodAtom, "backup");
      store.set(authErrorAtom, "Failure");
    });

    result.unmount();

    expect(store.get(twoFactorCodeAtom)).toBe("");
    expect(store.get(trustDeviceAtom)).toBe(false);
    expect(store.get(selectedTwoFactorMethodAtom)).toBe("totp");
    expect(store.get(authErrorAtom)).toBeNull();
  });
});
