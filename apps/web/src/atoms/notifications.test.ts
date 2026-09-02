import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeClient = {
  notification: { list: vi.fn(), unreadCount: vi.fn(), markRead: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { orpc } from "@/lib/orpc";
import { markAllReadAtom } from "@/atoms/notifications";
import type { NotificationItem } from "@/lib/orpc";
import { unreadCountQueryOptions } from "@/lib/query-definitions";
import { store as singletonStore } from "@/lib/store";
import { queryClient as singletonQueryClient } from "@/lib/query-client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

beforeEach(() => {
  fakeClient.notification.markRead.mockReset();
});

afterEach(() => {
  singletonQueryClient.clear();
  vi.restoreAllMocks();
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
