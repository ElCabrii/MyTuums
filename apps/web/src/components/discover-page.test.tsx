import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  createTestQueryClient,
  makeGameCard,
  makePost,
  makePostListPage,
  makeRanking,
  makeRankSuggestion,
} from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { DiscoverPage } from "@/components/discover-page";
import { m } from "@/paraglide/messages.js";

// The four-state skeleton is PaginatedState's, owned by
// paginated-state.test.tsx; the feed atom family is owned by
// atoms/post-feed.test.ts. This file proves only the page's wiring: the
// ranked Discover feed renders through the shared chrome, the empty state
// carries Discover's own copy, the search box and game filter narrow the
// feed through URL-persisted params, Who-to-Follow reads the feed's own
// metadata, and the page stays a reading surface — no composer, no scope
// tabs, no ranking toggle.
describe("DiscoverPage", () => {
  it("renders the ranked feed's posts with a Load-more control while a next page exists", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [
        makePostListPage({
          items: [makePost({ content: "A community post" })],
          nextCursor: "cursor-1",
          ranking: makeRanking({ suggestions: [] }),
        }),
      ],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByText("A community post")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeEnabled();
    expect(screen.getByRole("button", { name: m.feed_refresh() })).toBeInTheDocument();
  });

  it("renders Discover's empty state when the feed has no posts", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByRole("heading", { name: m.nav_discover() })).toBeInTheDocument();
    expect(screen.getByText(m.discover_empty())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });

  it("is a reading surface — no composer, no scope tabs, no ranking toggle", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.feed_for_you() })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.feed_following() })).not.toBeInTheDocument();
  });

  it("opens game filtering from a Filters button and restores focus on dismissal", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByRole("searchbox", { name: m.discover_search_aria() })).toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: m.discover_game_filter_aria() }),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    const filters = screen.getByRole("button", { name: m.discover_filters() });
    await user.click(filters);
    expect(
      await screen.findByRole("searchbox", { name: m.discover_game_filter_aria() }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(filters).toHaveFocus();
  });

  it("renders the filtered empty state and a clear-filters control when the URL carries filters", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      {
        feed: "discover",
        ranked: true,
        q: "zelda",
      },
    );

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
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      {
        feed: "discover",
        ranked: true,
        gameSlug: "hades",
      },
    );
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

  it("renders Who-to-Follow above the posts from the feed's own ranking metadata", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [
        makePostListPage({
          items: [makePost({ content: "A community post" })],
          nextCursor: null,
          ranking: makeRanking({
            suggestions: [
              makeRankSuggestion({ id: "user-1", username: "jamierivera", name: "Jamie Rivera" }),
              makeRankSuggestion({ id: "user-2", username: "samkim", name: "Sam Kim" }),
              makeRankSuggestion({ id: "user-3", username: "taylorw", name: "Taylor Wu" }),
              makeRankSuggestion({ id: "user-4", username: "fourth", name: "Fourth Person" }),
            ],
          }),
        }),
      ],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByRole("heading", { name: m.who_to_follow_title() })).toBeInTheDocument();
    expect(screen.getByText("Jamie Rivera")).toBeInTheDocument();
    expect(screen.getByText("Sam Kim")).toBeInTheDocument();
    expect(screen.getByText("Taylor Wu")).toBeInTheDocument();
    // Top three only — the fourth candidate waits for the next snapshot.
    expect(screen.queryByText("Fourth Person")).not.toBeInTheDocument();
    // The posts still render below the module, in feed order.
    expect(screen.getByText("A community post")).toBeInTheDocument();
  });

  it("hides already-followed and requested candidates without shuffling the feed", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [
        makePostListPage({
          items: [makePost({ content: "A community post" })],
          nextCursor: null,
          ranking: makeRanking({
            suggestions: [
              makeRankSuggestion({ id: "user-1", username: "followed", name: "Followed Person" }),
              makeRankSuggestion({
                id: "user-2",
                username: "following",
                name: "Following Person",
                viewerIsFollowing: true,
              }),
              makeRankSuggestion({
                id: "user-3",
                username: "requested",
                name: "Requested Person",
                hasRequested: true,
              }),
            ],
          }),
        }),
      ],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByText("Followed Person")).toBeInTheDocument();
    expect(screen.queryByText("Following Person")).not.toBeInTheDocument();
    expect(screen.queryByText("Requested Person")).not.toBeInTheDocument();
    expect(screen.getByText("A community post")).toBeInTheDocument();
  });

  it("prompts for favorite games on a cold start, without blocking the feed", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [
        makePostListPage({
          items: [makePost({ content: "A community post" })],
          nextCursor: null,
          ranking: makeRanking({ hasInterests: false, suggestions: [] }),
        }),
      ],
      { feed: "discover", ranked: true },
    );

    await renderWithProviders(<DiscoverPage />, {
      queryClient,
      signedInAs: true,
      initialPath: "/discover",
    });

    expect(screen.getByText(m.who_to_follow_games_prompt())).toBeInTheDocument();
    expect(screen.getByRole("link", { name: m.who_to_follow_games_link() })).toHaveAttribute(
      "href",
      "/games",
    );
    expect(screen.getByText("A community post")).toBeInTheDocument();
  });
});
