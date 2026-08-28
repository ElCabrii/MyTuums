import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { feedScopeAtom } from "@/lib/feed-scope";
import { createTestQueryClient } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { HomePage } from "@/components/home-page";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = { post: { list: vi.fn(), create: vi.fn() } };

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HomePage", () => {
  it("keeps the feed unmounted while the session scope is unresolved", async () => {
    await renderWithProviders(<HomePage />, { sessionPending: true });

    expect(screen.getByRole("heading", { name: m.feed_title() })).toBeInTheDocument();
    expect(screen.queryByText(m.feed_empty())).not.toBeInTheDocument();
    expect(screen.queryByText(m.feed_empty_following())).not.toBeInTheDocument();
    await waitFor(() => expect(fakeClient.post.list).not.toHaveBeenCalled());
  });

  it("renders the global empty state without the Discover action", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }]);

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByRole("button", { name: m.feed_for_you() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(m.feed_empty())).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: m.feed_find_people() })).not.toBeInTheDocument();
  });

  it("switches to Following, persists the scope, and exposes the Discover action", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }]);
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      feed: "following",
    });
    const { router } = await renderWithProviders(<HomePage />, {
      store,
      queryClient,
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.feed_following() }));

    expect(store.get(feedScopeAtom)).toBe("following");
    expect(screen.getByRole("button", { name: m.feed_following() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(m.feed_empty_following())).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: m.feed_find_people() }));
    expect(router.state.location.pathname).toBe("/discover");
  });

  it("honours a persisted Following scope on the first signed-in render", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "following");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([{ items: [], nextCursor: null }], {
      feed: "following",
    });

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByRole("button", { name: m.feed_following() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(m.feed_empty_following())).toBeInTheDocument();
  });
});
