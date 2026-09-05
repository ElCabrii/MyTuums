import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, makePost } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { DiscoverPage } from "@/components/discover-page";
import { m } from "@/paraglide/messages.js";

// The four-state skeleton is PaginatedState's, owned by
// paginated-state.test.tsx; the feed atom family is owned by
// atoms/post-feed.test.ts. This file proves only the page's wiring: the
// global feed renders through the shared chrome, the empty state carries
// Discover's own copy, and the page stays a reading surface — no composer,
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

    await renderWithProviders(<DiscoverPage />, { queryClient, signedInAs: true });

    expect(screen.getByText("A community post")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeEnabled();
  });

  it("renders Discover's empty state when the feed has no posts", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }]);

    await renderWithProviders(<DiscoverPage />, { queryClient, signedInAs: true });

    expect(screen.getByRole("heading", { name: m.nav_discover() })).toBeInTheDocument();
    expect(screen.getByText(m.discover_empty())).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });

  it("is a reading surface — no composer, no scope tabs", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null, gameMentions: {} }]);

    await renderWithProviders(<DiscoverPage />, { queryClient, signedInAs: true });

    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.feed_for_you() })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: m.feed_following() })).not.toBeInTheDocument();
  });
});
