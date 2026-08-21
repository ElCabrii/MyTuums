import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryFixtures, renderWithProviders } from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { authPendingAtom } from "@/atoms/auth";
import { passkeysQueryKey } from "@/atoms/passkey";
import {
  twoFactorPanelAtom,
  twoFactorSecretCopiedAtom,
  twoFactorSecretShownAtom,
  twoFactorSetupAtom,
} from "@/atoms/two-factor";
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

/**
 * The enrolment fallbacks from issue #169: password-manager autofill on the
 * re-authentication field, and manual entry of the TOTP secret for anyone who
 * cannot scan the QR code.
 */
describe("TwoFactorSection — enrolment fallbacks (issue #169)", () => {
  /** A real enrolment URI — the fallback derives its key from the `secret` param. */
  const TOTP_URI =
    "otpauth://totp/MyTuums:alex@example.com?secret=JBSWY3DPEHPK3PXP&issuer=MyTuums";

  /**
   * Installs a clipboard stub. jsdom defines `navigator.clipboard` as a
   * getter-only property, so it cannot be assigned to — `defineProperty` is
   * the only way to substitute it, and each test restores nothing because
   * every test installs its own before use.
   */
  function stubClipboard(writeText: () => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    return writeText;
  }

  async function reachSetupPanel(store: ReturnType<typeof createStore>) {
    vi.mocked(authClient.twoFactor.enable).mockResolvedValueOnce({
      data: { totpURI: TOTP_URI, backupCodes: ["backup-one"] },
      error: null,
    });
    await renderWithProviders(<TwoFactorSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "account-password");
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    expect(await screen.findByText("backup-one")).toBeInTheDocument();
    return user;
  }

  it("gives the re-authentication field the semantics a password manager matches on", async () => {
    await renderWithProviders(<TwoFactorSection />, { store: createStore(), signedInAs: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));

    const field = screen.getByLabelText(m.auth_field_password());
    // Still a real password input — the value must never render as plain text.
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
    // The `name` is the half that was missing: managers key their heuristics
    // off the submitted field name, not `autocomplete` alone.
    expect(field).toHaveAttribute("name", "current-password");

    // An autofill entry is a (username, password) pair, so the form has to
    // carry an identity for the saved credential to match against. Hidden from
    // assistive tech and not focusable — it exists for the browser only.
    const username = document.querySelector('input[autocomplete="username"]');
    expect(username).not.toBeNull();
    expect(username).toHaveAttribute("readonly");
    expect(username).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the secret hidden until asked, then reveals and copies it", async () => {
    const store = createStore();
    const user = await reachSetupPanel(store);

    // Collapsed by default: the secret is the second factor, and most people
    // scanned the QR code and never need it on screen.
    expect(screen.queryByText(m.twofa_secret_key())).not.toBeInTheDocument();
    expect(screen.queryByText(/JBSW/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: m.twofa_cannot_scan() }));

    // Grouped into blocks of four so it can be typed without losing your place.
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();

    const writeText = stubClipboard(vi.fn(() => Promise.resolve()));
    await user.click(screen.getByRole("button", { name: m.twofa_copy_secret() }));

    // The UNformatted value is copied — nothing depends on the authenticator
    // app stripping the display whitespace.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP"));
    expect(await screen.findByRole("button", { name: m.twofa_secret_copied() })).toBeInTheDocument();
  });

  it("leaves the revealed key on screen when the clipboard is unavailable", async () => {
    const store = createStore();
    const user = await reachSetupPanel(store);
    await user.click(screen.getByRole("button", { name: m.twofa_cannot_scan() }));

    // Denied permission, plain HTTP, or an embedded webview. The step must
    // degrade to "select it yourself", not break.
    stubClipboard(vi.fn(() => Promise.reject(new Error("denied"))));
    await user.click(screen.getByRole("button", { name: m.twofa_copy_secret() }));

    await waitFor(() => expect(store.get(twoFactorSecretCopiedAtom)).toBe(false));
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    // No false confirmation that it was copied.
    expect(screen.queryByRole("button", { name: m.twofa_secret_copied() })).not.toBeInTheDocument();
  });

  it("re-collapses the fallback when enrolment is left, discarding the secret with it", async () => {
    const store = createStore();
    const user = await reachSetupPanel(store);
    await user.click(screen.getByRole("button", { name: m.twofa_cannot_scan() }));
    expect(store.get(twoFactorSecretShownAtom)).toBe(true);

    await user.click(screen.getByRole("button", { name: m.common_cancel() }));

    // A revealed secret must not survive leaving the step — and the secret
    // itself goes with it, as it did before this fallback existed.
    expect(store.get(twoFactorSecretShownAtom)).toBe(false);
    expect(store.get(twoFactorSetupAtom)).toBeNull();
  });

  it("offers no fallback when the URI carries no secret to show", async () => {
    vi.mocked(authClient.twoFactor.enable).mockResolvedValueOnce({
      data: { totpURI: "otpauth://secret", backupCodes: ["backup-one"] },
      error: null,
    });
    const store = createStore();
    await renderWithProviders(<TwoFactorSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    await user.type(screen.getByLabelText(m.auth_field_password()), "account-password");
    await user.click(screen.getByRole("button", { name: m.twofa_enable() }));
    expect(await screen.findByText("backup-one")).toBeInTheDocument();

    // Offering an empty key to type in would be worse than offering nothing.
    expect(screen.queryByRole("button", { name: m.twofa_cannot_scan() })).not.toBeInTheDocument();
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
