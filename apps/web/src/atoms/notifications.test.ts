import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { orpc } from "@/lib/orpc";
import {
  clearAllNotificationsAtom,
  deleteNotificationAtom,
  markAllReadAtom,
  notificationsFeedAtom,
} from "@/atoms/notifications";
import { clearViewerState } from "@/atoms/session-teardown";
import { makeNotification } from "@/test/factories";
import type { NotificationItem } from "@/lib/orpc";
import { unreadCountQueryOptions } from "@/lib/query-definitions";
import { store as singletonStore } from "@/lib/store";
import { queryClient as singletonQueryClient } from "@/lib/query-client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

beforeEach(() => {
  fakeClient.notification.markRead.mockReset();
  fakeClient.notification.delete.mockReset();
  fakeClient.notification.clearAll.mockReset();
});

afterEach(() => {
  singletonQueryClient.clear();
  vi.restoreAllMocks();
});

it("loads the next viewer's notifications after sign-out and remount", async () => {
  const previous = makeNotification({ id: "previous-viewer-notification" });
  const current = makeNotification({ id: "current-viewer-notification" });
  fakeClient.notification.list.mockResolvedValue({ items: [previous], nextCursor: null });
  let unsubscribe = singletonStore.sub(notificationsFeedAtom, () => {});

  try {
    await vi.waitFor(() => {
      expect(singletonStore.get(notificationsFeedAtom).data?.pages[0]?.items).toEqual([previous]);
    });
    unsubscribe();
    clearViewerState(singletonQueryClient);
    expect(singletonQueryClient.getQueryCache().getAll()).toEqual([]);

    fakeClient.notification.list.mockResolvedValue({ items: [current], nextCursor: null });
    unsubscribe = singletonStore.sub(notificationsFeedAtom, () => {});
    await vi.waitFor(() => {
      expect(singletonStore.get(notificationsFeedAtom).data?.pages[0]?.items).toEqual([current]);
    });
  } finally {
    unsubscribe();
  }
});

/**
 * The markRead contract (0.4.0 audit finding): opening the notifications page
 * stamped everything read, then INVALIDATED both caches — refetching the list
 * and the badge with data the mutation's own outcome already determines. The
 * atom now patches both caches in place; this pins that no refetch is
 * requested and that the visible state still flips.
 */
describe("markAllReadAtom", () => {
  it("patches every loaded list row read and zeroes the badge, refetching nothing", async () => {
    // SAFETY: the patch walks only `read` off each row; two-row literals
    // carrying exactly that field are honest cache fixtures for it.
    const rows = [
      { id: "n-1", read: false },
      { id: "n-2", read: true },
    ] as NotificationItem[];
    singletonQueryClient.setQueryData(orpc.notification.list.key(), {
      pages: [{ items: rows, nextCursor: null }],
      pageParams: [undefined],
    });
    singletonQueryClient.setQueryData(unreadCountQueryOptions().queryKey, {
      unreadCount: 1,
    });
    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    fakeClient.notification.markRead.mockResolvedValue({ read: 1 });

    const mutation = singletonStore.get(markAllReadAtom);
    await mutation.mutateAsync({});

    // SAFETY: the shape seeded two assertions up — read back through the
    // same key the patch wrote.
    const list = singletonQueryClient.getQueryData(orpc.notification.list.key()) as {
      pages: Array<{ items: NotificationItem[] }>;
    };
    expect(list.pages[0].items.map((item) => item.read)).toEqual([true, true]);
    expect(singletonQueryClient.getQueryData(unreadCountQueryOptions().queryKey)).toEqual({
      unreadCount: 0,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("leaves an empty cache empty rather than inventing pages", async () => {
    fakeClient.notification.markRead.mockResolvedValue({ read: 0 });

    const mutation = singletonStore.get(markAllReadAtom);
    await mutation.mutateAsync({});

    expect(singletonQueryClient.getQueryData(orpc.notification.list.key())).toBeUndefined();
  });
});

/**
 * The delete contract (issue #330): the row leaves every loaded page
 * optimistically and returns on failure; the badge refetches because its
 * damped ticks cannot be derived from one row.
 */
describe("deleteNotificationAtom", () => {
  it("removes the row from the list and invalidates the badge on success", async () => {
    const rows = [makeNotification({ id: "n-1" }), makeNotification({ id: "n-2" })];
    singletonQueryClient.setQueryData(orpc.notification.list.key(), {
      pages: [{ items: rows, nextCursor: null }],
      pageParams: [undefined],
    });
    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const cancelSpy = vi.spyOn(singletonQueryClient, "cancelQueries");
    fakeClient.notification.delete.mockResolvedValue({ success: true, id: "n-1" });

    const mutation = singletonStore.get(deleteNotificationAtom);
    await mutation.mutateAsync({ id: "n-1" });

    // SAFETY: the shape seeded above — read back through the same key the patch wrote.
    const list = singletonQueryClient.getQueryData(orpc.notification.list.key()) as {
      pages: Array<{ items: NotificationItem[] }>;
    };
    expect(list.pages[0].items.map((item) => item.id)).toEqual(["n-2"]);
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: orpc.notification.list.key() });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: unreadCountQueryOptions().queryKey,
    });
  });

  it("restores the row when the server refuses", async () => {
    const rows = [makeNotification({ id: "n-1" }), makeNotification({ id: "n-2" })];
    singletonQueryClient.setQueryData(orpc.notification.list.key(), {
      pages: [{ items: rows, nextCursor: null }],
      pageParams: [undefined],
    });
    fakeClient.notification.delete.mockRejectedValue(new Error("NOT_FOUND"));

    const mutation = singletonStore.get(deleteNotificationAtom);
    await expect(mutation.mutateAsync({ id: "n-1" })).rejects.toThrow("NOT_FOUND");

    // SAFETY: the shape seeded above — read back through the same key the rollback restored.
    const list = singletonQueryClient.getQueryData(orpc.notification.list.key()) as {
      pages: Array<{ items: NotificationItem[] }>;
    };
    expect(list.pages[0].items.map((item) => item.id)).toEqual(["n-1", "n-2"]);
  });
});

