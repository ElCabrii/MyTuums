import { beforeEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";

const fakeClient = {
  message: {
    send: vi.fn(),
    conversations: vi.fn(),
    requests: vi.fn(),
    thread: vi.fn(),
    unreadCount: vi.fn(),
    markRead: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
    hide: vi.fn(),
    deleteMessage: vi.fn(),
    conversationWith: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";
import type { ConversationItem } from "@/lib/orpc";
import { messagesUnreadQueryOptions } from "@/lib/query-definitions";
import { MessagesPage } from "@/components/messages-page";
import { renderWithProviders } from "@/test/render";
import { createTestQueryClient } from "@/test/factories";
import type { QueryClient } from "@tanstack/react-query";

/**
 * The inbox surface's two badge contracts: each conversation row carries its
 * own unread count (the sender's tally, not a dot), and the browser tab
 * mirrors the header badge — "(5) Messages - MyTuums" while mail is owed,
 * plain "Messages - MyTuums" once it is not.
 */

const OTHER = "user-2";

function conversationRow(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: "c-1",
    lastMessageAt: new Date(),
    lastReadAt: null,
    unreadCount: 0,
    lastMessage: { senderId: OTHER, body: "hi", mediaKind: null, createdAt: new Date() },
    user: { id: OTHER, name: "Other", username: "other", displayUsername: "Other", image: null },
    ...overrides,
  };
}

function renderPage(queryClient: QueryClient) {
  return renderWithProviders(<MessagesPage />, {
    signedInAs: { id: "viewer-1" },
    initialPath: "/messages",
    queryClient,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

it("each conversation row shows its own unread count, capped past ninety-nine", async () => {
  fakeClient.message.conversations.mockResolvedValue({
    items: [
      conversationRow({ conversationId: "c-1", unreadCount: 3 }),
      conversationRow({
        conversationId: "c-2",
        unreadCount: 0,
        lastMessage: {
          senderId: "viewer-1",
          body: "my own",
          mediaKind: null,
          createdAt: new Date(),
        },
      }),
      conversationRow({ conversationId: "c-3", unreadCount: 120 }),
    ],
    nextCursor: null,
  });
  fakeClient.message.unreadCount.mockResolvedValue({ unreadCount: 123, requestCount: 0 });

  await renderPage(createTestQueryClient());

  expect(await screen.findByText("3")).toBeTruthy();
  expect(screen.getByText("99+")).toBeTruthy();
  // A read row carries no badge at all — no orphan "0" for screen readers.
  expect(screen.queryByText("0")).toBeNull();
});

it("the tab title mirrors the unread total and drops the prefix when it clears", async () => {
  fakeClient.message.conversations.mockResolvedValue({
    items: [conversationRow({ unreadCount: 5 })],
    nextCursor: null,
  });
  fakeClient.message.unreadCount.mockResolvedValue({ unreadCount: 5, requestCount: 0 });

  const { queryClient } = await renderPage(createTestQueryClient());
  await waitFor(() => expect(document.title).toBe("(5) Messages - MyTuums"));

  // The badge clears through the same cache the SSE push invalidates; the
  // tab must follow without a remount.
  queryClient.setQueryData(messagesUnreadQueryOptions().queryKey, {
    unreadCount: 0,
    requestCount: 0,
  });
  await waitFor(() => expect(document.title).toBe("Messages - MyTuums"));
});
