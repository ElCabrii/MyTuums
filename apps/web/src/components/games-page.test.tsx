import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, makeGameCard } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { GamesPage } from "@/components/games-page";
import { m } from "@/paraglide/messages.js";

// The four-state skeleton is PaginatedState's, owned by
// paginated-state.test.tsx. This file proves only the directory page's own
// wiring: the grid renders cover cards that link to `/games/$slug`, and the
// empty catalog carries the directory's copy.
describe("GamesPage", () => {
  it("renders the catalog as cover cards linking to each game's page", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).game.list({ sort: "popularity" }, [
      {
        items: [
          makeGameCard({ igdbId: 1, slug: "hades", name: "Hades", firstReleaseYear: 2020 }),
          makeGameCard({ igdbId: 2, slug: "doom", name: "DOOM", firstReleaseYear: null }),
        ],
        nextCursor: "cursor-1",
      },
    ]);

    const { router } = await renderWithProviders(<GamesPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/games",
    });

    expect(screen.getByText("Hades")).toBeInTheDocument();
    expect(screen.getByText("2020")).toBeInTheDocument();
    // A null year renders nothing — the card is name-only, not "null".
    expect(screen.queryByText("null")).not.toBeInTheDocument();

    const hadesCard = screen.getByText("Hades").closest("a");
    expect(hadesCard).toHaveAttribute("href", "/games/hades");
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeEnabled();

    // Navigating a card reaches the game route's stub.
    hadesCard?.click();
    expect(router.state.location.pathname).toBe("/games/hades");
  });

  it("renders the empty-catalog state when the directory has no games", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).game.list({ sort: "popularity" }, [{ items: [], nextCursor: null }]);

    await renderWithProviders(<GamesPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/games",
    });

    expect(screen.getByRole("heading", { name: m.games_title() })).toBeInTheDocument();
    expect(screen.getByText(m.games_empty())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });
});
