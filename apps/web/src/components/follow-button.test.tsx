import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { atom } from "jotai";
import { renderWithProviders } from "@/test/render";
import { FollowButton } from "@/components/follow-button";
import { m } from "@/paraglide/messages.js";

// Write-only, same pattern as post-card.test.tsx's mock of @/atoms/like —
// lets these tests assert "the button asked to toggle this exact user"
// without exercising the real mutation's network round trip.
const toggleFollowSpy = vi.fn();
vi.mock("@/atoms/follow", () => ({
  toggleFollowAtomFamily: (userId: string) =>
    atom(null, () => {
      toggleFollowSpy(userId);
    }),
}));

describe("FollowButton", () => {
  beforeEach(() => {
    toggleFollowSpy.mockClear();
  });

  it("renders a link to /login when signed out", async () => {
    await renderWithProviders(<FollowButton userId="user-1" isFollowing={false} />, {
      signedInAs: false,
    });

    // Base UI applies button semantics to whatever it renders, so this
    // reports role="button" even though the underlying element is an <a>.
    const control = screen.getByRole("button", { name: m.follow_action() });
    expect(control).toHaveAttribute("href", "/login");
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

    expect(toggleFollowSpy).toHaveBeenCalledWith("user-2");
    // Deliberate: the optimistic flip on click IS the feedback, so nothing
    // here disables the control for the round trip — that would block a
    // fast undo. Do not "fix" this by adding a pending/disabled state.
    expect(button).not.toBeDisabled();
  });

  it("labels the following state as Unfollow (via aria-label) and invokes the toggle on click", async () => {
    await renderWithProviders(<FollowButton userId="user-3" isFollowing={true} />, {
      signedInAs: { id: "viewer-1", name: "Viewer" },
    });

    const button = screen.getByRole("button", { name: m.follow_unfollow() });
    expect(button).toHaveAttribute("aria-pressed", "true");

    const user = userEvent.setup();
    await user.click(button);

    expect(toggleFollowSpy).toHaveBeenCalledWith("user-3");
    expect(button).not.toBeDisabled();
  });
});
