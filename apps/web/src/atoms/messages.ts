import { decryptMessage, encryptMessage, envelopeSchema } from "@my-tuums/message-crypto";
import { messageAccessAtom } from "@/atoms/message-access";
import { m } from "@/paraglide/messages.js";
import type { QueryClient } from "@tanstack/react-query";
import { atomFamily } from "jotai-family";
import {
  atomWithInfiniteQuery,
  atomWithMutation,
  atomWithQuery,
  queryClientAtom,
} from "jotai-tanstack-query";
import { client, orpc } from "@/lib/orpc";
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
  atomWithInfiniteQuery((get) => {
    const local = get(messageAccessAtom).data?.local;
    return {
      ...messageThreadQueryOptions(conversationId),
      enabled: get(protectedProductReadyAtom) && !!local,
      queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
        if (!local) throw new Error("Message keys are locked.");
        const page = await client.message.thread({
          conversationId,
          cursor: pageParam,
        });
        const other = await client.messageKey.identity({ userId: page.user.id });
        const items: Array<MessageItem & { envelope: string | null }> = await Promise.all(
          page.items.map(async (item) => {
            if (!item.envelope || item.deletedAt) return item;
            const sender = item.senderId === local.public.userId ? local.public : other;
            try {
              if (!sender) throw new Error("Sender identity is unavailable.");
              const decrypted = await decryptMessage(
                envelopeSchema.parse(JSON.parse(item.envelope)),
                local,
                sender,
                {
                  id: item.id,
                  senderId: item.senderId,
                  recipientId:
                    item.senderId === local.public.userId ? page.user.id : local.public.userId,
                },
              );
              return { ...item, body: decrypted.message.body, disclosure: decrypted.disclosure };
            } catch {
              return { ...item, body: null, decryptionFailed: true };
            }
          }),
        );
        return { ...page, items };
      },
    };
  }),
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
type ThreadSnapshot = Array<[readonly unknown[], ThreadCache | undefined]>;

/**
 * One draft per RECIPIENT, in memory: it survives the new-message → thread
 * transition (both composers key the same recipient id) instead of being
 * wiped by the remount mid-typing, and it survives leaving and returning to
 * a conversation. Keying by recipient — never conversation — is what keeps a
 * draft typed for one person from ever seeding another's composer. Swept at
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
        user,
        items: [{ ...message, envelope: message.envelope ?? null, deletedAt: null }],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  });
}

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
  /**
   * Media stays on the existing upload path; the mutation encrypts the body
   * and sends only the envelope beside these attachments.
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
  { snapshot: ThreadSnapshot | undefined }
>((get) => {
  const queryClient = get(queryClientAtom);
  const viewerId = get(viewerIdAtom);

  return {
    mutationFn: async ({
      recipientId,
      body,
      images,
      voice,
      voiceDurationMs,
      videoId,
    }: SendVariables): Promise<SentMessage> => {
      const local = get(messageAccessAtom).data?.local;
      if (!local || local.public.userId !== get(viewerIdAtom))
        throw new Error(m.messages_encryption_error());
      const recipient = await client.messageKey.identity({ userId: recipientId });
      if (!recipient) throw new Error(m.messages_recipient_not_ready());
      const id = crypto.randomUUID();
      const envelope = await encryptMessage(
        { version: 1, id, senderId: local.public.userId, recipientId, body },
        local,
        recipient,
      );
      if (local.public.userId !== get(viewerIdAtom)) throw new Error(m.messages_encryption_error());
      const sent = await client.message.send({
        id,
        recipientId,
        envelope,
        images,
        voice,
        voiceDurationMs,
        videoId,
      });
      if (local.public.userId !== get(viewerIdAtom)) throw new Error(m.messages_encryption_error());
      return { ...sent, body };
    },
    onMutate: ({ conversationId, body, ...media }) => {
      if (!conversationId || !viewerId) return { snapshot: undefined };
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
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      if (viewerId && get(viewerIdAtom) === viewerId)
        restoreSnapshot(queryClient, context?.snapshot);
    },
    onSuccess: (message) => {
      if (!viewerId || get(viewerIdAtom) !== viewerId) return;
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
