import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

// `unblockAtom`'s success sweep reads every cache prefix it invalidates
// (`orpc.post.list.key()`, `orpc.search.*.key()`, …) — a fake that only stubs
// `moderation` would leave those accessors undefined and the onSuccess would
// throw, failing the mutation. The fake mirrors the full sweep surface.
const { fakeClient } = vi.hoisted(() => ({
  fakeClient: {
    post: { list: vi.fn(), thread: vi.fn() },
    search: { posts: vi.fn(), users: vi.fn(), typeahead: vi.fn() },
    user: { followers: vi.fn(), following: vi.fn() },
    moderation: { listBlocked: vi.fn(), unblock: vi.fn() },
  },
}));

vi.mock("@/lib/orpc", async () => {
  const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
  return { orpc: createTanstackQueryUtils(fakeClient) };
});

import { orpc, type BlockedUser } from "@/lib/orpc";
import { blockedUsersAtom, unblockAtom } from "@/atoms/moderation";
// `onSuccess` reaches the app's ONE store's client (via `get(queryClientAtom)`
// inside the mutation atom), so the sweep is only observable on the singleton
// wiring — same reasoning as reply-composer.test.ts.
import { store as singletonStore } from "@/lib/store";
import { queryClient as singletonQueryClient } from "@/lib/query-client";

function makeBlockedUser(overrides: Partial<BlockedUser> & { id: string }): BlockedUser {
  return {
    name: "Blocked Person",
    username: "blocked",
    displayUsername: "blocked",
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    blockedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // The blocked list query lives on the singleton client — leaving it cached
  // would leak test 1's row into test 2.
  singletonQueryClient.clear();
  vi.restoreAllMocks();
});

describe("blockedUsersAtom", () => {
  it("loads the viewer's blocked users through the shared query client", async () => {
    fakeClient.moderation.listBlocked.mockResolvedValue({
      items: [makeBlockedUser({ id: "blocked-1" })],
    });

    const unsub = singletonStore.sub(blockedUsersAtom, () => {});
    // Wait for the data itself, not just the call: the fetch starts before
    // the resolved value lands in the atom.
    await waitFor(() => {
      expect(singletonStore.get(blockedUsersAtom).data?.items).toHaveLength(1);
    });
    unsub();
  });

  it("unblocking sweeps the blocked list — the cached row is invalidated, not patched", async () => {
    fakeClient.moderation.listBlocked.mockResolvedValue({
      items: [makeBlockedUser({ id: "blocked-1" })],
    });
    fakeClient.moderation.unblock.mockResolvedValue({ userId: "blocked-1", blocked: false });

    const unsub = singletonStore.sub(blockedUsersAtom, () => {});
    await waitFor(() => {
      expect(singletonStore.get(blockedUsersAtom).data?.items).toHaveLength(1);
    });

    // Fire the write-only mutation atom the same way the settings section
    // does — `useAtomValue(...).mutate(...)`.
    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const mutationUnsub = singletonStore.sub(unblockAtom, () => {});
    singletonStore.get(unblockAtom).mutate({ userId: "blocked-1" });

    // The success sweep must hit the list's own key — the spy pattern from
    // reply-composer.test.ts's post.list/post.thread assertions. Unblocking
    // clears the row server-side, so the mounted list has to refetch rather
    // than be patched (the same reason every viewer-scoped cache is swept).
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.listBlocked.key() }),
    );
    // The transport call carries the input first and an oRPC operation
    // context second — the input is the contract, the context is plumbing.
    expect(fakeClient.moderation.unblock).toHaveBeenCalledWith({ userId: "blocked-1" }, expect.anything());

    // And the invalidation actually refetches the mounted list — the row the
    // settings page renders is gone without any manual refresh.
    await waitFor(() => expect(fakeClient.moderation.listBlocked).toHaveBeenCalledTimes(2));

    unsub();
    mutationUnsub();
  });
});
