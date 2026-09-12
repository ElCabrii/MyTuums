import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { ORPCError } from "@orpc/client";
import { feedScopeAtom } from "@/lib/feed-scope";
import { postListQueryOptions } from "@/lib/query-definitions";
import {
  createTestQueryClient,
  makePost,
  makePostListPage,
  makeRanking,
  makeRankSuggestion,
} from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { HomePage } from "@/components/home-page";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  video: { pending: vi.fn().mockResolvedValue([]), cancel: vi.fn() },
  post: { list: vi.fn(), create: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
});

function rankedGlobalPage(content: string) {
  return makePostListPage({
    items: [makePost({ content })],
    nextCursor: null,
    ranking: makeRanking({ suggestions: [] }),
  });
}

/** A ranked page carrying four follow suggestions — one more than the module shows. */
function suggestionsPage(content: string) {
  return makePostListPage({
    items: [makePost({ content })],
    nextCursor: null,
    ranking: makeRanking({
      suggestions: [
        makeRankSuggestion({ id: "user-1", username: "jamierivera", name: "Jamie Rivera" }),
        makeRankSuggestion({ id: "user-2", username: "samkim", name: "Sam Kim" }),
        makeRankSuggestion({ id: "user-3", username: "taylorw", name: "Taylor Wu" }),
        makeRankSuggestion({ id: "user-4", username: "fourth", name: "Fourth Person" }),
      ],
    }),
  });
}

