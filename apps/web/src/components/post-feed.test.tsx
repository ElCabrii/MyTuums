import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import {
  createTestQueryClient,
  makePost,
  postListQueryKey,
  renderWithProviders,
  seedInfiniteError,
  seedInfiniteLoading,
  seedPostListPages,
} from "@/test/render";
import { PostFeed } from "@/components/post-feed";
import { postFeedAtom } from "@/atoms/post-feed";
import { m } from "@/paraglide/messages.js";

// `postFeedAtom({ feed: "global" })` is the only shape exercised here — the
// atom family's parameterisation (scope/author) is covered wherever that
// atom itself is tested; PostFeed only cares about the query states its
// prop can be in.
const globalFeed = () => postFeedAtom({ feed: "global" });

describe("PostFeed", () => {
  it("shows a loading spinner while the feed is pending", async () => {
    const queryClient = createTestQueryClient();
    seedInfiniteLoading(queryClient, postListQueryKey());

    const { container } = await renderWithProviders(
      <PostFeed feedAtom={globalFeed()} emptyMessage="Nothing here yet." />,
      { queryClient },
    );

    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a retryable error when the feed fails to load", async () => {
    const queryClient = createTestQueryClient();
    await seedInfiniteError(queryClient, postListQueryKey(), "Could not load posts.");

    await renderWithProviders(
      <PostFeed feedAtom={globalFeed()} emptyMessage="Nothing here yet." />,
      {
        queryClient,
      },
    );

    // `findByRole`, not `getByRole`: `atomWithInfiniteQuery`'s value only
    // reflects the query observer's CURRENT result once its subscription has
    // been set up post-mount, one render pass after the one `render()`
    // itself flushes — a synchronous `getByRole` right after render was
    // still occasionally catching that first, pending-state render, even
    // with the cache already seeded to "error" before mount. `findByRole`
    // polls until the DOM actually shows it.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load posts.");
    expect(screen.getByRole("button", { name: m.common_try_again() })).toBeInTheDocument();
  });

  it("shows the empty message and action when there are no posts", async () => {
    const queryClient = createTestQueryClient();
    seedPostListPages(queryClient, [{ items: [], nextCursor: null }]);

    await renderWithProviders(
      <PostFeed
        feedAtom={globalFeed()}
        emptyMessage="Nothing here yet."
        emptyAction={<button type="button">Find people to follow</button>}
      />,
      { queryClient },
    );

    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find people to follow" })).toBeInTheDocument();
  });

  it("renders one card per post across every page already loaded", async () => {
    const queryClient = createTestQueryClient();
    const first = makePost({ content: "First post" });
    const second = makePost({ content: "Second post" });
    seedPostListPages(queryClient, [
      { items: [first], nextCursor: "cursor-1" },
      { items: [second], nextCursor: null },
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

  it("shows Load more only when there is a next page", async () => {
    const withNextPage = createTestQueryClient();
    seedPostListPages(withNextPage, [{ items: [makePost()], nextCursor: "cursor-1" }]);
    const more = await renderWithProviders(
      <PostFeed feedAtom={globalFeed()} emptyMessage="Nothing here yet." />,
      {
        queryClient: withNextPage,
      },
    );
    expect(screen.getByRole("button", { name: m.common_load_more() })).toBeInTheDocument();
    more.unmount();

    const withoutNextPage = createTestQueryClient();
    seedPostListPages(withoutNextPage, [{ items: [makePost()], nextCursor: null }]);
    await renderWithProviders(
      <PostFeed feedAtom={globalFeed()} emptyMessage="Nothing here yet." />,
      {
        queryClient: withoutNextPage,
      },
    );
    expect(screen.queryByRole("button", { name: m.common_load_more() })).not.toBeInTheDocument();
  });
});
