import type { QueryClient } from "@tanstack/react-query";
import { atomFamily } from "jotai-family";
import {
  atomWithInfiniteQuery,
  atomWithMutation,
  atomWithQuery,
  queryClientAtom,
} from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import type { ConversationItem, MessageItem, MessageRequestItem, SentMessage } from "@/lib/orpc";
import { protectedProductReadyAtom } from "@/atoms/query-readiness";
import { viewerIdAtom } from "@/atoms/session";
import {
  conversationWithQueryOptions,
  conversationsQueryOptions,
  messageRequestsQueryOptions,
  messageThreadQueryOptions,
  messagesUnreadQueryOptions,
} from "@/lib/query-definitions";

/**
 * The private-message surface's client state (issue #408): the inbox and
 * request feeds, the badge counts, one thread family per conversation, and
 * the mutations that patch caches rather than refetch — the same contract
 * `atoms/notifications.ts` set.
 *
 * Freshness beyond that is push-shaped: `hooks/use-message-events.ts`
 * subscribes to `/events/messages` and invalidates these same keys, and the
 * QueryClient's focus refetch covers the rest. Nothing here polls.
 */

/** The inbox feed — the `/messages` list pane. */
export const conversationsAtom = atomWithInfiniteQuery((get) => ({
  ...conversationsQueryOptions(),
  enabled: get(protectedProductReadyAtom),
}));

/** The message-request feed — the `/messages/requests` page. */
export const messageRequestsAtom = atomWithInfiniteQuery((get) => ({
  ...messageRequestsQueryOptions(),
  enabled: get(protectedProductReadyAtom),
}));

/** The badge plus the requests entry's own count. Mounts with the header. */
export const messagesUnreadAtom = atomWithQuery((get) => ({
  ...messagesUnreadQueryOptions(),
  enabled: get(protectedProductReadyAtom),
}));

/**
 * One thread query per conversation. Primitive string param (Map lookup, no
 * comparator), no `setShouldRemove` — same reasoning as `threadAtomFamily`.
 * Sign-out sweeps it (`clearMessageThreadFamily`, registered in
 * `atoms/session-teardown.ts`).
 */
export const messageThreadFamily = atomFamily((conversationId: string) =>
  atomWithInfiniteQuery((get) => ({
    ...messageThreadQueryOptions(conversationId),
    enabled: get(protectedProductReadyAtom),
  })),
);

/** Drops every thread this family created — called from `clearViewerState`. */
export function clearMessageThreadFamily(): void {
  for (const conversationId of messageThreadFamily.getParams()) {
    messageThreadFamily.remove(conversationId);
  }
  for (const userId of conversationWithFamily.getParams()) {
    conversationWithFamily.remove(userId);
  }
}

/**
 * The "which conversation do I have with this user" lookup, one atom per
 * target user — the `/messages/new/$userId` pane's first read. Swept with the
 * threads: the answer is viewer-relative (a hidden side answers null).
 */
export const conversationWithFamily = atomFamily((userId: string) =>
  atomWithQuery((get) => ({
    ...conversationWithQueryOptions(userId),
    enabled: get(protectedProductReadyAtom),
  })),
);

/** A thread row as it lives in the cache; `pending` marks an optimistic send. */
export type ThreadItem = MessageItem & { pending?: boolean };
type ThreadCache = { pages: Array<{ items: ThreadItem[]; nextCursor: string | null }> };
type ThreadSnapshot = Array<[readonly unknown[], ThreadCache | undefined]>;

type InboxCache = { pages: Array<{ items: ConversationItem[] }> };
type RequestsCache = { pages: Array<{ items: MessageRequestItem[] }> };

function snapshotOf(queryClient: QueryClient, queryKey: readonly unknown[]): ThreadSnapshot {
  return queryClient.getQueriesData<ThreadCache>({ queryKey }).map(([key, data]) => [key, data]);
}

function restoreSnapshot(queryClient: QueryClient, snapshot: ThreadSnapshot | undefined): void {
  if (!snapshot) return;
  for (const [queryKey, data] of snapshot) {
    queryClient.setQueryData(queryKey, data);
  }
}

interface SendVariables {
  recipientId: string;
  body: string;
  /** The open thread the composer sits in, when there is one. */
  conversationId?: string;
}

/**
 * The key prefix of ONE conversation's thread query. Partial matching (the
 * same mechanism the bare `.key()` prefixes rely on) selects exactly that
 * conversation's pages — never another thread's cache, which a bare
 * `thread.key()` would also hit.
 */
function threadKeyOf(conversationId: string) {
  return orpc.message.thread.key({ input: { conversationId } });
}

/**
 * Sends one message. Inside an open thread the row appends optimistically and
 * rolls back on refusal; on success the server's row replaces every pending
 * one — reconciliation, not refetch, the response is authoritative — and the
 * inbox list re-derives from the server (its ordering is the conversation's,
 * which the client can patch toward but not re-sort honestly).
 *
 * Every cache write is scoped to the destination conversation's key: the
 * thread family holds one query per conversation, and an unscoped prefix
 * would append this message to every cached thread. Reconciliation is also
 * idempotent by server id — the SSE push can refetch the committed message
 * into the cache before the send response lands, and prepending it twice
 * would show the same row side by side.
 */
export const sendMessageAtom = atomWithMutation<
  SentMessage,
  SendVariables,
  Error,
  { snapshot: ThreadSnapshot | undefined }
