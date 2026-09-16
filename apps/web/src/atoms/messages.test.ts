import { afterEach, beforeEach, expect, it, vi } from "vitest";

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
import { installTestOrpc, orpc } from "@/lib/orpc";
import {
  acceptRequestAtom,
  deleteMessageAtom,
  markThreadReadAtom,
  sendMessageAtom,
} from "@/atoms/messages";
import type { ThreadItem } from "@/atoms/messages";
import { setTestSession, signedInSession } from "@/test/auth-fixture";
import { queryClient as singletonQueryClient } from "@/lib/query-client";
import { store as singletonStore } from "@/lib/store";
import { messagesUnreadQueryOptions } from "@/lib/query-definitions";
import type { ConversationItem, MessageItem, SentMessage } from "@/lib/orpc";

/**
 * The private-message cache contracts (issue #408): optimistic send with
 * rollback and reconciliation, tombstone patching, the read-state patch from
 * the mutation's authoritative answer, and the requests row leaving
 * optimistically on accept. Same harness as the notifications atoms' suite.
 */

const VIEWER = "viewer-1";
const OTHER = "user-2";

function makeMessage(overrides: Partial<MessageItem> = {}): ThreadItem {
  return {
    id: crypto.randomUUID(),
    senderId: OTHER,
    body: "a message",
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function seedThread(items: ThreadItem[]) {
  singletonQueryClient.setQueryData(orpc.message.thread.key(), {
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  });
}

function threadItems(): ThreadItem[] {
  // SAFETY: the shape seedThread wrote — read back through the same key.
  const cache = singletonQueryClient.getQueryData(orpc.message.thread.key()) as {
    pages: Array<{ items: ThreadItem[] }>;
  };
  return cache.pages[0].items;
}

beforeEach(() => {
  setTestSession(signedInSession({ id: VIEWER }));
  fakeClient.message.send.mockReset();
  fakeClient.message.deleteMessage.mockReset();
  fakeClient.message.markRead.mockReset();
  fakeClient.message.accept.mockReset();
});

afterEach(() => {
  singletonQueryClient.clear();
  vi.restoreAllMocks();
});

it("an optimistic send appends, rolls back on refusal, and reconciles with the server row", async () => {
  const existing = makeMessage({ id: "kept" });
  seedThread([existing]);

  // Refusal first: the optimistic row must disappear again.
  fakeClient.message.send.mockRejectedValueOnce(new Error("NOT_FOUND"));
  const failing = singletonStore.get(sendMessageAtom);
  await expect(
    failing.mutateAsync({ recipientId: OTHER, body: "doomed", conversationId: "c-1" }),
  ).rejects.toThrow("NOT_FOUND");
  expect(threadItems().map((item) => item.id)).toEqual(["kept"]);

  // Then success: the pending row is REPLACED by the server's row, not
  // duplicated beside it.
  const sent: SentMessage = {
    id: "server-row",
    conversationId: "c-1",
    senderId: VIEWER,
    createdAt: new Date(),
    body: "hello",
  };
  fakeClient.message.send.mockResolvedValueOnce(sent);
  const sending = singletonStore.get(sendMessageAtom);
  await sending.mutateAsync({ recipientId: OTHER, body: "hello", conversationId: "c-1" });

  const items = threadItems();
  expect(items.map((item) => item.id)).toEqual(["server-row", "kept"]);
  expect(items[0]).not.toHaveProperty("pending", true);
});

it("deleting the caller's own message tombstones it optimistically and restores it on refusal", async () => {
  const row = makeMessage({ id: "regrettable", senderId: VIEWER, body: "words" });
  seedThread([row]);

  fakeClient.message.deleteMessage.mockRejectedValueOnce(new Error("refused"));
  const failing = singletonStore.get(deleteMessageAtom);
  await expect(failing.mutateAsync({ messageId: "regrettable" })).rejects.toThrow("refused");
  expect(threadItems()[0].body).toBe("words");
  expect(threadItems()[0].deletedAt).toBeNull();

  fakeClient.message.deleteMessage.mockResolvedValueOnce({
    id: "regrettable",
    conversationId: "c-1",
    deletedAt: new Date(),
  });
  const removing = singletonStore.get(deleteMessageAtom);
  await removing.mutateAsync({ messageId: "regrettable" });
  expect(threadItems()[0].body).toBeNull();
  expect(threadItems()[0].deletedAt).not.toBeNull();
});

it("markRead patches the inbox row's unread flag from the mutation's answer", async () => {
  const row: ConversationItem = {
    conversationId: "c-1",
    lastMessageAt: new Date(),
    lastReadAt: null,
    unread: true,
    lastMessage: { senderId: OTHER, body: "hello?", createdAt: new Date() },
    user: { id: OTHER, name: "Other", username: "other", displayUsername: "Other", image: null },
  };
  singletonQueryClient.setQueryData(orpc.message.conversations.key(), {
    pages: [{ items: [row], nextCursor: null }],
    pageParams: [undefined],
  });
  const cursor = new Date();
  fakeClient.message.markRead.mockResolvedValue({ lastReadAt: cursor, advanced: true });

  const marking = singletonStore.get(markThreadReadAtom);
  await marking.mutateAsync({ conversationId: "c-1", lastSeenMessageId: "m-1" });

  // SAFETY: the shape seeded above — read back through the same key.
  const cache = singletonQueryClient.getQueryData(orpc.message.conversations.key()) as {
    pages: Array<{ items: ConversationItem[] }>;
  };
  expect(cache.pages[0].items[0].unread).toBe(false);
  expect(cache.pages[0].items[0].lastReadAt).toEqual(cursor);
});

it("accepting a request removes its row from the requests feed and restores it on refusal", async () => {
  const row = {
    conversationId: "c-1",
    lastMessageAt: new Date(),
    lastMessage: { senderId: OTHER, body: "hi", createdAt: new Date() },
    user: { id: OTHER, name: "Other", username: "other", displayUsername: "Other", image: null },
  };
  singletonQueryClient.setQueryData(orpc.message.requests.key(), {
    pages: [{ items: [row], nextCursor: null }],
    pageParams: [undefined],
  });

  fakeClient.message.accept.mockRejectedValueOnce(new Error("refused"));
  const failing = singletonStore.get(acceptRequestAtom);
  await expect(failing.mutateAsync({ conversationId: "c-1" })).rejects.toThrow("refused");
  // SAFETY: the shape seeded above — read back through the same key.
  let cache = singletonQueryClient.getQueryData(orpc.message.requests.key()) as {
    pages: Array<{ items: unknown[] }>;
  };
  expect(cache.pages[0].items).toHaveLength(1);

  fakeClient.message.accept.mockResolvedValueOnce({ conversationId: "c-1" });
  const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
  const accepting = singletonStore.get(acceptRequestAtom);
  await accepting.mutateAsync({ conversationId: "c-1" });
  // SAFETY: same key, same shape as the read above.
  cache = singletonQueryClient.getQueryData(orpc.message.requests.key()) as {
    pages: Array<{ items: unknown[] }>;
  };
  expect(cache.pages[0].items).toHaveLength(0);

  // The success path also invalidates the badge — its total is the server's
  // to recompute, not derivable from one row.
  expect(invalidateSpy.mock.calls).toContainEqual([
    { queryKey: messagesUnreadQueryOptions().queryKey },
  ]);
});
