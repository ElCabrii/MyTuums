import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createTestQueryClient, makePost } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { PostFeed } from "@/components/post-feed";
import { postFeedAtom } from "@/atoms/post-feed";

// The pending / error / empty / Load-more branches are PaginatedState's, owned
// by paginated-state.test.tsx — this file only proves PostFeed's own wiring:
// that its atom's pages reach PostCard, one card per loaded post. (The
// parameterised atom family itself is owned by atoms/post-feed.test.ts.)
const globalFeed = () => postFeedAtom({ feed: "global" });

describe("PostFeed", () => {
  it("renders one card per post across every page already loaded", async () => {
    const queryClient = createTestQueryClient();
    const first = makePost({ content: "First post" });
    const second = makePost({ content: "Second post" });
    queryFixtures(queryClient).postList.data([
      { items: [first], nextCursor: "cursor-1", gameMentions: {} },
      { items: [second], nextCursor: null, gameMentions: {} },
    ]);

    await renderWithProviders(
      <PostFeed feedAtom={globalFeed()} emptyMessage="Nothing here yet." />,
      {
        queryClient,
      },
    );

    expect(screen.getByText("First post")).toBeInTheDocument();
    expect(screen.getByText("Second post")).toBeInTheDocument();
  });
});
