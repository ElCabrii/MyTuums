import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { ProfileLink } from "@/components/profile-link";
import { createTestQueryClient, makeProfile } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
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

  it("renders bio URLs and mentions as links without slicing long tokens", async () => {
    const queryClient = renderQueryClient();
    const filler = "x".repeat(130);
    queryFixtures(queryClient).profile.data(
      "linker",
      makeProfile({
        id: "person-3",
        username: "linker",
        name: "Link User",
        bio: `Find me at https://example.com or @jamierivera ${filler} https://example.com/very/long/path`,
      }),
    );

    await renderWithProviders(<ProfileLink username="linker">Link User</ProfileLink>, {
      queryClient,
      signedInAs: true,
    });
    vi.useFakeTimers();

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Link User" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    const external = screen.getByRole("link", { name: "https://example.com" });
    expect(external).toHaveAttribute("href", "https://example.com/");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    expect(screen.getByRole("link", { name: "@jamierivera" })).toHaveAttribute(
      "href",
      "/@jamierivera",
    );

    const bioParagraph = screen.getByText("Find me at", { exact: false });
    expect(bioParagraph).toHaveClass("line-clamp-3");
    // Nothing is string-sliced, so a URL beyond the old snippet budget
    // survives whole instead of ending as a dead partial link.
    expect(bioParagraph).toHaveTextContent("https://example.com/very/long/path");

    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("Find me at", { exact: false })).not.toBeInTheDocument();
  });

  it("renders no bio line when the profile has no bio", async () => {
    const queryClient = renderQueryClient();
    queryFixtures(queryClient).profile.data(
      "biolist",
      makeProfile({ id: "person-4", username: "biolist", name: "No Bio", followerCount: 5 }),
    );

    await renderWithProviders(<ProfileLink username="biolist">No Bio</ProfileLink>, {
      queryClient,
      signedInAs: true,
    });
    vi.useFakeTimers();

    fireEvent.mouseEnter(screen.getByRole("link", { name: "No Bio" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // The card still loads — follower count and follow button render — but the
    // bio line is omitted entirely rather than showing a "no bio" placeholder.
    expect(screen.getByText(m.profile_hover_follower_many({ count: "5" }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.follow_action() })).toBeInTheDocument();
    expect(document.querySelector(".line-clamp-3")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
  });

  it("renders the profile's badges beside the name in the hover card", async () => {
    const queryClient = renderQueryClient();
    queryFixtures(queryClient).profile.data(
      "badged",
      makeProfile({
        id: "person-5",
        username: "badged",
        name: "Badged User",
        badges: ["trendy", "founder", "early_access"],
      }),
    );

    await renderWithProviders(<ProfileLink username="badged">Badged User</ProfileLink>, {
      queryClient,
      signedInAs: true,
    });
    vi.useFakeTimers();

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Badged User" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    // The same badge row the profile header renders, in the API's order.
    const card = screen.getByRole("list", { name: m.profile_badges_label() });
    expect(card.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByTitle(m.badge_trendy())).toBeInTheDocument();
    expect(screen.getByTitle(m.badge_founder())).toBeInTheDocument();
    expect(screen.getByTitle(m.badge_early_access())).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(300);
    });
  });

  it("renders only the suspension stub for a suspended profile", async () => {
    const queryClient = renderQueryClient();
    queryFixtures(queryClient).profile.data(
      "suspended",
      makeProfile({
        id: "suspended-1",
        username: "suspended",
        name: "Private display name",
        bio: "Private suspended bio",
        image: "/media/avatars/suspended/private.webp",
        followerCount: 99,
        suspended: true,
        // The server redacts badges on the stub along with every authored
        // field (issue #308); the fixture keeps one so the assertion pins the
        // card's behaviour, not the fixture's emptiness.
        badges: ["founder"],
      }),
    );

    await renderWithProviders(<ProfileLink username="suspended">Suspended profile</ProfileLink>, {
      queryClient,
      signedInAs: true,
    });
    vi.useFakeTimers();

    fireEvent.mouseEnter(screen.getByRole("link", { name: "Suspended profile" }));
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText(m.profile_suspended_body())).toBeInTheDocument();
    expect(screen.queryByText("Private suspended bio")).not.toBeInTheDocument();
    expect(
      screen.queryByText(m.profile_hover_follower_many({ count: "99" })),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Private display name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.follow_action() })).not.toBeInTheDocument();
    expect(screen.queryByTitle(m.badge_founder())).not.toBeInTheDocument();
  });
});

function renderQueryClient(): QueryClient {
  // Keep this helper local so the tests' query fixture and the render harness
  // always share one explicit client, matching the production store wiring.
  return createTestQueryClient();
}
