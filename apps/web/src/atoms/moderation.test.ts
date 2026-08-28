import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `unblockAtom`'s success sweep reads every cache prefix it invalidates
// (`orpc.post.list.key()`, `orpc.search.*.key()`, …) — a fake that only stubs
// `moderation` would leave those accessors undefined and the onSuccess would
// throw, failing the mutation. The fake mirrors the full sweep surface.
const fakeClient = {
  post: { list: vi.fn(), thread: vi.fn() },
  search: { posts: vi.fn(), users: vi.fn(), typeahead: vi.fn() },
  user: { followers: vi.fn(), following: vi.fn(), byUsername: vi.fn() },
  moderation: {
    listBlocked: vi.fn(),
    unblock: vi.fn(),
    banUser: vi.fn(),
    resolve: vi.fn(),
    report: vi.fn(),
    appealReview: vi.fn(),
    // The `invalidateModerationQueries` prefix keys (`queue`/`case`/
    // `auditLog`) and the `team` key are read by the sweeps under test, so
    // the fake must expose them like every other accessor the onSuccess
    // paths touch.
    queue: vi.fn(),
    case: vi.fn(),
    auditLog: vi.fn(),
    team: vi.fn(),
  },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

import { orpc, type BlockedUser } from "@/lib/orpc";
import {
  appealReviewFamily,
  banUserAtom,
  blockedUsersAtom,
  reportAtom,
  resolveAtom,
  unblockAtom,
} from "@/atoms/moderation";
// `onSuccess` reaches the app's ONE store's client (via `get(queryClientAtom)`
// inside the mutation atom), so the sweep is only observable on the singleton
// wiring — same reasoning as reply-composer.test.ts.
import { store as singletonStore } from "@/lib/store";
import { queryClient as singletonQueryClient } from "@/lib/query-client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

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
    await vi.waitFor(() => {
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
    await vi.waitFor(() => {
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
    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.listBlocked.key() }),
    );
    // The profile cache is swept too: blocking from the profile kebab severs
    // the follow server-side, and the page being viewed must not keep lying
    // about follow state (issue #38 review).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.user.byUsername.key() });
    // The transport call carries the input first and an oRPC operation
    // context second — the input is the contract, the context is plumbing.
    expect(fakeClient.moderation.unblock).toHaveBeenCalledWith(
      { userId: "blocked-1" },
      expect.anything(),
    );

    // And the invalidation actually refetches the mounted list — the row the
    // settings page renders is gone without any manual refresh.
    await vi.waitFor(() => expect(fakeClient.moderation.listBlocked).toHaveBeenCalledTimes(2));

    unsub();
    mutationUnsub();
  });
});

describe("moderation action cache sweeps", () => {
  it("banning sweeps the same visibility caches a block does — the moderator's own feeds must drop the target (issue #50)", async () => {
    fakeClient.moderation.banUser.mockResolvedValue({ userId: "bad-actor", banned: true });

    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const mutationUnsub = singletonStore.sub(banUserAtom, () => {});
    singletonStore.get(banUserAtom).mutate({ userId: "bad-actor", reason: "spam" });

    // The moderation sweep first — wait for any one of its keys, then the
    // rest of the calls are already synchronous.
    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.queue.key() }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.case.key() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.auditLog.key() });

    // The point of the shared helper: a ban hides the target from EVERY
    // viewer (`effectivelyBanned`), so the acting moderator's feeds, search
    // and follow caches must refetch — the exact key set `blockAtom` sweeps.
    // Every call carries exactly one argument (the options object), hence the
    // non-null assertion.
    const swept = new Set(invalidateSpy.mock.calls.map(([args]) => args!.queryKey));
    expect(swept).toEqual(
      new Set([
        orpc.moderation.queue.key(),
        orpc.moderation.case.key(),
        orpc.moderation.auditLog.key(),
        orpc.post.list.key(),
        orpc.post.thread.key(),
        orpc.search.posts.key(),
        orpc.search.users.key(),
        orpc.search.typeahead.key(),
        orpc.user.followers.key(),
        orpc.user.following.key(),
        orpc.user.byUsername.key(),
        orpc.moderation.listBlocked.key(),
      ]),
    );

    mutationUnsub();
  });

  it("overturning an appeal sweeps the union of all three inverses — post, visibility, and team (issue #50)", async () => {
    fakeClient.moderation.appealReview.mockResolvedValue({
      appealId: "appeal-1",
      status: "overturned",
    });

    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const mutationUnsub = singletonStore.sub(appealReviewFamily("appeal-1"), () => {});
    singletonStore
      .get(appealReviewFamily("appeal-1"))
      .mutate({ appealId: "appeal-1", outcome: "overturned" });

    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.queue.key() }),
    );

    // The result only says "overturned", not which action was reversed, so
    // the sweep must cover all three: a post removal (post surfaces), a
    // suspension/ban (the full visibility sweep), and a role change (team).
    const swept = new Set(invalidateSpy.mock.calls.map(([args]) => args!.queryKey));
    expect(swept).toEqual(
      new Set([
        orpc.moderation.queue.key(),
        orpc.moderation.case.key(),
        orpc.moderation.auditLog.key(),
        orpc.moderation.team.key(),
        orpc.post.list.key(),
        orpc.post.thread.key(),
        orpc.search.posts.key(),
        orpc.search.users.key(),
        orpc.search.typeahead.key(),
        orpc.user.followers.key(),
        orpc.user.following.key(),
        orpc.user.byUsername.key(),
        orpc.moderation.listBlocked.key(),
      ]),
    );

    mutationUnsub();
  });

  it("resolving a case invalidates the audit log — the action wrote a `case_resolved` row (issue #50)", async () => {
    fakeClient.moderation.resolve.mockResolvedValue({
      targetType: "post",
      targetId: "post-1",
      resolved: 1,
    });

    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const mutationUnsub = singletonStore.sub(resolveAtom, () => {});
    singletonStore
      .get(resolveAtom)
      .mutate({ targetType: "post", targetId: "post-1", outcome: "dismissed" });

    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.auditLog.key() }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.queue.key() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.case.key() });

    mutationUnsub();
  });

  it("reporting refreshes the reporter's own queue (issue #50)", async () => {
    fakeClient.moderation.report.mockResolvedValue({ reported: true });

    const invalidateSpy = vi.spyOn(singletonQueryClient, "invalidateQueries");
    const mutationUnsub = singletonStore.sub(reportAtom, () => {});
    singletonStore
      .get(reportAtom)
      .mutate({ targetType: "post", targetId: "post-1", reason: "spam" });

    await vi.waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: orpc.moderation.queue.key() }),
    );

    mutationUnsub();
  });
});
