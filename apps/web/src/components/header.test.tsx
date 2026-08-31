import { describe, expect, it, vi } from "vitest";
import { setTestSession } from "@/test/auth-fixture";
import { renderWithProviders } from "@/test/render";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { Header } from "@/components/header";
import { authClient } from "@/lib/auth-client";
import { installTestOrpc } from "@/lib/orpc";
import { createTestQueryClient } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { m } from "@/paraglide/messages.js";

/**
 * The header avatar. Signed in with a handle, clicking it opens the account
 * menu (View profile, Settings, Sign out); signed in without one (an OAuth
 * sign-up before /welcome) it stays a plain link — the regression
 * `e2e/tests/specs/welcome.spec.ts` pins on the live stack.
 */

// The header now mounts the unread-count query; the fake keeps that off the
// network for every test in this file, seeded through `queryFixtures` where
// a test wants a specific count.
const fakeClient = {
  notification: {
    unreadCount: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

const signedOutSession = {
  data: null,
  isPending: false,
  isRefetching: false,
  error: null,
  refetch: vi.fn(() => Promise.resolve()),
};

describe("Header account menu", () => {
  it("opens the menu on the avatar and shows View profile, Settings and Sign out", async () => {
    await renderWithProviders(<Header />, { signedInAs: { username: "alexmercer" } });

    // The trigger is the avatar pill: the avatar's alt plus the name span
    // both feed its accessible name.
    const trigger = screen.getByRole("button", { name: /Alex Mercer/ });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(trigger);

    // Base-UI mounts the popup asynchronously on open — findBy* like the
    // follow-list-dialog test's, not getBy* straight after the click.
    expect(
      await screen.findByRole("menuitem", { name: m.menu_view_profile() }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: m.profile_settings() })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: m.auth_sign_out() })).toBeInTheDocument();
  });

  it("navigates to the own profile from View profile", async () => {
    const { router } = await renderWithProviders(<Header />, {
      signedInAs: { username: "alexmercer" },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Alex Mercer/ }));
    await user.click(await screen.findByRole("menuitem", { name: m.menu_view_profile() }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/@alexmercer"));
  });

  it("navigates to /settings/account from Settings", async () => {
    const { router } = await renderWithProviders(<Header />, {
      signedInAs: { username: "alexmercer" },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Alex Mercer/ }));
    await user.click(await screen.findByRole("menuitem", { name: m.profile_settings() }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
  });

  it("signs out from the menu and lands on /login", async () => {
    const { router } = await renderWithProviders(<Header />, {
      signedInAs: { username: "alexmercer" },
    });

    // The real client resolves `/sign-out` before its own `/get-session`
    // refetch empties the store; the mock mirrors that by flipping the
    // session store from inside the call, which is what `signOutAtom`'s
    // `waitForSignedOut()` is waiting for.
    vi.mocked(authClient.signOut).mockImplementation(() => {
      setTestSession(signedOutSession);
      return Promise.resolve({ data: {}, error: null });
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Alex Mercer/ }));
    await user.click(await screen.findByRole("menuitem", { name: m.auth_sign_out() }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(authClient.signOut).toHaveBeenCalled();
    // The header renders only for a real session — the mirror of the e2e
    // assertion that sign-out leaves no banner behind.
    await waitFor(() => expect(screen.queryByRole("banner")).not.toBeInTheDocument());
  });

  it("stays a plain link to /welcome while the session has no handle", async () => {
    await renderWithProviders(<Header />, {
      // `handleOf` falls back to displayUsername, so a handle-less session
      // must null both — the default fixture's displayUsername would hand
      // the header a handle and open the menu.
      signedInAs: { username: null, displayUsername: null },
    });

    const link = screen.getByRole("link", { name: /Alex Mercer/ });
    expect(link).toHaveAttribute("href", "/welcome");
    // Not a button: there is no menu to open until a handle exists.
    expect(screen.queryByRole("button", { name: /Alex Mercer/ })).not.toBeInTheDocument();
  });
});

describe("Header notifications bell", () => {
  it("links to /notifications and carries the unread count on itself and in its label", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.unreadCount(3);

    const { router } = await renderWithProviders(<Header />, {
      queryClient,
      signedInAs: { username: "alexmercer" },
    });

    // The shadcn Button renders its `render` prop anchor with an explicit
    // `role="button"`, so that — not "link" — is the accessible role, while
    // the href keeps it a real anchor for navigation and middle-click.
    const bell = screen.getByRole("button", {
      name: m.nav_notifications_unread_many({ count: 3 }),
    });
    expect(bell).toHaveAttribute("href", "/notifications");
    // The count renders as the badge inside the bell, not free-floating text.
    expect(within(bell).getByText("3")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(bell);
    await waitFor(() => expect(router.state.location.pathname).toBe("/notifications"));
  });

  it("renders the plain bell — no badge, no unread label — when the count is zero", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.unreadCount(0);

    await renderWithProviders(<Header />, {
      queryClient,
      signedInAs: { username: "alexmercer" },
    });

    expect(screen.getByRole("button", { name: m.nav_notifications() })).toHaveAttribute(
      "href",
      "/notifications",
    );
    expect(screen.queryByText(/unread/i)).not.toBeInTheDocument();
  });
});
