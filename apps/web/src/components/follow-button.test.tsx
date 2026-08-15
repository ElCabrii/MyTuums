import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { QueryClient } from "@tanstack/react-query";
import { queryClientAtom } from "jotai-tanstack-query";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { renderWithProviders } from "@/test/render";
import { installTestOrpc, orpc } from "@/lib/orpc";
import { FollowButton } from "@/components/follow-button";
import { m } from "@/paraglide/messages.js";

// The button talks to `toggleFollowAtomFamily`, a write-only atom: the real
// atom runs against this fake client, so the test asserts "the button asked
// the transport to toggle this exact user" without a jsdom-hostile network
// round trip.
const fakeClient = {
  user: {
    follow: vi.fn(() => Promise.resolve({ userId: "", followerCount: 0, viewerIsFollowing: true })),
    unfollow: vi.fn(() =>
      Promise.resolve({ userId: "", followerCount: 0, viewerIsFollowing: false }),
    ),
    byUsername: vi.fn(),
    followers: vi.fn(),
    following: vi.fn(),
  },
  search: { users: vi.fn() },
  post: { list: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

describe("FollowButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing on the viewer's own row", async () => {
    await renderWithProviders(<FollowButton userId="self-1" isFollowing={false} />, {
      signedInAs: { id: "self-1", name: "Me" },
    });

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("labels the not-following state as Follow and invokes the toggle on click", async () => {
    await renderWithProviders(<FollowButton userId="user-2" isFollowing={false} />, {
      signedInAs: { id: "viewer-1", name: "Viewer" },
    });

    const button = screen.getByRole("button", { name: m.follow_action() });
    expect(button).toHaveAttribute("aria-pressed", "false");

    const user = userEvent.setup();
    await user.click(button);

    await waitFor(() =>
      expect(fakeClient.user.follow).toHaveBeenCalledWith({ userId: "user-2" }, expect.anything()),
    );
    // Deliberate: the optimistic flip on click IS the feedback, so nothing
    // here disables the control for the round trip — that would block a
    // fast undo. Do not "fix" this by adding a pending/disabled state.
    expect(button).not.toBeDisabled();
  });

  it("labels the following state as Unfollow (via aria-label) and invokes the toggle on click", async () => {
    // The atom reads the current follow state from the cache, not the prop —
    // seed a profile that says "already following" so the toggle resolves to
    // unfollow, matching what the label claims.
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      orpc.user.byUsername.key({ input: { username: "user-3" } }),
      // SAFETY: the follow atom only reads id + viewerIsFollowing off the
      // cached profile; the rest of the shape is irrelevant to this test.
      {
        id: "user-3",
        username: "user-3",
        displayUsername: "user-3",
        name: "User Three",
        viewerIsFollowing: true,
        followerCount: 0,
      },
    );
    const store = createStore();
    store.set(queryClientAtom, queryClient);

    await renderWithProviders(<FollowButton userId="user-3" isFollowing={true} />, {
      store,
      queryClient,
      signedInAs: { id: "viewer-1", name: "Viewer" },
    });

    const button = screen.getByRole("button", { name: m.follow_unfollow() });
    expect(button).toHaveAttribute("aria-pressed", "true");

    const user = userEvent.setup();
    await user.click(button);

    await waitFor(() =>
      expect(fakeClient.user.unfollow).toHaveBeenCalledWith(
        { userId: "user-3" },
        expect.anything(),
      ),
    );
  });
});
