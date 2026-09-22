import { createIdentity, publicIdentity, unlockIdentity } from "@my-tuums/message-crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fakeClient = {
  messageKey: { identity: vi.fn(), status: vi.fn() },
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

installTestClient(fakeClient);

import { installTestClient, orpc } from "@/lib/orpc";
import {
  acceptRequestAtom,
  deleteMessageAtom,
  markThreadReadAtom,
  sendMessageAtom,
} from "@/atoms/messages";
import type { ThreadItem } from "@/atoms/messages";
import { setTestSession, signedInSession } from "@/test/auth-fixture";
import { queryClient as singletonQueryClient } from "@/lib/query-client";
import { sessionAtom } from "@/atoms/session";
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

function seedThread(conversationId: string, items: ThreadItem[]) {
  singletonQueryClient.setQueryData(orpc.message.thread.key({ input: { conversationId } }), {
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  });
}

function threadItems(conversationId: string): ThreadItem[] {
  // SAFETY: the shape seedThread wrote — read back through the same key.
  const cache = singletonQueryClient.getQueryData(
    orpc.message.thread.key({ input: { conversationId } }),
  ) as {
    pages: Array<{ items: ThreadItem[] }>;
  };
  return cache.pages[0].items;
}

beforeEach(async () => {
  setTestSession(signedInSession({ id: VIEWER }));
  // `sessionAtom` syncs from the auth nanostore only while subscribed
  // (see its onMount); without this, the mutation atoms read a stale
  // viewer id and their optimistic halves never run.
  unsubscribeSession = singletonStore.sub(sessionAtom, () => {});
  const identity = await createIdentity(VIEWER);
  const local = await unlockIdentity(identity);
  const recipient = await createIdentity(OTHER);
  fakeClient.messageKey.identity.mockResolvedValue(publicIdentity(recipient));
  fakeClient.messageKey.status.mockResolvedValue({ identity: local.public, recovery: null });
  singletonQueryClient.setQueryData(["message-access", VIEWER], {
    local,
    identity: local.public,
    recovery: null,
  });
  fakeClient.message.send.mockReset();
  fakeClient.message.deleteMessage.mockReset();
  fakeClient.message.markRead.mockReset();
  fakeClient.message.accept.mockReset();
});

afterEach(() => {
  unsubscribeSession();
  singletonQueryClient.clear();
  vi.restoreAllMocks();
});

let unsubscribeSession: () => void = () => {};

it("an optimistic send appends, rolls back on refusal, and reconciles — touching only the destination conversation's cache", async () => {
  // Two cached conversations. The regression this pins: the send mutation
  // once patched the bare thread prefix, appending the message to EVERY
  // cached thread — B's history would display A's private text.
  const mine = makeMessage({ id: "kept" });
  const theirs = makeMessage({ id: "theirs" });
  seedThread("c-1", [mine]);
  seedThread("c-2", [theirs]);

  // Refusal first: the optimistic row must disappear again, and c-2 must
  // never have received one.
  fakeClient.message.send.mockRejectedValueOnce(new Error("NOT_FOUND"));
  const failing = singletonStore.get(sendMessageAtom);
  await expect(
    failing.mutateAsync({ recipientId: OTHER, body: "doomed", conversationId: "c-1" }),
  ).rejects.toThrow("NOT_FOUND");
  expect(threadItems("c-1").map((item) => item.id)).toEqual(["kept"]);
  expect(threadItems("c-2").map((item) => item.id)).toEqual(["theirs"]);

  // Then success: the pending row is REPLACED by the server's row, not
  // duplicated beside it — and only in c-1.
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

  const items = threadItems("c-1");
  expect(items.map((item) => item.id)).toEqual(["server-row", "kept"]);
  expect(items[0]).not.toHaveProperty("pending", true);
  expect(threadItems("c-2").map((item) => item.id)).toEqual(["theirs"]);
});

it("reconciliation is idempotent when the SSE-driven refetch lands the message before the send response", async () => {
  seedThread("c-1", [makeMessage({ id: "older" })]);
  const sent: SentMessage = {
    id: "server-row",
    conversationId: "c-1",
    senderId: VIEWER,
    createdAt: new Date(),
    body: "hello",
  };
  // The server publishes the push before responding; the hook refetches and
  // the committed row is in the cache by the time onSuccess runs.
  let resolveSend: (value: SentMessage) => void = () => {};
  fakeClient.message.send.mockReturnValueOnce(
    new Promise<SentMessage>((resolve) => {
      resolveSend = resolve;
    }),
  );
  const sending = singletonStore.get(sendMessageAtom);
  const pending = sending.mutateAsync({
    recipientId: OTHER,
    body: "hello",
    conversationId: "c-1",
  });
  await vi.waitFor(() => {
    expect(threadItems("c-1").some((item) => item.pending)).toBe(true);
  });
  // The refetched row carries the full thread-item shape (tombstone field
  // included), exactly as the server would return it.
  seedThread("c-1", [{ ...sent, deletedAt: null }, ...threadItems("c-1")]);
  resolveSend(sent);
  await pending;

  // One server row, one optimistic row retired — not the same id twice.
  expect(threadItems("c-1").map((item) => item.id)).toEqual(["server-row", "older"]);
});

it("deleting the caller's own message tombstones it optimistically and restores it on refusal", async () => {
  const row = makeMessage({ id: "regrettable", senderId: VIEWER, body: "words" });
  seedThread("c-1", [row]);

  fakeClient.message.deleteMessage.mockRejectedValueOnce(new Error("refused"));
  const failing = singletonStore.get(deleteMessageAtom);
  await expect(failing.mutateAsync({ messageId: "regrettable" })).rejects.toThrow("refused");
  expect(threadItems("c-1")[0].body).toBe("words");
  expect(threadItems("c-1")[0].deletedAt).toBeNull();

  fakeClient.message.deleteMessage.mockResolvedValueOnce({
    id: "regrettable",
    conversationId: "c-1",
    deletedAt: new Date(),
  });
  const removing = singletonStore.get(deleteMessageAtom);
  await removing.mutateAsync({ messageId: "regrettable" });
  expect(threadItems("c-1")[0].body).toBeNull();
  expect(threadItems("c-1")[0].deletedAt).not.toBeNull();
});

it("markRead patches the inbox row's unread count from the mutation's answer", async () => {
  const row: ConversationItem = {
    conversationId: "c-1",
    lastMessageAt: new Date(),
    lastReadAt: null,
    unreadCount: 2,
    lastMessage: { encrypted: false, senderId: OTHER, body: "hello?", createdAt: new Date() },
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
  expect(cache.pages[0].items[0].unreadCount).toBe(0);
  expect(cache.pages[0].items[0].lastReadAt).toEqual(cursor);
});

it("accepting a request removes its row from the requests feed and restores it on refusal", async () => {
  const row = {
    conversationId: "c-1",
    lastMessageAt: new Date(),
    lastMessage: { encrypted: false, senderId: OTHER, body: "hi", createdAt: new Date() },
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
