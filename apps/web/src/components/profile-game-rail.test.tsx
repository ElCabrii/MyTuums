import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTestQueryClient } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import { ProfileGameRail } from "@/components/profile-game-rail";
import { gameFavoritesQueryOptions } from "@/lib/query-definitions";
import { m } from "@/paraglide/messages.js";

describe("ProfileGameRail", () => {
  it("shows six favorites and opens the complete loaded list with real game links", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(gameFavoritesQueryOptions("alice").queryKey, {
      pages: [
        {
          items: Array.from({ length: 8 }, (_, i) => ({
            slug: `game-${i}`,
            name: `Game ${i}`,
            coverMediaPath: null,
            firstReleaseYear: 2020,
          })),
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });
    await renderWithProviders(<ProfileGameRail username="alice" />, {
      queryClient,
      signedInAs: true,
    });
    const preview = screen.getByRole("region", { name: m.profile_favorite_games() });
    expect(within(preview).getAllByRole("link")).toHaveLength(6);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: m.profile_favorites_see_more() });
    await user.click(trigger);
    const popover = await screen.findByRole("dialog", { name: m.profile_favorite_games() });
    expect(within(popover).getAllByRole("link")).toHaveLength(8);
    expect(within(popover).getByRole("link", { name: "Game 7" })).toHaveAttribute(
      "href",
      "/games/game-7",
    );
    await user.keyboard("{Escape}");
    expect(
      await screen.findByRole("button", { name: m.profile_favorites_see_more() }),
    ).toHaveFocus();
  });

  it("offers the owner a Games link only after an empty favorites response", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(gameFavoritesQueryOptions("alice").queryKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [undefined],
    });
    await renderWithProviders(<ProfileGameRail username="alice" isOwnProfile />, {
      queryClient,
      signedInAs: true,
    });
    expect(screen.getByText(m.profile_favorites_empty_own())).toBeInTheDocument();
    expect(screen.getByRole("link", { name: m.profile_favorites_browse() })).toHaveAttribute(
      "href",
      "/games",
    );
    expect(
      screen.queryByRole("button", { name: m.profile_favorites_see_more() }),
    ).not.toBeInTheDocument();
  });

  it("does not mistake pending favorites for an empty showcase", async () => {
    await renderWithProviders(<ProfileGameRail username="bob" isOwnProfile />, {
      queryClient: createTestQueryClient(),
      signedInAs: true,
    });
    expect(
      screen.queryByRole("region", { name: m.profile_favorite_games() }),
    ).not.toBeInTheDocument();
  });
});
