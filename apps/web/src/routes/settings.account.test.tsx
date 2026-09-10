import { describe, expect, it } from "vitest";
import { createTestQueryClient } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { act, screen } from "@testing-library/react";
import { createStore } from "jotai";
import { authErrorAtom } from "@/atoms/auth";
import { linkedAccountsQueryKey } from "@/atoms/linked-accounts";
import {
  editingPasskeyIdAtom,
  newPasskeyNameAtom,
  passkeyNameDraftAtom,
  passkeysQueryKey,
} from "@/atoms/passkey";
import {
  twoFactorCodeAtom,
  twoFactorPanelAtom,
  twoFactorPasswordAtom,
  twoFactorSetupAtom,
} from "@/atoms/two-factor";
import { orpc } from "@/lib/orpc";
import { AccountSettingsPage } from "@/components/account-settings-page";
import { m } from "@/paraglide/messages.js";

function seededSettingsClient() {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(linkedAccountsQueryKey, [
    { providerId: "credential", accountId: "credential-1" },
  ]);
  queryClient.setQueryData(passkeysQueryKey, []);
  queryClient.setQueryData(orpc.moderation.listBlocked.queryKey(), { items: [] });
  return queryClient;
}

describe("AccountSettingsPage", () => {
  it("composes every configured section and exposes one shared error banner", async () => {
    const store = createStore();
    await renderWithProviders(<AccountSettingsPage />, {
      store,
      queryClient: seededSettingsClient(),
      initialPath: "/settings/account",
      signedInAs: true,
    });

    expect(screen.getByRole("heading", { level: 1, name: m.settings_title() })).toBeInTheDocument();
    const user = userEvent.setup();
    expect(screen.queryByLabelText(m.auth_field_display_name())).not.toBeInTheDocument();
    expect(screen.queryByLabelText(m.auth_field_bio())).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: m.settings_handle_title() })).toBeVisible();
    expect(screen.getByRole("heading", { name: m.auth_sign_out() })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: m.settings_group_security() }));
    for (const title of [
      m.settings_password_title(),
      m.twofa_section_title(),
      m.passkey_section_title(),
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
    }
    const password = screen.getByLabelText(m.auth_field_current_password());
    await user.type(password, "draft-password");
    await user.click(screen.getByRole("tab", { name: m.settings_group_privacy() }));
    expect(screen.getByRole("heading", { name: m.settings_blocked_title() })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: m.settings_group_preferences() }));
    expect(screen.getByRole("heading", { name: m.settings_prefs_title() })).toBeVisible();
    await user.click(screen.getByRole("tab", { name: m.settings_group_security() }));
    expect(screen.getByLabelText(m.auth_field_current_password())).toHaveValue("draft-password");

    act(() => store.set(authErrorAtom, "One shared failure"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("One shared failure");
  });

  it("scrubs passkey drafts and the two-factor secret when the route unmounts", async () => {
    const store = createStore();
    const result = await renderWithProviders(<AccountSettingsPage />, {
      store,
      queryClient: seededSettingsClient(),
      initialPath: "/settings/account",
      signedInAs: true,
    });
    act(() => {
      store.set(editingPasskeyIdAtom, "key-1");
      store.set(passkeyNameDraftAtom, "Rename me");
      store.set(newPasskeyNameAtom, "New key");
      store.set(twoFactorPanelAtom, "verify");
      store.set(twoFactorSetupAtom, { totpURI: "otpauth://secret", backupCodes: ["secret"] });
      store.set(twoFactorPasswordAtom, "password");
      store.set(twoFactorCodeAtom, "123456");
    });

    result.unmount();

    expect(store.get(editingPasskeyIdAtom)).toBeNull();
    expect(store.get(passkeyNameDraftAtom)).toBe("");
    expect(store.get(newPasskeyNameAtom)).toBe("");
    expect(store.get(twoFactorPanelAtom)).toBe("idle");
    expect(store.get(twoFactorSetupAtom)).toBeNull();
    expect(store.get(twoFactorPasswordAtom)).toBe("");
    expect(store.get(twoFactorCodeAtom)).toBe("");
  });
});
