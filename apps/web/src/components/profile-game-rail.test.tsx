import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient } from "@/test/factories";
import { renderWithProviders } from "@/test/render";
import { ProfileGameRail } from "@/components/profile-game-rail";
import { gameFavoritesQueryOptions } from "@/lib/query-definitions";
import type { FavoriteRailItem } from "@/lib/orpc";
import { m } from "@/paraglide/messages.js";

// The rail is one read surface with two placements (the parent renders it
// twice — mobile strip and desktop column). This file pins its own wiring:
// covers render and link to their game pages, and an empty showcase renders
// nothing at all — no heading over a hole.
function railItem(overrides: Partial<FavoriteRailItem> & { slug: string }): FavoriteRailItem {
  return {
    name: `Game ${overrides.slug}`,
    coverMediaPath: null,
    firstReleaseYear: 2020,
    ...overrides,
  };
}

describe("ProfileGameRail", () => {
  it("renders the profile's favorited games as links to their pages", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(gameFavoritesQueryOptions("alice").queryKey, {
      items: [railItem({ slug: "hades", name: "Hades" }), railItem({ slug: "doom", name: "DOOM" })],
    });

    await renderWithProviders(<ProfileGameRail username="alice" />, {
      queryClient,
      signedInAs: true,
    });

    expect(screen.getByRole("heading", { name: m.profile_favorite_games() })).toBeInTheDocument();
    const hades = screen.getByRole("link", { name: "Hades" });
    expect(hades).toHaveAttribute("href", "/games/hades");
    expect(screen.getByRole("link", { name: "DOOM" })).toHaveAttribute("href", "/games/doom");
  });

  it("renders nothing when the profile has no favorites — pending, error or empty", async () => {
    const empty = createTestQueryClient();
    empty.setQueryData(gameFavoritesQueryOptions("alice").queryKey, { items: [] });
    await renderWithProviders(<ProfileGameRail username="alice" />, {
      queryClient: empty,
      signedInAs: true,
    });
    expect(
      screen.queryByRole("region", { name: m.profile_favorite_games() }),
    ).not.toBeInTheDocument();

    const never = createTestQueryClient();
    await renderWithProviders(<ProfileGameRail username="bob" />, {
      queryClient: never,
      signedInAs: true,
    });
    expect(
      screen.queryByRole("region", { name: m.profile_favorite_games() }),
    ).not.toBeInTheDocument();
  });
});
