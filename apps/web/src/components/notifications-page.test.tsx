import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";
import { createTestQueryClient, makeAuthor, makeNotification } from "@/test/factories";
import { queryFixtures } from "@/test/query-fixtures";
import { renderWithProviders } from "@/test/render";
import { NotificationsPage } from "@/components/notifications-page";
import { m } from "@/paraglide/messages.js";

const fakeClient = {
  notification: {
    list: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
  fakeClient.notification.markRead.mockResolvedValue({ read: 0 });
});

describe("NotificationsPage", () => {
  it("renders one row per event, in the feed's order, with its recipient-voiced copy", async () => {
    const like = makeNotification({ type: "like", postId: "liked-post" });
    const reply = makeNotification({ type: "reply", postId: "the-reply", read: true });
    const follow = makeNotification({
      type: "follow",
      postId: null,
      actor: makeAuthor({ name: "Jamie Rivera", username: "jamierivera" }),
    });
    const moderation = makeNotification({
      type: "moderation",
      postId: null,
      actor: null,
      action: {
        code: "post_removed",
        reason: "rule break",
        targetType: "post",
        targetPostId: "removed-post",
        targetUserId: null,
      },
      targetPostDeletedAt: null,
    });

    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([
      { items: [moderation, follow, reply, like], nextCursor: null },
    ]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    expect(screen.getByText(m.notification_like({ name: "Alex Mercer" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_reply({ name: "Alex Mercer" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_follow({ name: "Jamie Rivera" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_moderation_post_removed())).toBeInTheDocument();
    expect(screen.getByText(m.notification_reason({ reason: "rule break" }))).toBeInTheDocument();

    // The unread marker is present on unread rows and absent on read ones —
    // one dot for the like, none for the reply.
    expect(screen.getAllByText(m.notifications_unread_label())).toHaveLength(3);
  });

  it("links each row to where the event can be re-joined", async () => {
    const like = makeNotification({ type: "like", postId: "liked-post" });
    const follow = makeNotification({
      type: "follow",
      postId: null,
      actor: makeAuthor({ username: "jamierivera" }),
    });
    const moderation = makeNotification({
      type: "moderation",
      postId: null,
      actor: null,
      action: {
        code: "user_banned",
        reason: null,
        targetType: "user",
        targetPostId: null,
        targetUserId: "user-1",
      },
      targetPostDeletedAt: null,
    });

    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([
      { items: [moderation, follow, like], nextCursor: null },
    ]);
    const { router } = await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    expect(screen.getByRole("link", { name: /liked your post/ })).toHaveAttribute(
      "href",
      "/post/liked-post",
    );
    expect(screen.getByRole("link", { name: /followed you/ })).toHaveAttribute(
      "href",
      "/@jamierivera",
    );
    // An account-level moderation notice has nowhere to lead — a plain row.
    expect(screen.queryByRole("link", { name: /banned/ })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: /liked your post/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/post/liked-post"));
  });

  it("renders a moderation notice about a since-deleted post as a plain row, not a dead link", async () => {
    const removedThenDeleted = makeNotification({
      type: "moderation",
      postId: null,
      actor: null,
      action: {
        code: "post_removed",
        reason: "rule break",
        targetType: "post",
        targetPostId: "gone-post",
        targetUserId: null,
      },
      targetPostDeletedAt: new Date(),
    });

    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([
      { items: [removedThenDeleted], nextCursor: null },
    ]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    expect(screen.getByText(m.notification_moderation_post_removed())).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /removed by a moderator/ })).not.toBeInTheDocument();
  });

  it("marks everything read once on mount — opening the page is what clears the badge", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([
      { items: [makeNotification(), makeNotification()], nextCursor: null },
    ]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    // Once, not once per refetch or per result transition (the `isIdle` guard).
    await waitFor(() =>
      expect(fakeClient.notification.markRead).toHaveBeenCalledWith({}, expect.anything()),
    );
    await waitFor(() => expect(fakeClient.notification.markRead).toHaveBeenCalledTimes(1));
  });

  it("renders the empty state when there is nothing to show", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([{ items: [], nextCursor: null }]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    expect(screen.getByText(m.notifications_empty())).toBeInTheDocument();
  });
});
