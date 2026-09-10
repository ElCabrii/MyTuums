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
    delete: vi.fn(),
    clearAll: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

beforeEach(() => {
  vi.clearAllMocks();
  fakeClient.notification.markRead.mockResolvedValue({ read: 0 });
  fakeClient.notification.delete.mockResolvedValue({ success: true, id: "notification-id" });
  fakeClient.notification.clearAll.mockResolvedValue({ deletedCount: 0 });
});

describe("NotificationsPage", () => {
  it("renders one row per event, in the feed's order, with its recipient-voiced copy", async () => {
    const like = makeNotification({ type: "like", postId: "liked-post" });
    const reply = makeNotification({ type: "reply", postId: "the-reply", read: true });
    const repost = makeNotification({ type: "repost", postId: "reposted-post" });
    const quote = makeNotification({ type: "quote", postId: "the-quote" });
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
      { items: [moderation, follow, quote, repost, reply, like], nextCursor: null },
    ]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    expect(screen.getByText(m.notification_like({ name: "Alex Mercer" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_reply({ name: "Alex Mercer" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_repost({ name: "Alex Mercer" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_quote({ name: "Alex Mercer" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_follow({ name: "Jamie Rivera" }))).toBeInTheDocument();
    expect(screen.getByText(m.notification_moderation_post_removed())).toBeInTheDocument();
    expect(screen.getByText(m.notification_reason({ reason: "rule break" }))).toBeInTheDocument();

    // The unread marker is present on unread rows and absent on read ones —
    // one dot for the like, none for the reply.
    expect(screen.getAllByText(m.notifications_unread_label())).toHaveLength(5);
  });

  it("previews the post's text and thumbnails under the sentence (issue #281)", async () => {
    const like = makeNotification({
      type: "like",
      postId: "liked-post",
      postContent: "the liked post's words",
      postAttachments: [
        {
          id: "attachment-1",
          url: "/media/posts/liked.png",
          position: 0,
          contentType: "image/png",
          byteSize: 1024,
          width: 600,
          height: 400,
        },
      ],
    });
    // An image-only reply: thumbnails render with no text line to pair with.
    const reply = makeNotification({
      type: "reply",
      postId: "the-reply",
      postContent: null,
      postAttachments: [
        {
          id: "attachment-2",
          url: "/media/posts/reply-1.png",
          position: 0,
          contentType: "image/png",
          byteSize: 1024,
          width: 400,
          height: 600,
        },
        {
          id: "attachment-3",
          url: "/media/posts/reply-2.png",
          position: 1,
          contentType: "image/png",
          byteSize: 1024,
          width: 400,
          height: 400,
        },
      ],
    });

    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([{ items: [reply, like], nextCursor: null }]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    expect(screen.getByText("the liked post's words")).toBeInTheDocument();
    // One first-position thumbnail per row with attachments, and the reply's
    // second in line — nothing beyond exactly these three images renders.
    expect(screen.getAllByAltText(m.post_attachment_alt({ position: "1" }))).toHaveLength(2);
    expect(screen.getByAltText(m.post_attachment_alt({ position: "2" }))).toHaveAttribute(
      "src",
      "/media/posts/reply-2.png",
    );
  });

  it("links each row to where the event can be re-joined", async () => {
    const like = makeNotification({ type: "like", postId: "liked-post" });
    // A quote leads to the quote itself — what the quoter said — not the
    // recipient's own post back, on the same rule a reply leads to the reply.
    const quote = makeNotification({ type: "quote", postId: "the-quote" });
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
      { items: [moderation, follow, quote, like], nextCursor: null },
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
    expect(screen.getByRole("link", { name: /quoted your post/ })).toHaveAttribute(
      "href",
      "/post/the-quote",
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

  it("offers a delete action on each row that calls the delete procedure", async () => {
    const row = makeNotification({ id: "deletable-notification" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([{ items: [row], nextCursor: null }]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.notification_delete() }));
    await waitFor(() =>
      expect(fakeClient.notification.delete).toHaveBeenCalledWith(
        { id: "deletable-notification" },
        expect.anything(),
      ),
    );
  });

  it("only disables the row being deleted", async () => {
    const first = makeNotification({ id: "n-1" });
    const second = makeNotification({ id: "n-2" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([{ items: [first, second], nextCursor: null }]);
    let resolveDelete!: (value: { success: true; id: string }) => void;
    fakeClient.notification.delete.mockReturnValue(
      new Promise((resolve) => {
        resolveDelete = resolve;
      }),
    );

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    const user = userEvent.setup();
    const buttons = screen.getAllByRole("button", { name: m.notification_delete() });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    await waitFor(() => expect(buttons[0]).toBeDisabled());
    // The other row stays actionable while the first round trip is in flight.
    expect(buttons[1]).not.toBeDisabled();

    resolveDelete({ success: true, id: "n-1" });
    // The deleted row leaves; the surviving row's button was never disabled.
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: m.notification_delete() })).toHaveLength(1),
    );
    expect(screen.getByRole("button", { name: m.notification_delete() })).not.toBeDisabled();
  });

  it("dismisses the delete error without another attempt", async () => {
    const row = makeNotification({ id: "deletable-notification" });
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([{ items: [row], nextCursor: null }]);
    fakeClient.notification.delete.mockRejectedValueOnce(new Error("NOT_FOUND"));

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.notification_delete() }));
    await waitFor(() =>
      expect(screen.getByText(m.notification_delete_error())).toBeInTheDocument(),
    );
    expect(fakeClient.notification.delete).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: m.common_close() }));
    await waitFor(() =>
      expect(screen.queryByText(m.notification_delete_error())).not.toBeInTheDocument(),
    );
  });
  it("clears the inbox behind a confirmation dialog", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([
      { items: [makeNotification()], nextCursor: null },
    ]);

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.notifications_clear_all() }));
    expect(screen.getByText(m.notifications_clear_all_title())).toBeInTheDocument();

    const confirmButtons = screen.getAllByRole("button", {
      name: m.notifications_clear_all(),
    });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() =>
      expect(fakeClient.notification.clearAll).toHaveBeenCalledWith({}, expect.anything()),
    );
  });

  it("clears the clear-all error when the dialog is closed and reopened", async () => {
    const queryClient = createTestQueryClient();
    queryFixtures(queryClient).notifications.data([
      { items: [makeNotification()], nextCursor: null },
    ]);
    fakeClient.notification.clearAll.mockRejectedValueOnce(new Error("FORBIDDEN"));

    await renderWithProviders(<NotificationsPage />, {
      queryClient,
      initialPath: "/notifications",
      signedInAs: true,
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: m.notifications_clear_all() }));
    const confirmButtons = screen.getAllByRole("button", {
      name: m.notifications_clear_all(),
    });
    await user.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() =>
      expect(screen.getByText(m.notifications_clear_all_error())).toBeInTheDocument(),
    );

    // Cancel closes and resets — the next open starts with no stale error.
    await user.click(screen.getByRole("button", { name: m.common_cancel() }));
    await waitFor(() =>
      expect(screen.queryByText(m.notifications_clear_all_title())).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: m.notifications_clear_all() }));
    expect(screen.getByText(m.notifications_clear_all_title())).toBeInTheDocument();
    expect(screen.queryByText(m.notifications_clear_all_error())).not.toBeInTheDocument();
  });
});
