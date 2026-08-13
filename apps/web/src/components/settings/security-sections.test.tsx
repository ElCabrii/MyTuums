import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryFixtures, renderWithProviders } from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { authPendingAtom } from "@/atoms/auth";
import { passkeysQueryKey } from "@/atoms/passkey";
import { twoFactorPanelAtom, twoFactorSetupAtom } from "@/atoms/two-factor";
import { authClient } from "@/lib/auth-client";
import { PasskeySection } from "@/components/settings/passkey-section";
import { TwoFactorSection } from "@/components/settings/two-factor-section";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TwoFactorSection", () => {
  it("runs the password, QR/backup-code, and TOTP verification steps", async () => {
    vi.mocked(authClient.twoFactor.enable).mockResolvedValueOnce({
      data: { totpURI: "otpauth://totp/MyTuums:alex", backupCodes: ["backup-one", "backup-two"] },
      error: null,
    });
    const store = createStore();
    await renderWithProviders(<TwoFactorSection />, { store, signedInAs: true });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "account-password");
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));

    expect(authClient.twoFactor.enable).toHaveBeenCalledWith({ password: "account-password" });
    expect(await screen.findByText("backup-one")).toBeInTheDocument();
    expect(screen.getByText("backup-two")).toBeInTheDocument();
    await user.type(screen.getByLabelText(m.twofa_field_code()), "123456");
    await user.click(screen.getByRole("button", { name: m.twofa_confirm() }));

    await waitFor(() =>
      expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
        code: "123456",
        trustDevice: false,
      }),
    );
    expect(store.get(twoFactorPanelAtom)).toBe("idle");
    expect(store.get(twoFactorSetupAtom)).toBeNull();
  });

  it("disables two-factor with the current password", async () => {
    const store = createStore();
    await renderWithProviders(<TwoFactorSection />, {
      store,
      signedInAs: { twoFactorEnabled: true },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.twofa_disable() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "account-password");
    await user.click(screen.getByRole("button", { name: m.twofa_disable() }));

    await waitFor(() =>
      expect(authClient.twoFactor.disable).toHaveBeenCalledWith({ password: "account-password" }),
    );
    expect(store.get(twoFactorPanelAtom)).toBe("idle");
  });

  it("discards the generated secret on cancel and disables action controls while pending", async () => {
    vi.mocked(authClient.twoFactor.enable).mockResolvedValueOnce({
      data: { totpURI: "otpauth://secret", backupCodes: ["one-time-code"] },
      error: null,
    });
    const store = createStore();
    await renderWithProviders(<TwoFactorSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "account-password");
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    expect(await screen.findByText("one-time-code")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: m.common_cancel() }));
    expect(store.get(twoFactorPanelAtom)).toBe("idle");
    expect(store.get(twoFactorSetupAtom)).toBeNull();

    act(() => store.set(authPendingAtom, true));
    expect(screen.getByRole("button", { name: m.twofa_enable() })).toBeDisabled();
  });
});

describe("PasskeySection", () => {
  it("renders loading, empty, and populated list states", async () => {
    const loadingClient = createTestQueryClient();
    queryFixtures(loadingClient).query.loading(passkeysQueryKey);
    const loading = await renderWithProviders(<PasskeySection />, {
      queryClient: loadingClient,
      signedInAs: true,
    });
    expect(screen.getByText(m.passkey_loading())).toBeInTheDocument();
    loading.unmount();

    const emptyClient = createTestQueryClient();
    emptyClient.setQueryData(passkeysQueryKey, []);
    const empty = await renderWithProviders(<PasskeySection />, {
      queryClient: emptyClient,
      signedInAs: true,
    });
    expect(screen.getByText(m.passkey_empty())).toBeInTheDocument();
    empty.unmount();

    const listClient = createTestQueryClient();
    listClient.setQueryData(passkeysQueryKey, [
      { id: "key-1", name: "Laptop" },
      { id: "key-2", name: null },
    ]);
    await renderWithProviders(<PasskeySection />, { queryClient: listClient, signedInAs: true });
    expect(screen.getByText("Laptop")).toBeInTheDocument();
    expect(screen.getByText(m.passkey_unnamed())).toBeInTheDocument();
  });

  it("trims an added passkey name and clears the input after success", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(passkeysQueryKey, []);
    await renderWithProviders(<PasskeySection />, { queryClient, signedInAs: true });
    const user = userEvent.setup();
    const input = screen.getByLabelText(m.passkey_name_label());

    await user.type(input, "  Desk key  ");
    await user.click(screen.getByRole("button", { name: m.passkey_add() }));

    await waitFor(() =>
      expect(authClient.passkey.addPasskey).toHaveBeenCalledWith({ name: "Desk key" }),
    );
    expect(input).toHaveValue("");
  });

  it("supports rename cancellation, trimmed rename, and exact deletion", async () => {
    vi.mocked(authClient.passkey.listUserPasskeys).mockResolvedValue({
      data: [{ id: "key-1", name: "Laptop" }],
      error: null,
    });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(passkeysQueryKey, [{ id: "key-1", name: "Laptop" }]);
    await renderWithProviders(<PasskeySection />, { queryClient, signedInAs: true });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.passkey_rename() }));
    expect(screen.getAllByLabelText(m.passkey_name_label())[0]).toHaveValue("Laptop");
    await user.click(screen.getByRole("button", { name: m.common_cancel() }));
    expect(authClient.passkey.updatePasskey).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: m.passkey_rename() }));
    const draft = screen.getAllByLabelText(m.passkey_name_label())[0];
    await user.clear(draft);
    await user.type(draft, "  Travel key  ");
    await user.click(screen.getByRole("button", { name: m.common_save() }));
    await waitFor(() =>
      expect(authClient.passkey.updatePasskey).toHaveBeenCalledWith({
        id: "key-1",
        name: "Travel key",
      }),
    );

    await user.click(
      screen.getByRole("button", { name: m.passkey_delete_label({ name: "Laptop" }) }),
    );
    await waitFor(() =>
      expect(authClient.passkey.deletePasskey).toHaveBeenCalledWith({ id: "key-1" }),
    );
  });

  it("locks add, rename-save, and delete requests while another action is pending", async () => {
    const store = createStore();
    store.set(authPendingAtom, true);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(passkeysQueryKey, [{ id: "key-1", name: "Laptop" }]);
    await renderWithProviders(<PasskeySection />, { store, queryClient, signedInAs: true });
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: m.passkey_add() })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: m.passkey_delete_label({ name: "Laptop" }) }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: m.passkey_rename() }));
    expect(screen.getByRole("button", { name: m.common_save() })).toBeDisabled();
  });
});
