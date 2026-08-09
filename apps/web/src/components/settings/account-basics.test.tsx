import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  patchTestSessionUser,
  renderWithProviders,
  seedQueryLoading,
  setTestSignedOut,
} from "@/test/render";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { authErrorAtom, authPendingAtom } from "@/atoms/auth";
import { handleChangeDraftAtom } from "@/atoms/account";
import { linkedAccountsQueryKey } from "@/atoms/linked-accounts";
import { authClient } from "@/lib/auth-client";
import { HandleSection } from "@/components/settings/handle-section";
import { PasswordSection } from "@/components/settings/password-section";
import { PreferencesSection } from "@/components/settings/preferences-section";
import { SignOutSection } from "@/components/settings/sign-out-section";
import { m } from "@/paraglide/messages.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HandleSection", () => {
  it("guards empty and invalid submissions before transport", async () => {
    const store = createStore();
    await renderWithProviders(<HandleSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    const submit = screen.getByRole("button", { name: m.settings_handle_submit() });

    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(m.auth_field_username()), "no spaces!");
    await user.click(submit);

    expect(authClient.updateUser).not.toHaveBeenCalled();
    expect(store.get(authErrorAtom)).toMatch(/letters, numbers/i);
  });

  it("navigates to the normalized handle returned by the refreshed session", async () => {
    vi.mocked(authClient.updateUser).mockImplementationOnce(() => {
      patchTestSessionUser({ username: "newhandle", displayUsername: "NewHandle" });
      return Promise.resolve({ data: {}, error: null });
    });
    const { router } = await renderWithProviders(<HandleSection />, { signedInAs: true });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(m.auth_field_username()), "  NewHandle  ");
    await user.click(screen.getByRole("button", { name: m.settings_handle_submit() }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/@newhandle"));
    expect(authClient.updateUser).toHaveBeenCalledWith({ username: "NewHandle" });
  });

  it("disables while pending and clears its draft on unmount", async () => {
    const store = createStore();
    const result = await renderWithProviders(<HandleSection />, { store, signedInAs: true });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.auth_field_username()), "next-handle");

    act(() => store.set(authPendingAtom, true));
    expect(screen.getByRole("button", { name: m.settings_handle_submit() })).toBeDisabled();
    result.unmount();

    expect(store.get(handleChangeDraftAtom)).toBe("");
    expect(store.get(authErrorAtom)).toBeNull();
  });
});

describe("PasswordSection", () => {
  it("stays hidden while linked accounts load and for OAuth-only accounts", async () => {
    const loadingClient = createTestQueryClient();
    seedQueryLoading(loadingClient, linkedAccountsQueryKey);
    const loading = await renderWithProviders(<PasswordSection />, {
      queryClient: loadingClient,
      signedInAs: true,
    });
    expect(
      screen.queryByRole("heading", { name: m.settings_password_title() }),
    ).not.toBeInTheDocument();
    loading.unmount();

    const oauthClient = createTestQueryClient();
    oauthClient.setQueryData(linkedAccountsQueryKey, [
      { providerId: "google", accountId: "google-1" },
    ]);
    await renderWithProviders(<PasswordSection />, {
      queryClient: oauthClient,
      signedInAs: true,
    });
    expect(
      screen.queryByRole("heading", { name: m.settings_password_title() }),
    ).not.toBeInTheDocument();
  });

  it("reports validation without a request", async () => {
    const store = createStore();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(linkedAccountsQueryKey, [
      { providerId: "credential", accountId: "credential-1" },
    ]);
    await renderWithProviders(<PasswordSection />, { store, queryClient, signedInAs: true });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(m.auth_field_current_password()), "old-password");
    await user.type(screen.getByLabelText(m.auth_field_new_password()), "short");
    await user.type(screen.getByLabelText(m.auth_field_confirm_new_password()), "short");
    await user.click(screen.getByRole("button", { name: m.settings_password_submit() }));

    expect(authClient.changePassword).not.toHaveBeenCalled();
    expect(store.get(authErrorAtom)).toMatch(/at least 8 characters/i);
  });

  it("revokes other sessions, reports success, and clears every password field", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(linkedAccountsQueryKey, [
      { providerId: "credential", accountId: "credential-1" },
    ]);
    await renderWithProviders(<PasswordSection />, { queryClient, signedInAs: true });
    const user = userEvent.setup();
    const current = screen.getByLabelText(m.auth_field_current_password());
    const next = screen.getByLabelText(m.auth_field_new_password());
    const confirm = screen.getByLabelText(m.auth_field_confirm_new_password());

    await user.type(current, "old-password");
    await user.type(next, "new-password");
    await user.type(confirm, "new-password");
    await user.click(screen.getByRole("button", { name: m.settings_password_submit() }));

    expect(await screen.findByRole("status")).toHaveTextContent(m.settings_password_changed());
    expect(authClient.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password",
      newPassword: "new-password",
      revokeOtherSessions: true,
    });
    expect(current).toHaveValue("");
    expect(next).toHaveValue("");
    expect(confirm).toHaveValue("");
  });
});

describe("PreferencesSection", () => {
  it("reflects stored choices and persists theme and locale selections", async () => {
    await renderWithProviders(<PreferencesSection />, {
      signedInAs: { themePreference: "dark", localePreference: "fr" },
    });
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: m.theme_dark() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: m.locale_french() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: m.theme_light() }));
    await user.click(screen.getByRole("button", { name: m.locale_english() }));

    await waitFor(() => {
      expect(authClient.updateUser).toHaveBeenCalledWith({ themePreference: "light" });
      expect(authClient.updateUser).toHaveBeenCalledWith({ localePreference: "en" });
    });
  });

  it("suppresses clicks while another account action is pending", async () => {
    const store = createStore();
    store.set(authPendingAtom, true);
    await renderWithProviders(<PreferencesSection />, { store, signedInAs: true });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.theme_dark() }));
    await user.click(screen.getByRole("button", { name: m.locale_french() }));
    expect(authClient.updateUser).not.toHaveBeenCalled();
  });
});

describe("SignOutSection", () => {
  it("stays busy and on the page until the session is actually signed out", async () => {
    let release!: () => void;
    vi.mocked(authClient.signOut).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: {}, error: null });
        }),
    );
    const { router } = await renderWithProviders(<SignOutSection />, {
      initialPath: "/settings/account",
      signedInAs: true,
    });
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: m.auth_sign_out() });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(router.state.location.pathname).toBe("/settings/account");

    act(() => {
      setTestSignedOut();
      release();
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});
