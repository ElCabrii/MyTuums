import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTestSocialProviders } from "@/test/auth-fixture";
import { createTestQueryClient } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { authPendingAtom } from "@/atoms/auth";
import { linkedAccountsQueryKey } from "@/atoms/linked-accounts";
import { authClient } from "@/lib/auth-client";
import { orpc, type BlockedUser } from "@/lib/orpc";
import { BlockedUsersSection } from "@/components/settings/blocked-users-section";
import { LinkedAccountsSection } from "@/components/settings/linked-accounts-section";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  post: { list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn(), users: vi.fn(), typeahead: vi.fn() },
  user: { followers: vi.fn(), following: vi.fn(), byUsername: vi.fn() },
  moderation: {
    listBlocked: vi.fn(),
    unblock: vi.fn(),
    queue: vi.fn(),
    case: vi.fn(),
    auditLog: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

function makeBlockedUser(overrides: Partial<BlockedUser> & { id: string }): BlockedUser {
  return {
    name: "Blocked Person",
    username: "blocked",
    displayUsername: "blocked",
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    isPrivate: false,
    blockedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LinkedAccountsSection", () => {
  it("is absent when this build has no configured social providers", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(linkedAccountsQueryKey, []);
    await renderWithProviders(<LinkedAccountsSection />, { queryClient, signedInAs: true });

    expect(
      screen.queryByRole("heading", { name: m.settings_linked_title() }),
    ).not.toBeInTheDocument();
  });

  it("shows the provider loading state", async () => {
    setTestSocialProviders([{ id: "google", label: "Google" }]);
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).query.loading(linkedAccountsQueryKey);
    await renderWithProviders(<LinkedAccountsSection />, { queryClient, signedInAs: true });

    expect(screen.getByText(m.settings_linked_loading())).toBeInTheDocument();
  });

  it("links with an absolute settings callback and unlinks the exact account", async () => {
    setTestSocialProviders([
      { id: "google", label: "Google" },
      { id: "discord", label: "Discord" },
    ]);
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(linkedAccountsQueryKey, [
      { providerId: "credential", accountId: "credential-1" },
      { providerId: "google", accountId: "google-1" },
    ]);
    await renderWithProviders(<LinkedAccountsSection />, { queryClient, signedInAs: true });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: m.settings_linked_link() }));
    expect(authClient.linkSocial).toHaveBeenCalledWith({
      provider: "discord",
      callbackURL: `${window.location.origin}/settings/account`,
    });

    await user.click(screen.getByRole("button", { name: m.settings_linked_unlink() }));
    await waitFor(() =>
      expect(authClient.unlinkAccount).toHaveBeenCalledWith({
        providerId: "google",
        accountId: "google-1",
      }),
    );
  });

  it("locks the last sign-in method and suppresses every provider action while busy", async () => {
    setTestSocialProviders([{ id: "google", label: "Google" }]);
    const lastClient = createTestQueryClient();
    lastClient.setQueryData(linkedAccountsQueryKey, [
      { providerId: "google", accountId: "google-1" },
    ]);
    const last = await renderWithProviders(<LinkedAccountsSection />, {
      queryClient: lastClient,
      signedInAs: true,
    });
    const unlink = screen.getByRole("button", { name: m.settings_linked_unlink() });
    expect(unlink).toBeDisabled();
    expect(unlink).toHaveAttribute("title", m.settings_linked_last_method());
    last.unmount();

    setTestSocialProviders([
      { id: "google", label: "Google" },
      { id: "discord", label: "Discord" },
    ]);
    const store = createStore();
    store.set(authPendingAtom, true);
    const busyClient = createTestQueryClient();
    busyClient.setQueryData(linkedAccountsQueryKey, [
      { providerId: "credential", accountId: "credential-1" },
      { providerId: "google", accountId: "google-1" },
    ]);
    await renderWithProviders(<LinkedAccountsSection />, {
      store,
      queryClient: busyClient,
      signedInAs: true,
    });
    expect(screen.getByRole("button", { name: m.settings_linked_link() })).toBeDisabled();
    expect(screen.getByRole("button", { name: m.settings_linked_unlink() })).toBeDisabled();
  });
});

describe("BlockedUsersSection", () => {
  it("renders loading, a retryable error, and the empty result", async () => {
    const loadingClient = createTestQueryClient();
    queryFixtures(loadingClient).query.loading(orpc.moderation.listBlocked.queryKey());
    const loading = await renderWithProviders(<BlockedUsersSection />, {
      queryClient: loadingClient,
      signedInAs: true,
    });
    expect(screen.getByText(m.settings_blocked_loading())).toBeInTheDocument();
    loading.unmount();

    fakeClient.moderation.listBlocked.mockResolvedValueOnce({ items: [] });
    const errorClient = createTestQueryClient();
    await queryFixtures(errorClient).query.error(
      orpc.moderation.listBlocked.queryKey(),
      new Error("temporary failure"),
    );
    await renderWithProviders(<BlockedUsersSection />, {
      queryClient: errorClient,
      signedInAs: true,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(m.settings_blocked_error());
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.common_try_again() }));
    expect(await screen.findByText(m.settings_blocked_empty())).toBeInTheDocument();
  });

  it("renders linked and handle-less rows, unblocks the exact target, and locks every row", async () => {
    let release!: () => void;
    fakeClient.moderation.unblock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ userId: "linked-1", blocked: false });
        }),
    );
    fakeClient.moderation.listBlocked.mockResolvedValue({ items: [] });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(orpc.moderation.listBlocked.queryKey(), {
      items: [
        makeBlockedUser({
          id: "linked-1",
          name: "Linked Person",
          username: "linked",
          displayUsername: "Linked",
        }),
        makeBlockedUser({
          id: "handleless-1",
          name: "No Handle",
          username: null,
          displayUsername: null,
        }),
      ],
    });
    await renderWithProviders(<BlockedUsersSection />, { queryClient, signedInAs: true });
    const user = userEvent.setup();

    expect(screen.getByRole("link", { name: /Linked Person/ })).toHaveAttribute("href", "/@linked");
    expect(screen.getByText("No Handle").closest("a")).toBeNull();
    const buttons = screen.getAllByRole("button", { name: m.settings_blocked_unblock() });
    await user.click(buttons[0]);

    await waitFor(() => {
      expect(fakeClient.moderation.unblock).toHaveBeenCalledWith(
        { userId: "linked-1" },
        expect.anything(),
      );
      for (const button of buttons) expect(button).toBeDisabled();
    });
    release();
  });
});
