import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { ProfileLink } from "@/components/profile-link";
import {
  createTestQueryClient,
  makeProfile,
  queryFixtures,
  renderWithProviders,
} from "@/test/render";
import { m } from "@/paraglide/messages.js";
import { profileQueryOptions } from "@/lib/query-definitions";

afterEach(() => {
  vi.useRealTimers();
});

describe("ProfileLink", () => {
  it("keeps a recently previewed profile fresh across repeated hovers", () => {
    expect(profileQueryOptions("jamierivera").staleTime).toBe(60_000);
  });

  it("opens a cached profile card on hover and dismisses it with Escape", async () => {
    const queryClient = renderQueryClient();
    const profile = makeProfile({
      id: "person-1",
      username: "jamierivera",
      name: "Jamie Rivera",
      bio: "A short bio for the profile card.",
      followerCount: 12,
    });
    queryFixtures(queryClient).profile.data("jamierivera", profile);

    await renderWithProviders(<ProfileLink username="jamierivera">Jamie Rivera</ProfileLink>, {
      queryClient,
      signedInAs: true,
    });
    vi.useFakeTimers();

    const trigger = screen.getByRole("link", { name: "Jamie Rivera" });
    expect(trigger).toHaveAttribute("href", "/@jamierivera");

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText("A short bio for the profile card.")).toBeInTheDocument();
    expect(screen.getByText(m.profile_hover_follower_many({ count: "12" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.follow_action() })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("A short bio for the profile card.")).not.toBeInTheDocument();
  });

  it("opens on keyboard focus without replacing the navigable link", async () => {
    const queryClient = renderQueryClient();
    queryFixtures(queryClient).profile.data(
      "keyboarduser",
      makeProfile({ id: "person-2", username: "keyboarduser", name: "Keyboard User" }),
    );

    await renderWithProviders(<ProfileLink username="keyboarduser">Keyboard User</ProfileLink>, {
      queryClient,
      signedInAs: true,
    });
    vi.useFakeTimers();
    const trigger = screen.getByRole("link", { name: "Keyboard User" });
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText("@keyboarduser")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("href", "/@keyboarduser");

    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("@keyboarduser")).not.toBeInTheDocument();
  });
});

function renderQueryClient(): QueryClient {
  // Keep this helper local so the tests' query fixture and the render harness
  // always share one explicit client, matching the production store wiring.
  return createTestQueryClient();
}
