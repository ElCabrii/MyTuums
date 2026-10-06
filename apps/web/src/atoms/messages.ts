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
export type ThreadItem = MessageItem & { pending?: boolean; pendingMedia?: PendingMedia };
type ThreadCache = { pages: Array<{ items: ThreadItem[]; nextCursor: string | null }> };
type ThreadSnapshot = Array<[readonly unknown[], ThreadCache | undefined, number]>;
let messageAccessGeneration = 0;

/** Revocation also invalidates rollback snapshots captured by in-flight mutations. */
export function revokeMessageAccess(): void {
  messageAccessGeneration += 1;
}

/** Pending callbacks can outlive logout, so ownership belongs to each invocation. */
interface MessageMutationContext {
  viewerId: string | undefined;
  snapshot?: ThreadSnapshot;
}

/**
 * Direct drafts key by recipient; group drafts key by `group:<conversationId>`.
 * One draft per destination, in memory: it survives the new-message → thread
 * transition (both composers key the same recipient id) instead of being
 * wiped by the remount mid-typing, and it survives leaving and returning to
 * a conversation. Distinct destination keys keep drafts from crossing into
 * another conversation. Swept at
 * sign-out with the rest of the viewer's state.
 */
const messageDrafts = new Map<string, string>();

export function messageDraftFor(recipientId: string): string {
  return messageDrafts.get(recipientId) ?? "";
}

export function setMessageDraft(recipientId: string, body: string): void {
  if (body) messageDrafts.set(recipientId, body);
  else messageDrafts.delete(recipientId);
}

/** Part of the sign-out sweep (`atoms/session-teardown.ts`). */
export function clearMessageDrafts(): void {
  messageDrafts.clear();
}

/**
 * Seeds the destination thread's cache at first contact, so the move from
 * `/messages/new/$userId` to the real thread renders the sent message
 * immediately instead of through a skeleton round-trip; the query's
 * background refetch reconciles with the server right behind it. The key
 * comes from the query options themselves — the one guaranteed-exact shape
 * for the infinite query the thread route mounts.
 */
