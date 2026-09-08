import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore } from "jotai";
import { createTestQueryClient, makeProfile } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { ProfilePosts } from "@/components/profile-posts";
import { sessionAtom } from "@/atoms/session";
import { setTestSession, signedInSession } from "@/test/auth-fixture";
import { m } from "@/paraglide/messages.js";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

const fakeClient = {
  user: { byUsername: vi.fn() },
  post: { list: vi.fn(), create: vi.fn() },
  search: { typeahead: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

/**
 * A store pre-seeded with a complete session for the given viewer. Product
 * queries stay idle until the session is ready (issue #353) — without this
 * the first paint renders gated skeletons instead of the seeded cache, and a
 * mid-test flip would refetch what the tests assert stays untouched.
 */
function readyStore(viewer: { id: string; username?: string }) {
  // Omitted fields fall back to the fixture's complete defaults (handle and
  // date of birth present), so the pre-seeded session reads as ready.
  const session = signedInSession(viewer);
  setTestSession(session);
  const store = createStore();
  // SAFETY: the complete session the fake store holds — the feed atoms read
  // only whether the viewer may fire, never the store identity.
  store.set(sessionAtom, session as never);
  return store;
}

describe("ProfilePosts", () => {
  it("selects the quotes and reposts feed through a shareable filter and hides the composer", async () => {
    const profile = makeProfile({ id: "viewer-1", username: "alex" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("alex", profile);
    queryFixtures(queryClient).postList.data(
      [{ items: [], nextCursor: null, gameMentions: {}, ranking: null }],
      { authorId: profile.id, feed: "global", kind: "replies" },
    );
    queryFixtures(queryClient).postList.data(
      [{ items: [], nextCursor: null, gameMentions: {}, ranking: null }],
      { authorId: profile.id, feed: "global", kind: "shares" },
    );

    const { router } = await renderWithProviders(<ProfilePosts />, {
      queryClient,
      store: readyStore({ id: profile.id, username: "alex" }),
      initialPath: "/@alex/?filter=reply",
      signedInAs: { id: profile.id, username: "alex" },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.profile_posts_filter_shares() }));

    expect(router.state.location.search).toEqual({ filter: "shares" });
    expect(await screen.findByText(m.profile_own_shares_empty())).toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.profile_posts_filter_shares() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
  });

  it("shows the composer and owner-specific empty copy on the viewer's profile", async () => {
    const profile = makeProfile({ id: "viewer-1", username: "alex", displayUsername: "Alex" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("alex", profile);
    queryFixtures(queryClient).postList.data(
      [{ items: [], nextCursor: null, gameMentions: {}, ranking: null }],
      {
        authorId: profile.id,
        feed: "global",
        includeReplies: true,
        includeReposts: true,
      },
    );

    await renderWithProviders(<ProfilePosts />, {
      queryClient,
      store: readyStore({ id: profile.id, username: "alex" }),
      initialPath: "/@alex/",
      signedInAs: { id: profile.id, username: "alex" },
    });

    expect(screen.getByPlaceholderText(m.post_placeholder())).toBeInTheDocument();
    expect(screen.getByText(m.profile_own_empty())).toBeInTheDocument();
    expect(fakeClient.post.list).not.toHaveBeenCalled();
  });

  it("hides the composer and uses handle-specific copy for another profile", async () => {
    const profile = makeProfile({ id: "other-1", username: "other", displayUsername: "Other" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("other", profile);
    queryFixtures(queryClient).postList.data(
      [{ items: [], nextCursor: null, gameMentions: {}, ranking: null }],
      {
        authorId: profile.id,
        feed: "global",
        includeReplies: true,
        includeReposts: true,
      },
    );

    await renderWithProviders(<ProfilePosts />, {
      queryClient,
      store: readyStore({ id: "viewer-1" }),
      initialPath: "/@other/",
      signedInAs: { id: "viewer-1" },
    });

    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
    expect(screen.getByText(m.profile_empty({ handle: "other" }))).toBeInTheDocument();
    expect(fakeClient.post.list).not.toHaveBeenCalled();
  });

  it("switches to a shareable replies view, changes the feed atom, and hides the composer", async () => {
    const profile = makeProfile({ id: "viewer-1", username: "alex", displayUsername: "Alex" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).profile.data("alex", profile);
    queryFixtures(queryClient).postList.data(
      [{ items: [], nextCursor: null, gameMentions: {}, ranking: null }],
      {
        authorId: profile.id,
        feed: "global",
        kind: "replies",
      },
    );

    const { router } = await renderWithProviders(<ProfilePosts />, {
      queryClient,
      initialPath: "/@alex/?filter=reply",
      signedInAs: { id: profile.id, username: "alex" },
    });

    expect(screen.getByText(m.profile_own_replies_empty())).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(m.post_placeholder())).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: m.profile_posts_filter_reply() })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.profile_posts_filter_posts() }));

    expect(router.state.location.search).toEqual({ filter: "posts" });
    expect(screen.getByPlaceholderText(m.post_placeholder())).toBeInTheDocument();
  });
});
