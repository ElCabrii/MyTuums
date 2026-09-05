import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, makeGamePageData } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { GamePage } from "@/components/game-page";
import { gameQueryOptions } from "@/lib/query-definitions";
import { m } from "@/paraglide/messages.js";

// The page is a straight read surface: this file pins that the payload
// renders as the issue's field list (Q22) and that a slug that is not there
// degrades to the not-found card rather than an error dump. The spinner and
// document-head behaviors are owned by their own modules.
describe("GamePage", () => {
  it("renders the game's data: name, year, summary, genres, platforms, favorites count", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).game.page(
      "hades",
      makeGamePageData({
        name: "Hades",
        firstReleaseYear: 2020,
        genres: ["Roguelike", "Action RPG"],
        platforms: ["PC", "Switch"],
        favoriteCount: 12,
      }),
    );

    await renderWithProviders(<GamePage slug="hades" />, { queryClient, signedInAs: true });

    expect(screen.getByRole("heading", { name: "Hades" })).toBeInTheDocument();
    expect(screen.getByText(m.game_released_in({ year: 2020 }))).toBeInTheDocument();
    expect(screen.getByText(m.game_favorite_count({ count: 12 }))).toBeInTheDocument();
    expect(screen.getByText("Zagreus fights his way out of the Underworld.")).toBeInTheDocument();
    for (const label of ["Roguelike", "Action RPG", "PC", "Switch"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("renders the not-found card for a slug the catalog does not know", async () => {
    const queryClient = createTestQueryClient();
    // Seed the cache with a failed read — the atom observes the error state
    // the same way it would a NOT_FOUND response.
    await queryClient
      .fetchQuery({
        ...gameQueryOptions("no-such-game"),
        queryFn: () => Promise.reject(new Error("404")),
      })
      .catch(() => {});

    await renderWithProviders(<GamePage slug="no-such-game" />, { queryClient, signedInAs: true });

    expect(screen.getByText(m.game_not_found())).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hades" })).not.toBeInTheDocument();
  });
});