describe("HomePage", () => {
  it("keeps the feed unmounted while the session scope is unresolved", async () => {
    await renderWithProviders(<HomePage />, { sessionPending: true });

    expect(screen.getByRole("heading", { name: m.feed_title() })).toBeInTheDocument();
    expect(screen.queryByText(m.feed_empty())).not.toBeInTheDocument();
    expect(screen.queryByText(m.feed_empty_following())).not.toBeInTheDocument();
    await waitFor(() => expect(fakeClient.post.list).not.toHaveBeenCalled());
  });

  it("renders the ranked global feed with an explicit Refresh and the sidebar's legal links", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([rankedGlobalPage("A ranked post")], {
      feed: "global",
      ranked: true,
    });

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByRole("button", { name: m.feed_for_you() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("A ranked post")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.feed_refresh() })).toBeInTheDocument();
    // An empty suggestion set renders no module — the API's live filtering,
    // pinned in packages/api's feed-rank integration tests.
    expect(
      screen.queryByRole("heading", { name: m.who_to_follow_title() }),
    ).not.toBeInTheDocument();
    // The legal-links block is static — it renders beside every scope.
    expect(screen.getByRole("heading", { name: m.legal_links_title() })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: m.legal_privacy_policy() })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: m.legal_terms_of_service() })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: m.legal_notice() })).toHaveAttribute(
      "href",
      "/mentions-legales",
    );
  });

  it("renders the sidebar's Who-to-Follow from the For-you feed's own ranking metadata", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([suggestionsPage("A ranked post")], {
      feed: "global",
      ranked: true,
    });

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByRole("heading", { name: m.who_to_follow_title() })).toBeInTheDocument();
    expect(screen.getByText("Jamie Rivera")).toBeInTheDocument();
    expect(screen.getByText("Sam Kim")).toBeInTheDocument();
    expect(screen.getByText("Taylor Wu")).toBeInTheDocument();
    // Top three only — the fourth candidate waits for the next snapshot.
    expect(screen.queryByText("Fourth Person")).not.toBeInTheDocument();
    // The feed itself still renders beside the module.
    expect(screen.getByText("A ranked post")).toBeInTheDocument();
  });

  it("renders the global empty state without the Discover action", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      { feed: "global", ranked: true },
    );

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByText(m.feed_empty())).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: m.feed_find_people() })).not.toBeInTheDocument();
  });

  it("switches to Following, persists the scope, and exposes the Discover action", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      { feed: "global", ranked: true },
    );
    queryFixtures(queryClient).postList.data(
      [makePostListPage({ ranking: makeRanking({ suggestions: [] }) })],
      {
        feed: "following",
        ranked: true,
      },
    );
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
    // Suggestions seeded on purpose: the sidebar never mounts the module for
    // Following, whatever the feed's metadata carries — mounting it would
    // fetch an unwatched global feed beside the followed one.
    queryFixtures(queryClient).postList.data([suggestionsPage("A followed post")], {
      feed: "following",
      ranked: true,
    });

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByRole("button", { name: m.feed_following() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("A followed post")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: m.who_to_follow_title() }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: m.legal_links_title() })).toBeInTheDocument();
  });

  // An ordinary aged-out snapshot — retained rows plus the expiry refusal —
  // recovers itself: RankedFeed performs the same reset Refresh performs,
  // so the viewer never meets the card. The only route to fresh content
  // from this seeded state is that automatic reset refetching.
  it("recovers an expired snapshot without asking the viewer to refresh", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).postList.data([rankedGlobalPage("A stale ranking")], {
      feed: "global",
      ranked: true,
    });
    await queryFixtures(queryClient).query.error(
      postListQueryOptions({ feed: "global", ranked: true }).queryKey,
      new ORPCError("BAD_REQUEST", {
        message: "This ranking is no longer valid. Refresh the feed to build a new one.",
      }),
    );
    fakeClient.post.list.mockResolvedValue(rankedGlobalPage("A fresh ranking"));

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(await screen.findByText("A fresh ranking")).toBeInTheDocument();
    expect(screen.queryByText(m.feed_snapshot_expired())).not.toBeInTheDocument();
  });

  // The card is the fallback, not the primary path: it renders only when
  // expiry strikes a snapshot with no retained pages — the reset-and-loop
  // case the automatic recovery must refuse (a freshly minted snapshot
  // refusing again would loop forever). No data seeded, so no auto-refresh:
  // expiry renders its own recovery card, never the ordinary retry —
  // retrying would resend the same expired snapshot and loop the same
  // refusal forever. The card names the expiry in the viewer's language and
  // offers the same Refresh that starts a new ranking.
  it("recovers an expired snapshot through Refresh instead of looping Try again", async () => {
    const store = createStore();
    store.set(feedScopeAtom, "global");
    const queryClient = createTestQueryClient();
    await queryFixtures(queryClient).query.error(
      postListQueryOptions({ feed: "global", ranked: true }).queryKey,
      new ORPCError("BAD_REQUEST", {
        message: "This ranking is no longer valid. Refresh the feed to build a new one.",
      }),
    );

    await renderWithProviders(<HomePage />, { store, queryClient, signedInAs: true });

    expect(screen.getByText(m.feed_snapshot_expired())).toBeInTheDocument();
    // The persistent header control plus the card's own recovery action —
    // either starts a new ranking, and neither loops the expired snapshot.
    expect(screen.getAllByRole("button", { name: m.feed_refresh() })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: m.common_try_again() })).not.toBeInTheDocument();

    // The card's Refresh mints a fresh ranking on the mounted feed.
    fakeClient.post.list.mockResolvedValue(
      makePostListPage({
        items: [makePost({ content: "A fresh ranking" })],
        nextCursor: null,
        ranking: makeRanking({ snapshotId: "snapshot-fresh", suggestions: [] }),
      }),
    );
    const user = userEvent.setup();
    const recoveryCard = screen.getByRole("alert");
    await user.click(within(recoveryCard).getByRole("button", { name: m.feed_refresh() }));
    expect(await screen.findByText("A fresh ranking")).toBeInTheDocument();
    expect(screen.queryByText(m.feed_snapshot_expired())).not.toBeInTheDocument();
  });

  it("prompts For you for favorite games on a cold start, but never on Following", async () => {
    const forYouStore = createStore();
    forYouStore.set(feedScopeAtom, "global");
    const forYouClient = createTestQueryClient();
    queryFixtures(forYouClient).postList.data(
      [
        makePostListPage({
          items: [makePost({ content: "A ranked post" })],
          nextCursor: null,
          ranking: makeRanking({ hasInterests: false, suggestions: [] }),
        }),
      ],
      { feed: "global", ranked: true },
    );

    const forYou = await renderWithProviders(<HomePage />, {
      store: forYouStore,
      queryClient: forYouClient,
      signedInAs: true,
    });
    expect(forYou.getByText(m.who_to_follow_games_prompt())).toBeInTheDocument();
    expect(forYou.getByText("A ranked post")).toBeInTheDocument();
    forYou.unmount();

    const followingStore = createStore();
    followingStore.set(feedScopeAtom, "following");
    const followingClient = createTestQueryClient();
    queryFixtures(followingClient).postList.data(
      [
        makePostListPage({
          items: [makePost({ content: "A followed post" })],
          nextCursor: null,
          ranking: makeRanking({ hasInterests: false, suggestions: [] }),
        }),
      ],
      { feed: "following", ranked: true },
    );

    const following = await renderWithProviders(<HomePage />, {
      store: followingStore,
      queryClient: followingClient,
      signedInAs: true,
    });
    expect(following.getByText("A followed post")).toBeInTheDocument();
    expect(following.queryByText(m.who_to_follow_games_prompt())).not.toBeInTheDocument();
    following.unmount();
  });
});
