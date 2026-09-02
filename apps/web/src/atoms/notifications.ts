import { atomFamily } from "jotai-family";
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
 * There is exactly one list per viewer and no scope parameters, so the feed
 * is a family keyed on `""` rather than a bare `atomWithInfiniteQuery` — the
 * same single-entry shape `auditLogFamily` uses — purely so sign-out can
 * `remove()` it through the same sweep every other viewer-owned family goes
 * through (`atoms/session-teardown.ts`).
 */
const notificationsFamily = atomFamily(() =>
  atomWithInfiniteQuery(() => notificationsQueryOptions()),
);

/** The viewer's notifications, newest first — the `/notifications` page reads this. */
export const notificationsFeedAtom = notificationsFamily("");

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

/**
 * Removes the feed family's single entry. See `clearPostFeedFamily` in
 * `atoms/post-feed.ts` for why the family stays private behind an
 * all-or-nothing sweep; `clearViewerState` is the only caller.
 */
export function clearNotificationsFamily(): void {
  for (const key of notificationsFamily.getParams()) notificationsFamily.remove(key);
}