/**
 * The clear-all contract (issue #330): every loaded page empties
 * optimistically and the badge is authoritative at zero — an empty inbox has
 * no ticks under any damping.
 */
describe("clearAllNotificationsAtom", () => {
  it("collapses to one empty page with no cursor and zeroes the badge", async () => {
    const first = [makeNotification({ id: "n-1" })];
    const second = [makeNotification({ id: "n-2" })];
    singletonQueryClient.setQueryData(orpc.notification.list.key(), {
      pages: [
        { items: first, nextCursor: "cursor" },
        { items: second, nextCursor: null },
      ],
      pageParams: [undefined, "cursor"],
    });
    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const cancelSpy = vi.spyOn(singletonQueryClient, "cancelQueries");
    fakeClient.notification.clearAll.mockResolvedValue({ deletedCount: 2 });

    const mutation = singletonStore.get(clearAllNotificationsAtom);
    await mutation.mutateAsync({});

    // SAFETY: the shape seeded above — read back through the same key the patch wrote.
    const list = singletonQueryClient.getQueryData(orpc.notification.list.key()) as {
      pages: Array<{ items: NotificationItem[]; nextCursor: string | null }>;
      pageParams: unknown[];
    };
    // One empty page, no cursor: stale per-page cursors must not offer
    // "load more" on an empty inbox.
    expect(list.pages).toEqual([{ items: [], nextCursor: null }]);
    expect(list.pageParams).toEqual([undefined]);
    expect(singletonQueryClient.getQueryData(unreadCountQueryOptions().queryKey)).toEqual({
      unreadCount: 0,
    });
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: orpc.notification.list.key() });
    // The emptied list refetches so post-clear arrivals appear without a remount.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.notification.list.key() });
  });

  it("restores every page when the server refuses", async () => {
    const rows = [makeNotification({ id: "n-1" })];
    singletonQueryClient.setQueryData(orpc.notification.list.key(), {
      pages: [{ items: rows, nextCursor: null }],
      pageParams: [undefined],
    });
    fakeClient.notification.clearAll.mockRejectedValue(new Error("FORBIDDEN"));

    const mutation = singletonStore.get(clearAllNotificationsAtom);
    await expect(mutation.mutateAsync({})).rejects.toThrow("FORBIDDEN");

    // SAFETY: the shape seeded above — read back through the same key the rollback restored.
    const list = singletonQueryClient.getQueryData(orpc.notification.list.key()) as {
      pages: Array<{ items: NotificationItem[] }>;
    };
    expect(list.pages[0].items.map((item) => item.id)).toEqual(["n-1"]);
  });
});