export function seedFirstMessageThread(
  queryClient: QueryClient,
  conversationId: string,
  user: ConversationItem["user"],
  message: SentMessage,
): void {
  queryClient.setQueryData(messageThreadQueryOptions(conversationId).queryKey, {
    pages: [
      {
        conversationId,
        lastReadAt: null,
        hidden: false,
        group: null,
        user,
        items: [{ ...message, senderName: "", deletedAt: null }],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
}

type InboxCache = { pages: Array<{ items: ConversationItem[] }> };
type RequestsCache = { pages: Array<{ items: MessageRequestItem[] }> };

function snapshotOf(queryClient: QueryClient, queryKey: readonly unknown[]): ThreadSnapshot {
  return queryClient
    .getQueriesData<ThreadCache>({ queryKey })
    .map(([key, data]) => [key, data, messageAccessGeneration]);
}

function restoreSnapshot(queryClient: QueryClient, snapshot: ThreadSnapshot | undefined): void {
  if (!snapshot) return;
  for (const [queryKey, data, generation] of snapshot) {
    if (generation !== messageAccessGeneration) {
      void queryClient.invalidateQueries({ queryKey });
      continue;
    }
    queryClient.setQueryData(queryKey, data);
  }
}

interface SendVariables {
  recipientId?: string;
  body: string;
  /** The open thread the composer sits in, when there is one. */
  conversationId?: string;
  /**
   * The wire shape of `message.send` (one media GROUP per message) plus the
   * conversationId for a group destination. Direct sends retain recipientId;
   * their optional conversationId scopes the optimistic cache.
   */
  images?: File[];
  voice?: File;
  voiceDurationMs?: number;
  videoId?: string;
}

/**
 * What an optimistic row shows while the send is in flight. The real
 * attachments arrive with the server's row; these placeholders only have to
 * say what kind of media is coming.
 */
export type PendingMedia =
  { kind: "images"; count: number } | { kind: "voice"; durationMs: number } | { kind: "video" };

function pendingMediaOf(variables: SendVariables): PendingMedia | undefined {
  if (variables.images?.length) return { kind: "images", count: variables.images.length };
  if (variables.voice) return { kind: "voice", durationMs: variables.voiceDurationMs ?? 0 };
  if (variables.videoId) return { kind: "video" };
  return undefined;
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
  MessageMutationContext
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.send.mutationOptions(),
    onMutate: ({ conversationId, body, ...media }) => {
      const viewerId = get(viewerIdAtom);
      if (!conversationId || !viewerId) return { viewerId };
      const key = threadKeyOf(conversationId);
      void queryClient.cancelQueries({ queryKey: key });
      const snapshot = snapshotOf(queryClient, key);
      const pendingMedia = pendingMediaOf({ body, ...media });
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
                          senderName: "",
                          body,
                          createdAt: new Date(),
                          deletedAt: null,
                          attachments: [],
                          pending: true,
                          pendingMedia,
                        },
                        ...page.items,
                      ],
                    }
                  : page,
              ),
            }
          : data,
      );
      return { snapshot, viewerId };
    },
    onError: (_error, _variables, context) => {
      if (context?.viewerId && get(viewerIdAtom) === context.viewerId)
        restoreSnapshot(queryClient, context.snapshot);
    },
    onSuccess: (message, _variables, context) => {
      if (!context?.viewerId || get(viewerIdAtom) !== context.viewerId) return;
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
                        { ...message, senderName: "", deletedAt: null },
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
  MessageMutationContext
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
                    ? {
                        ...item,
                        body: null,
                        // The projection hides attachments with the body.
                        attachments: [],
                        deletedAt: item.deletedAt ?? new Date(),
                      }
                    : item,
                ),
              })),
            }
          : data,
      );
      return { snapshot, viewerId: get(viewerIdAtom) };
    },
    onError: (_error, _variables, context) => {
      if (context?.viewerId && get(viewerIdAtom) === context.viewerId)
        restoreSnapshot(queryClient, context.snapshot);
    },
    onSuccess: (_message, _variables, context) => {
      if (!context?.viewerId || get(viewerIdAtom) !== context.viewerId) return;
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
  Error,
  MessageMutationContext
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.markRead.mutationOptions(),
    onMutate: () => ({ viewerId: get(viewerIdAtom) }),
    onSuccess: (result, variables, context) => {
      if (!context?.viewerId || get(viewerIdAtom) !== context.viewerId) return;
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
  MessageMutationContext
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.accept.mutationOptions(),
    onMutate: ({ conversationId }) => ({
      snapshot: removeRequestRow(queryClient, conversationId),
      viewerId: get(viewerIdAtom),
    }),
    onError: (_error, _variables, context) => {
      if (context?.viewerId && get(viewerIdAtom) === context.viewerId)
        restoreSnapshot(queryClient, context.snapshot);
    },
    onSuccess: (_request, _variables, context) => {
      if (!context?.viewerId || get(viewerIdAtom) !== context.viewerId) return;
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
  MessageMutationContext
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.decline.mutationOptions(),
    onMutate: ({ conversationId }) => ({
      snapshot: removeRequestRow(queryClient, conversationId),
      viewerId: get(viewerIdAtom),
    }),
    onError: (_error, _variables, context) => {
      if (context?.viewerId && get(viewerIdAtom) === context.viewerId)
        restoreSnapshot(queryClient, context.snapshot);
    },
    onSuccess: (_request, _variables, context) => {
      if (!context?.viewerId || get(viewerIdAtom) !== context.viewerId) return;
      void queryClient.invalidateQueries({ queryKey: messagesUnreadQueryOptions().queryKey });
    },
  };
});

/** Hides a conversation from the inbox — the thread pane's "hide" action. */
export const hideConversationAtom = atomWithMutation<
  { conversationId: string },
  { conversationId: string },
  Error,
  MessageMutationContext
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.message.hide.mutationOptions(),
    onMutate: () => ({ viewerId: get(viewerIdAtom) }),
    onSuccess: (_result, variables, context) => {
      if (!context?.viewerId || get(viewerIdAtom) !== context.viewerId) return;
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
