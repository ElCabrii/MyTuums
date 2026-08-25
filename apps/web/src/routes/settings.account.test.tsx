import { describe, expect, it } from "vitest";
import { createTestQueryClient, renderWithProviders } from "@/test/render";
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
import { AccountSettingsPage } from "@/routes/settings.account";
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
    // Two group landmarks head the page; each card's own title nests below as
    // an h3 (see components/settings/section.tsx).
    expect(
      screen.getByRole("heading", { level: 2, name: m.settings_group_profile() }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: m.settings_group_account() }),
    ).toBeInTheDocument();
    for (const title of [
      m.settings_profile_title(),
      m.settings_handle_title(),
      m.settings_password_title(),
      m.settings_prefs_title(),
      m.twofa_section_title(),
      m.passkey_section_title(),
      m.settings_blocked_title(),
    ]) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
    }
    expect(
      screen.queryByRole("heading", { name: m.settings_linked_title() }),
    ).not.toBeInTheDocument();
    // Sign-out is no longer a section on this page — it lives in the navbar
    // account menu (header.tsx). See issue #217.
    expect(screen.queryByRole("heading", { name: m.auth_sign_out() })).not.toBeInTheDocument();

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
