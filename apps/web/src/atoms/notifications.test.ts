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
  unreadCountAtom,
} from "@/atoms/notifications";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { createTestQueryClient } from "@/test/factories";
import { patchTestSessionUser, setTestSession, signedInSession } from "@/test/auth-fixture";
import { focusManager } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { sessionAtom } from "@/atoms/session";
import { acceptLegalConsentAtom, legalConsentCheckboxAtom } from "@/atoms/legal-consent";
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

it.each([
  { legalAcceptedAt: null, legalVersion: null },
  { legalVersion: "stale" },
  { dateOfBirth: null },
])("#353 holds notification requests until session readiness: %o", async (missing) => {
  setTestSession(signedInSession(missing));
  const store = createStore();
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ queries: { retryDelay: 0 } });
  queryClient.mount();
  store.set(queryClientAtom, queryClient);
  const listSignals: AbortSignal[] = [];
  const countSignals: AbortSignal[] = [];
  fakeClient.notification.list
    .mockReset()
    .mockImplementation((_input, { signal }: { signal: AbortSignal }) => {
      listSignals.push(signal);
      return Promise.resolve({ items: [], nextCursor: null });
    });
  fakeClient.notification.unreadCount
    .mockReset()
    .mockImplementation((_input, { signal }: { signal: AbortSignal }) => {
      countSignals.push(signal);
      return Promise.resolve({ unreadCount: 2 });
    });
  const subscriptions = [
    store.sub(notificationsFeedAtom, () => {}),
    store.sub(unreadCountAtom, () => {}),
  ];
  try {
    await queryClient.invalidateQueries();
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fakeClient.notification.list).not.toHaveBeenCalled();
    expect(fakeClient.notification.unreadCount).not.toHaveBeenCalled();

    const ready = signedInSession().data;
    if (!ready) throw new Error("Expected a signed-in fixture");
    if ("legalVersion" in missing) {
      store.set(legalConsentCheckboxAtom, true);
      vi.mocked(authClient.updateUser).mockImplementationOnce(() => {
        patchTestSessionUser(ready.user);
        return Promise.resolve({ data: {}, error: null });
      });
      await expect(store.set(acceptLegalConsentAtom)).resolves.toBe(true);
    } else {
      patchTestSessionUser(ready.user);
    }
    await vi.waitFor(() => {
      expect(store.get(unreadCountAtom).data).toEqual({ unreadCount: 2 });
      expect(store.get(notificationsFeedAtom).isSuccess).toBe(true);
    });
    // The query adapter can abort its first attempt when enabling; only one
    // surviving request should populate each cache, without a consent reset.
    expect(listSignals.filter((signal) => !signal.aborted)).toHaveLength(1);
    expect(countSignals.filter((signal) => !signal.aborted)).toHaveLength(1);
    const count = fakeClient.notification.unreadCount.mock.calls.length;
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.waitFor(() => {
      expect(fakeClient.notification.unreadCount).toHaveBeenCalledTimes(count + 1);
    });
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    queryClient.unmount();
    focusManager.setFocused(undefined);
    queryClient.clear();
  }
});

it("loads the next viewer's notifications after sign-out and remount", async () => {
  setTestSession(signedInSession());
  const unsubscribeSession = singletonStore.sub(sessionAtom, () => {});
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
    unsubscribeSession();
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
  it("keeps rows read when the initial list response arrives after marking read", async () => {
    setTestSession(signedInSession());
    const store = createStore();
    const queryClient = createTestQueryClient();
    store.set(queryClientAtom, queryClient);
    const row = makeNotification({ id: "late-notification", read: false });
    let resolveList: (value: { items: NotificationItem[]; nextCursor: null }) => void = () => {
      throw new Error("The list request has not started");
    };
    const pendingList = new Promise((resolve) => {
      resolveList = resolve;
    });
    fakeClient.notification.list.mockReset().mockReturnValue(pendingList);
    fakeClient.notification.markRead.mockImplementation(() => {
      fakeClient.notification.list.mockResolvedValue({
        items: [{ ...row, read: true }],
        nextCursor: null,
      });
      return Promise.resolve({ read: 1 });
    });
    const unsubscribe = store.sub(notificationsFeedAtom, () => {});

    try {
      await vi.waitFor(() => expect(fakeClient.notification.list).toHaveBeenCalled());
      await store.get(markAllReadAtom).mutateAsync({});
      resolveList({ items: [row], nextCursor: null });

      await vi.waitFor(() => {
        expect(store.get(notificationsFeedAtom).data?.pages[0]?.items).toEqual([
          { ...row, read: true },
        ]);
      });
      expect(queryClient.getQueryData(unreadCountQueryOptions().queryKey)).toEqual({
        unreadCount: 0,
      });
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

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
