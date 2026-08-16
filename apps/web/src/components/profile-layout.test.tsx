import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { ORPCError } from "@orpc/client";
import { blockDialogAtom, reportDialogAtom } from "@/atoms/moderation";
import {
  createTestQueryClient,
  makeProfile,
  queryFixtures,
  renderWithProviders,
} from "@/test/render";
import { ProfileLayout } from "@/components/profile-layout";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  user: {
    byUsername: vi.fn(),
    follow: vi.fn(),
    unfollow: vi.fn(),
  },
  moderation: { unbanUser: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProfileLayout query states", () => {
  it("renders only the loading shell while the profile is pending", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.loading("pending");

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@pending",
      signedInAs: true,
    });

    expect(screen.queryByRole("heading", { name: "@pending" })).not.toBeInTheDocument();
    expect(fakeClient.user.byUsername).not.toHaveBeenCalled();
  });

  it("renders the not-found stub for a missing handle", async () => {
    const queryClient = createTestQueryClient();
    await queryFixtures(queryClient).profile.error("missing", new ORPCError("NOT_FOUND"));

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@missing",
      signedInAs: true,
    });

    expect(screen.getByRole("heading", { name: "@missing" })).toBeInTheDocument();
    expect(screen.getByText(m.profile_not_found())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.common_try_again() })).not.toBeInTheDocument();
  });

  it("retries a transient error and replaces the error card with the profile", async () => {
    const recovered = makeProfile({
      name: "Recovered",
      username: "recovered",
      displayUsername: "Recovered",
    });
    fakeClient.user.byUsername.mockResolvedValue(recovered);
    const queryClient = createTestQueryClient();
    await queryFixtures(queryClient).profile.error("recovered", new Error("temporary failure"));
    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@recovered",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.common_try_again() }));

    expect(await screen.findByRole("heading", { name: "Recovered" })).toBeInTheDocument();
    await waitFor(() =>
      expect(fakeClient.user.byUsername).toHaveBeenCalledWith(
        { username: "recovered" },
        expect.anything(),
      ),
    );
  });
});

describe("ProfileLayout role and ownership gates", () => {
  it("shows a suspended stub but no unban action to a plain user", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data(
      "suspended",
      makeProfile({ username: "suspended", displayUsername: "Suspended", suspended: true }),
    );

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@suspended",
      signedInAs: { role: "user" },
    });

    expect(screen.getByText(m.profile_suspended_body())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.moderation_unban() })).not.toBeInTheDocument();
  });

  it("lets staff unban a suspended profile", async () => {
    const suspended = makeProfile({
      id: "suspended-1",
      username: "suspended",
      displayUsername: "Suspended",
      suspended: true,
    });
    const recovered = makeProfile({ ...suspended, suspended: false });
    fakeClient.moderation.unbanUser.mockResolvedValue({ userId: suspended.id, unbanned: true });
    fakeClient.user.byUsername.mockResolvedValue(recovered);
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("suspended", suspended);
    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@suspended",
      signedInAs: { role: "staff" },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.moderation_unban() }));

    await waitFor(() =>
      expect(fakeClient.moderation.unbanUser).toHaveBeenCalledWith(
        { userId: suspended.id },
        expect.anything(),
      ),
    );
  });

  it("shows settings, sign-out and private email only on the viewer's own profile", async () => {
    const own = makeProfile({ id: "viewer-1", username: "alex", displayUsername: "Alex" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("alex", own);

    await renderWithProviders(<ProfileLayout />, {
      queryClient,
      initialPath: "/@alex",
      signedInAs: { id: own.id, username: "alex", email: "owner@example.com" },
    });

    expect(screen.getByRole("button", { name: m.profile_settings() })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.auth_sign_out() })).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText(m.moderation_kebab())).not.toBeInTheDocument();
  });

  it("shows follow, report and block controls for another profile", async () => {
    const other = makeProfile({ id: "other-1", username: "other", displayUsername: "Other" });
    const store = createStore();
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("other", other);
    await renderWithProviders(<ProfileLayout />, {
      store,
      queryClient,
      initialPath: "/@other",
      signedInAs: { id: "viewer-1" },
    });
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: m.follow_action() })).toBeInTheDocument();
    await user.click(screen.getByLabelText(m.moderation_kebab()));
    await user.click(
      await screen.findByRole("menuitem", { name: m.moderation_kebab_report_author() }),
    );
    expect(store.get(reportDialogAtom)).toEqual({ targetType: "user", targetId: other.id });

    await user.click(screen.getByLabelText(m.moderation_kebab()));
    await user.click(await screen.findByRole("menuitem", { name: m.moderation_kebab_block() }));
    expect(store.get(blockDialogAtom)).toEqual({ userId: other.id, handle: "Other" });
  });
});
