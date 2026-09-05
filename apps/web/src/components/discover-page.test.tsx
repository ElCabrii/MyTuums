import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, makeGameCard, makePost } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { DiscoverPage } from "@/components/discover-page";
import { m } from "@/paraglide/messages.js";

// The four-state skeleton is PaginatedState's, owned by
// paginated-state.test.tsx; the feed atom family is owned by
// atoms/post-feed.test.ts. This file proves only the page's wiring: the
// global feed renders through the shared chrome, the empty state carries
// Discover's own copy, the search box and game filter narrow the feed through
// URL-persisted params, and the page stays a reading surface — no composer,
// no scope tabs.
describe("DiscoverPage", () => {
  it("renders the global feed's posts with a Load-more control while a next page exists", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([
      {
        items: [makePost({ content: "A community post" })],
        nextCursor: "cursor-1",
        gameMentions: {},
      },
    ]);

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByText("A community post")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeEnabled();
  });

  it("renders Discover's empty state when the feed has no posts", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }]);

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByRole("heading", { name: m.nav_discover() })).toBeInTheDocument();
    expect(screen.getByText(m.discover_empty())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });

  it("is a reading surface — no composer, no scope tabs", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }]);

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.feed_for_you() })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.feed_following() })).not.toBeInTheDocument();
  });

  it("renders the search box and game filter controls", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }]);

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByRole("searchbox", { name: m.discover_search_aria() })).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: m.discover_game_filter_aria() }),
    ).toBeInTheDocument();
  });

  it("renders the filtered empty state and a clear-filters control when the URL carries filters", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }], {
      feed: "global",
      q: "zelda",
    });

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover?q=zelda",
    });

    expect(screen.getByText(m.discover_filtered_empty())).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.discover_clear_filters() })).toBeInTheDocument();
  });

  it("renders the active game chip when the URL carries a game filter", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }], {
      feed: "global",
      gameSlug: "hades",
    });
    queryFixtures(queryClient).game.page("hades", {
      slug: "hades",
      name: "Hades",
      summary: null,
      coverMediaPath: null,
      firstReleaseYear: 2020,
      firstReleaseDate: 1577836800,
      hypeCount: 0,
      genres: [],
      platforms: [],
      favoriteCount: 3,
      viewerHasFavoritedGame: false,
    });
    // The picker reads the directory listing; seed it so the chip path never
    // falls through to a network fetch.
    queryFixtures(queryClient).game.list({ sort: "popularity", q: "had" }, [
      {
        items: [makeGameCard({ igdbId: 1, slug: "hades", name: "Hades", firstReleaseYear: 2020 })],
        nextCursor: null,
      },
    ]);

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover?game=hades",
    });

    expect(screen.getByText(m.discover_game_chip({ name: "Hades" }))).toBeInTheDocument();
    expect(screen.getByText(m.discover_filtered_empty())).toBeInTheDocument();
  });
});