>((get) => {
  const queryClient = get(queryClientAtom);
  const viewerId = get(viewerIdAtom);

  return {
    ...orpc.message.send.mutationOptions(),
    onMutate: ({ conversationId, body }) => {
      if (!conversationId || !viewerId) return { snapshot: undefined };
      const key = threadKeyOf(conversationId);
      void queryClient.cancelQueries({ queryKey: key });
      const snapshot = snapshotOf(queryClient, key);
      queryClient.setQueriesData<ThreadCache>({ queryKey: key }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page, index) =>
                index === 0
                  ? {
                      ...page,
                      // The optimistic id is discarded on reconciliation;
                      // `pending` is what the success path keys on.
                      items: [
                        {
                          id: `optimistic-${crypto.randomUUID()}`,
                          senderId: viewerId,
                          body,
                          createdAt: new Date(),
                          deletedAt: null,
                          pending: true,
                        },
                        ...page.items,
                      ],
                    }
                  : page,
              ),
            }
          : data,
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      restoreSnapshot(queryClient, context?.snapshot);
    },
    onSuccess: (message) => {
      const key = threadKeyOf(message.conversationId);
      queryClient.setQueriesData<ThreadCache>({ queryKey: key }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page, index) =>
                index === 0
                  ? {
                      ...page,
                      items: [
                        { ...message, deletedAt: null },
                        // Drop the optimistic row AND any copy the SSE-driven
                        // refetch may already have landed — one message, once.
                        ...page.items.filter((item) => !item.pending && item.id !== message.id),
                      ],
                    }
                  : page,
              ),
            }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: orpc.message.conversations.key() });
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});

interface DeleteMessageVariables {
  messageId: string;
}

/**
 * Tombstones the caller's own message: the thread row's body redacts and the
 * tombstone marker lands optimistically, rolling back only if the server
 * refuses. The badge and the inbox previews refresh from the server — a
 * tombstone can retire an unread message, which the client cannot derive.
 */
export const deleteMessageAtom = atomWithMutation<
  { id: string; conversationId: string; deletedAt: Date | null },
  DeleteMessageVariables,
  Error,
  { snapshot: ThreadSnapshot }
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.deleteMessage.mutationOptions(),
    onMutate: ({ messageId }) => {
      const key = orpc.message.thread.key();
      void queryClient.cancelQueries({ queryKey: key });
      const snapshot = snapshotOf(queryClient, key);
      queryClient.setQueriesData<ThreadCache>({ queryKey: key }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === messageId
                    ? { ...item, body: null, deletedAt: item.deletedAt ?? new Date() }
                    : item,
                ),
              })),
            }
          : data,
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      restoreSnapshot(queryClient, context?.snapshot);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.message.conversations.key() });
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});

interface MarkReadVariables {
  conversationId: string;
  lastSeenMessageId: string;
}

/**
 * Advances the thread's read cursor through the newest DISPLAYED message.
 * The list row's unread count and cursor patch from the mutation's
 * authoritative answer; the badge refetches (it sums every conversation, and
 * one row's change does not derive the new total).
 */
export const markThreadReadAtom = atomWithMutation<
  { lastReadAt: Date | null; advanced: boolean },
  MarkReadVariables,
  Error
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.markRead.mutationOptions(),
    onSuccess: (result, variables) => {
      queryClient.setQueriesData<InboxCache>(
        { queryKey: orpc.message.conversations.key() },
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.conversationId === variables.conversationId
                      ? { ...item, unreadCount: 0, lastReadAt: result.lastReadAt }
                      : item,
                  ),
                })),
              }
            : data,
      );
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});

/** The requests feed's optimistic removal — shared by accept and decline. */
function removeRequestRow(queryClient: QueryClient, conversationId: string): ThreadSnapshot {
  const key = orpc.message.requests.key();
  void queryClient.cancelQueries({ queryKey: key });
  const snapshot = snapshotOf(queryClient, key);
  queryClient.setQueriesData<RequestsCache>({ queryKey: key }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.conversationId !== conversationId),
          })),
        }
      : data,
  );
  return snapshot;
}

/**
 * Accepts a request: the row leaves the requests feed optimistically; the
 * inbox and both counts re-derive from the server.
 */
export const acceptRequestAtom = atomWithMutation<
  { conversationId: string },
  { conversationId: string },
  Error,
  { snapshot: ThreadSnapshot }
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.accept.mutationOptions(),
    onMutate: ({ conversationId }) => ({ snapshot: removeRequestRow(queryClient, conversationId) }),
    onError: (_error, _variables, context) => {
      restoreSnapshot(queryClient, context?.snapshot);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.message.conversations.key() });
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});

/**
 * Declines a request: the row leaves the feed and stays gone — silently; the
 * sender's side never learns. Idempotent server-side.
 */
export const declineRequestAtom = atomWithMutation<
  { conversationId: string },
  { conversationId: string },
  Error,
  { snapshot: ThreadSnapshot }
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.decline.mutationOptions(),
    onMutate: ({ conversationId }) => ({ snapshot: removeRequestRow(queryClient, conversationId) }),
    onError: (_error, _variables, context) => {
      restoreSnapshot(queryClient, context?.snapshot);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});

/** Hides a conversation from the inbox — the thread pane's "hide" action. */
export const hideConversationAtom = atomWithMutation<
  { conversationId: string },
  { conversationId: string },
  Error
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.hide.mutationOptions(),
    onSuccess: (_result, variables) => {
      queryClient.setQueriesData<InboxCache>(
        { queryKey: orpc.message.conversations.key() },
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  items: page.items.filter(
                    (item) => item.conversationId !== variables.conversationId,
                  ),
                })),
              }
            : data,
      );
      messageThreadFamily.remove(variables.conversationId);
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});
