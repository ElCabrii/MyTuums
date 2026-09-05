import {
  atomWithInfiniteQuery,
  atomWithMutation,
  atomWithQuery,
  queryClientAtom,
} from "jotai-tanstack-query";
import { orpc } from "@/lib/orpc";
import type { NotificationItem } from "@/lib/orpc";
import { notificationsQueryOptions, unreadCountQueryOptions } from "@/lib/query-definitions";

/**
 * The notification surface's client state (issue #259): one feed atom for the
 * `/notifications` page, one count atom for the header badge, one mutation
 * that stamps everything the page just showed as read.
 *
 * There is one list with no scope parameters. Sign-out clears its data with
 * the QueryClient, just like the unread-count query.
 */
export const notificationsFeedAtom = atomWithInfiniteQuery(() => notificationsQueryOptions());

/**
 * The unread badge. Mounts with the header (signed-in chrome only), so the
 * query never fires for a signed-out visitor the server would refuse anyway.
 */
export const unreadCountAtom = atomWithQuery(() => unreadCountQueryOptions());

/**
 * Marks every unread notification read. Fired once by the notifications page
 * on mount; idempotent server-side, so a refresh re-firing it is a no-op that
 * returns zero.
 *
 * On success both caches are PATCHED rather than invalidated: the mutation's
 * own answer is authoritative for exactly the state those caches hold — every
 * loaded row is now read, and the unread count is now zero — so refetching
 * both (what invalidation did, 0.4.0's audit finding) duplicated the page's
 * traffic for data the client can derive. Rows a block or deletion has since
 * hidden stay hidden: patching a row's read flag does not resurrect it.
 */
export const markAllReadAtom = atomWithMutation((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.notification.markRead.mutationOptions(),
    onSuccess: () => {
      // `setQueriesData` (plural) so every infinite-query page count under
      // the bare prefix — however many pages are loaded — flips in one pass.
      queryClient.setQueriesData<{ pages: Array<{ items: NotificationItem[] }> }>(
        { queryKey: orpc.notification.list.key() },
        (data) =>
          data
            ? {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) => ({ ...item, read: true })),
                })),
              }
            : data,
      );
      // The badge's EXACT key — `unreadCountQueryOptions().queryKey`, not
      // the utils' `.key()`: the options-shaped key carries a `type`
      // component the bare key lacks, and `setQueryData` writes only the
      // exact entry the badge observes.
      queryClient.setQueryData(unreadCountQueryOptions().queryKey, { unreadCount: 0 });
    },
  };
});

type NotificationListCache = {
  pages: Array<{ items: NotificationItem[] }>;
  pageParams: unknown[];
};

type NotificationListSnapshot = Array<[readonly unknown[], NotificationListCache | undefined]>;

interface DeleteNotificationVariables {
  id: string;
}

/**
 * Removes one notification row from every loaded list page (issue #330).
 *
 * Optimistic: the row leaves the page on click and returns only if the
 * server refuses. The badge is NOT patched optimistically — its damped tick
 * count cannot be derived from one row (two same-actor rows can share one
 * tick), so success invalidates it and the header refetches the truth.
 * Rollback rides on mutation-level `onError` (see `src/atoms/like.ts`): the
 * action below is write-only, so per-call callbacks would never fire.
 */
export const deleteNotificationAtom = atomWithMutation<
  { success: true; id: string },
  DeleteNotificationVariables,
  Error,
  { snapshot: NotificationListSnapshot }
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.notification.delete.mutationOptions(),
    onMutate: (variables) => {
      const key = orpc.notification.list.key();
      const previous = queryClient.getQueriesData<NotificationListCache>({ queryKey: key });
      const snapshot: NotificationListSnapshot = previous.map(([queryKey, data]) => [
        queryKey,
        data,
      ]);
      queryClient.setQueriesData<NotificationListCache>({ queryKey: key }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== variables.id),
              })),
            }
          : data,
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      for (const [queryKey, data] of context.snapshot) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: unreadCountQueryOptions().queryKey });
    },
  };
});

/**
 * Empties the inbox (issue #330). The list clears optimistically; the badge
 * is authoritative at zero on success — an empty inbox has no ticks under any
 * damping. Same mutation-level rollback contract as the single delete above.
 */
export const clearAllNotificationsAtom = atomWithMutation<
  { deletedCount: number },
  Record<string, never>,
  Error,
  { snapshot: NotificationListSnapshot }
>((get) => {
  const queryClient = get(queryClientAtom);

  return {
    ...orpc.notification.clearAll.mutationOptions(),
    onMutate: () => {
      const key = orpc.notification.list.key();
      const previous = queryClient.getQueriesData<NotificationListCache>({ queryKey: key });
      const snapshot: NotificationListSnapshot = previous.map(([queryKey, data]) => [
        queryKey,
        data,
      ]);
      queryClient.setQueriesData<NotificationListCache>({ queryKey: key }, (data) =>
        data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: [] })) } : data,
      );
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      for (const [queryKey, data] of context.snapshot) {
        queryClient.setQueryData(queryKey, data);
      }
    },
    onSuccess: () => {
      queryClient.setQueryData(unreadCountQueryOptions().queryKey, { unreadCount: 0 });
    },
  };
});
