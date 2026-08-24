import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "jotai";
import { queryClientAtom } from "jotai-tanstack-query";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { waitFor } from "@testing-library/react";

const fakeClient = {
  user: {
    follow: vi.fn(),
    unfollow: vi.fn(),
    byUsername: vi.fn(),
    followers: vi.fn(),
    following: vi.fn(),
  },
  post: { list: vi.fn() },
  // The follow-cache sweep now also walks `orpc.search.users.key()`, so a
  // missing group here throws inside every follow mutation — mirroring the
  // `search` group like.test.ts already carries.
  search: { typeahead: vi.fn(), users: vi.fn(), posts: vi.fn() },
};

installTestOrpc(createTanstackQueryUtils(fakeClient));

// The fake client is module-scoped and shared across tests; reset every mock
// before each test so an implementation set by one test can't leak into the
// next (order-independence).
beforeEach(() => {
  fakeClient.user.follow.mockReset();
  fakeClient.user.unfollow.mockReset();
  fakeClient.user.byUsername.mockReset();
  fakeClient.user.followers.mockReset();
  fakeClient.user.following.mockReset();
  fakeClient.post.list.mockReset();
  fakeClient.search.typeahead.mockReset();
  fakeClient.search.users.mockReset();
  fakeClient.search.posts.mockReset();
});

import {
  orpc,
  type Profile,
  type SearchUser,
  type SearchUsersPage,
  type UserListPage,
  type UserSummary,
} from "@/lib/orpc";
import { readCachedIsFollowing } from "@/lib/follow-cache";
import { postListQueryOptions } from "@/lib/query-definitions";
import { clearFollowFamilies, toggleFollowAtomFamily } from "@/atoms/follow";
import { sessionAtom } from "@/atoms/session";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { installTestOrpc } from "@/lib/orpc";

function makeProfile(overrides: Partial<Profile> & { id: string; username: string }): Profile {
  return {
    name: overrides.username,
    displayUsername: overrides.username,
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    followerCount: 0,
    followingCount: 0,
    viewerIsFollowing: false,
    // The suspension flag (issue #38): never suspended by default.
    suspended: false,
    ...overrides,
  };
}

// `Profile["username"]` is nullable (BetterAuth only fills it once the
// username plugin has normalised one), but every fixture here sets it — the
// coercion keeps the call sites free of non-null assertions.
const profileKey = (username: string | null) =>
  orpc.user.byUsername.key({ input: { username: username ?? "" } });

function makeSearchUser(
  overrides: Partial<SearchUser> & { id: string; username: string },
): SearchUser {
  return {
    name: overrides.username,
    displayUsername: overrides.username,
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    viewerIsFollowing: false,
    ...overrides,
  };
}

function searchUsersPage(items: SearchUser[]): InfiniteData<SearchUsersPage> {
  return { pages: [{ items, nextCursor: null }], pageParams: [undefined] };
}

function makeSummary(
  overrides: Partial<UserSummary> & { id: string; username: string },
): UserSummary {
  return {
    name: overrides.username,
    displayUsername: overrides.username,
    image: null,
    bio: null,
    bannerImage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    followedAt: new Date("2026-01-02T00:00:00.000Z"),
    viewerIsFollowing: false,
    ...overrides,
  };
}

function listPage(items: UserSummary[]): InfiniteData<UserListPage> {
  return { pages: [{ items, nextCursor: null }], pageParams: [undefined] };
}

function freshStoreWithTarget(profile: Profile) {
  const store = createStore();
  const queryClient = new QueryClient();
  store.set(queryClientAtom, queryClient);
  // A signed-in viewer, distinct from the target, so `follow:` scope tests
  // have a real viewer id to prove is absent.
  // SAFETY: partial session fixture — the atoms read only the viewer id.
  store.set(sessionAtom, {
    data: { user: { id: "viewer-1" } },
    isPending: false,
  } as never);
  queryClient.setQueryData(profileKey(profile.username), profile);
  return { store, queryClient };
}

describe("toggleFollowAtomFamily", () => {
  it("lands the optimistic patch synchronously, before the mutationFn resolves", () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({
        id: "target-1",
        username: "target",
        followerCount: 5,
        viewerIsFollowing: false,
      }),
    );
    fakeClient.user.follow.mockImplementation(() => new Promise(() => {}));

    store.set(toggleFollowAtomFamily("target-1"));

    const profile = queryClient.getQueryData<Profile>(profileKey("target"));
    expect(profile?.viewerIsFollowing).toBe(true);
    expect(profile?.followerCount).toBe(6);
  });

  // Same reasoning as `atoms/like.ts`: rollback rides on a MUTATION-LEVEL
  // `onError`, because `toggleFollowAtomFamily` is write-only and this test
  // never mounts (`store.sub`) anything — a per-call `onError` would be
  // gated on `hasListeners()` and would silently never run.
  it("rolls back a rejected mutation", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({
        id: "target-1",
        username: "target",
        followerCount: 5,
        viewerIsFollowing: false,
      }),
    );
    fakeClient.user.follow.mockRejectedValue(new Error("network down"));

    store.set(toggleFollowAtomFamily("target-1"));
    expect(queryClient.getQueryData<Profile>(profileKey("target"))?.viewerIsFollowing).toBe(true);

    await waitFor(() => {
      expect(queryClient.getQueryData<Profile>(profileKey("target"))?.viewerIsFollowing).toBe(
        false,
      );
    });
    expect(queryClient.getQueryData<Profile>(profileKey("target"))?.followerCount).toBe(5);
  });

  it("drops a superseded response instead of flickering the UI back", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({
        id: "target-1",
        username: "target",
        followerCount: 5,
        viewerIsFollowing: false,
      }),
    );

    let resolveFollow!: (value: {
      userId: string;
      followerCount: number;
      viewerIsFollowing: boolean;
    }) => void;
    fakeClient.user.follow.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFollow = resolve;
        }),
    );
    fakeClient.user.unfollow.mockImplementation(() => new Promise(() => {}));

    // Follow, then unfollow before the round trip resolves. Same scope means
    // unfollow's mutationFn cannot run until follow's settles.
    store.set(toggleFollowAtomFamily("target-1"));
    store.set(toggleFollowAtomFamily("target-1"));
    expect(queryClient.getQueryData<Profile>(profileKey("target"))?.viewerIsFollowing).toBe(false);

    // The mutationFn call is deferred past a microtask boundary, so
    // `resolveFollow` only exists once the promise executor has actually run.
    await waitFor(() => expect(fakeClient.user.follow).toHaveBeenCalled());
    resolveFollow({ userId: "target-1", followerCount: 6, viewerIsFollowing: true });

    await waitFor(() => expect(fakeClient.user.unfollow).toHaveBeenCalled());
    expect(queryClient.getQueryData<Profile>(profileKey("target"))?.viewerIsFollowing).toBe(false);
  });

  it("scopes the mutation to the target user only, with no viewer identity in it", () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({ id: "target-1", username: "target" }),
    );
    fakeClient.user.follow.mockImplementation(() => new Promise(() => {}));

    store.set(toggleFollowAtomFamily("target-1"));

    const scopeIds = queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.options.scope?.id);
    expect(scopeIds).toEqual(["follow:target-1"]);
    // Putting the viewer in the scope would fork the serialisation queue on
    // sign-in — it must never be there, not even as a substring.
    expect(scopeIds.some((id) => id?.includes("viewer-1"))).toBe(false);
  });

  // The direction is read from whichever cache holds the person. A user whose
  // ONLY cached copy is a search result — no profile, no follower list — is
  // still real cached state: with `viewerIsFollowing: true` the button must
  // send `unfollow`. Before search results joined the read path, this computed
  // "nothing cached" -> following=true and re-sent `follow`, so the button
  // could never turn a search-result "Following" back off.
  it("sends unfollow for an already-followed user whose only cached copy is a search result", async () => {
    const store = createStore();
    const queryClient = new QueryClient();
    store.set(queryClientAtom, queryClient);
    // SAFETY: partial session fixture — the atoms read only the viewer id.
    store.set(sessionAtom, {
      data: { user: { id: "viewer-1" } },
      isPending: false,
    } as never);
    queryClient.setQueryData(
      orpc.search.users.key({ input: { q: "target", limit: 20 } }),
      searchUsersPage([
        makeSearchUser({ id: "target-1", username: "target", viewerIsFollowing: true }),
      ]),
    );
    fakeClient.user.follow.mockClear();
    fakeClient.user.unfollow.mockClear();
    fakeClient.user.unfollow.mockImplementation(() => new Promise(() => {}));

    store.set(toggleFollowAtomFamily("target-1"));

    await waitFor(() => expect(fakeClient.user.unfollow).toHaveBeenCalled());
    expect(fakeClient.user.follow).not.toHaveBeenCalled();
  });

  it("reads the follow direction from the cache, so a burst of clicks alternates", () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({ id: "target-1", username: "target", viewerIsFollowing: false }),
    );
    fakeClient.user.follow.mockImplementation(() => new Promise(() => {}));
    fakeClient.user.unfollow.mockImplementation(() => new Promise(() => {}));

    store.set(toggleFollowAtomFamily("target-1"));
    expect(readCachedIsFollowing(queryClient, "target-1")).toBe(true);

    store.set(toggleFollowAtomFamily("target-1"));
    expect(readCachedIsFollowing(queryClient, "target-1")).toBe(false);

    store.set(toggleFollowAtomFamily("target-1"));
    expect(readCachedIsFollowing(queryClient, "target-1")).toBe(true);
  });

  // Issue #127: the optimistic follow patch writes four caches — profile,
  // follower/following lists, and search results — so onMutate must cancel ALL
  // of them before writing, or an in-flight `user.followers` refetch resolves
  // after the patch and overwrites the optimistic flip with pre-click state.
  // Here a stale followers refetch is already in flight; cancelling it is what
  // keeps the optimistic `viewerIsFollowing: true` alive once it resolves.
  it("cancels an in-flight followers refetch so a stale result can't overwrite the optimistic patch", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({
        id: "target-1",
        username: "target",
        followerCount: 5,
        viewerIsFollowing: false,
      }),
    );
    fakeClient.user.follow.mockImplementation(() => new Promise(() => {}));

    // Seed a follower list holding the target (not yet followed), then start a
    // refetch that stays in flight until we resolve it with pre-click state.
    const followersKey = orpc.user.followers.key({ input: { username: "someone" } });
    let resolveStaleRefetch!: (page: InfiniteData<UserListPage>) => void;
    const staleRefetch = new Promise<InfiniteData<UserListPage>>((resolve) => {
      resolveStaleRefetch = resolve;
    });
    queryClient.setQueryData(
      followersKey,
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false })]),
    );
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: followersKey,
      queryFn: () => staleRefetch,
    });
    const inFlight = query.fetch().then(
      () => undefined,
      () => undefined,
    );

    store.set(toggleFollowAtomFamily("target-1"));
    const row = () =>
      queryClient.getQueryData<InfiniteData<UserListPage>>(followersKey)?.pages[0]?.items[0];
    // The optimistic patch flipped the row before the stale refetch resolved.
    expect(row()?.viewerIsFollowing).toBe(true);

    // The stale refetch lands with pre-click state. Because onMutate cancelled
    // it, the resolution must not overwrite the optimistic flip.
    resolveStaleRefetch(
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false })]),
    );
    await inFlight;
    expect(row()?.viewerIsFollowing).toBe(true);
  });

  // Issue #127, rollback half: a rejected mutation must restore pre-click state
  // even when a stale followers refetch was in flight. Cancellation discards
  // the stale refetch (so it can't overwrite the optimistic flip), and the
  // rollback then restores the snapshot's pre-click value. The snapshot is read
  // synchronously after the cancel, so a refetch can't race it — this test
  // proves the cancel and the rollback compose, not that the snapshot is
  // protected from a race.
  it("rolls back to pre-click state when a cancelled followers refetch was in flight", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({
        id: "target-1",
        username: "target",
        followerCount: 5,
        viewerIsFollowing: false,
      }),
    );
    fakeClient.user.follow.mockRejectedValue(new Error("network down"));

    const followersKey = orpc.user.followers.key({ input: { username: "someone" } });
    let resolveStaleRefetch!: (page: InfiniteData<UserListPage>) => void;
    const staleRefetch = new Promise<InfiniteData<UserListPage>>((resolve) => {
      resolveStaleRefetch = resolve;
    });
    queryClient.setQueryData(
      followersKey,
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false })]),
    );
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: followersKey,
      queryFn: () => staleRefetch,
    });
    const inFlight = query.fetch().then(
      () => undefined,
      () => undefined,
    );

    store.set(toggleFollowAtomFamily("target-1"));
    const row = () =>
      queryClient.getQueryData<InfiniteData<UserListPage>>(followersKey)?.pages[0]?.items[0];
    expect(row()?.viewerIsFollowing).toBe(true);

    // Stale refetch resolves with pre-click state; cancellation discards it and
    // the optimistic flip stays until the mutation's own rollback runs.
    resolveStaleRefetch(
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false })]),
    );
    await inFlight;
    expect(row()?.viewerIsFollowing).toBe(true);

    // The rejected mutation rolls the row back to the pre-click value the
    // (uncorrupted) snapshot recorded.
    await waitFor(() => {
      expect(row()?.viewerIsFollowing).toBe(false);
    });
  });

  // The cancel loop covers all four caches, not just `user.followers` — a stale
  // `search.users` refetch must be discarded the same way, or a search result's
  // follow button would flip back to pre-click state once the refetch lands.
  it("cancels an in-flight search.users refetch too", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({
        id: "target-1",
        username: "target",
        followerCount: 5,
        viewerIsFollowing: false,
      }),
    );
    fakeClient.user.follow.mockImplementation(() => new Promise(() => {}));

    const searchKey = orpc.search.users.key({ input: { q: "target", limit: 20 } });
    let resolveStaleRefetch!: (page: InfiniteData<SearchUsersPage>) => void;
    const staleRefetch = new Promise<InfiniteData<SearchUsersPage>>((resolve) => {
      resolveStaleRefetch = resolve;
    });
    queryClient.setQueryData(
      searchKey,
      searchUsersPage([
        makeSearchUser({ id: "target-1", username: "target", viewerIsFollowing: false }),
      ]),
    );
    const query = queryClient.getQueryCache().build(queryClient, {
      queryKey: searchKey,
      queryFn: () => staleRefetch,
    });
    const inFlight = query.fetch().then(
      () => undefined,
      () => undefined,
    );

    store.set(toggleFollowAtomFamily("target-1"));
    const row = () =>
      queryClient.getQueryData<InfiniteData<SearchUsersPage>>(searchKey)?.pages[0]?.items[0];
    expect(row()?.viewerIsFollowing).toBe(true);

    resolveStaleRefetch(
      searchUsersPage([
        makeSearchUser({ id: "target-1", username: "target", viewerIsFollowing: false }),
      ]),
    );
    await inFlight;
    expect(row()?.viewerIsFollowing).toBe(true);
  });

  // Following someone changes which posts belong in the Following feed, and
  // there's no way to synthesise that client-side — so unlike every other
  // cache this module touches, `post.list` has to actually be refetched.
  it("invalidates exactly the Following feed without resetting its rendered rows", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({ id: "target-1", username: "target", viewerIsFollowing: false }),
    );
    const followingKey = postListQueryOptions({ feed: "following" }).queryKey;
    const globalKey = postListQueryOptions({ feed: "global" }).queryKey;
    queryClient.setQueryData(followingKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(globalKey, { pages: [], pageParams: [] });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const resetSpy = vi.spyOn(queryClient, "resetQueries");
    fakeClient.user.follow.mockResolvedValue({
      userId: "target-1",
      followerCount: 1,
      viewerIsFollowing: true,
    });

    store.set(toggleFollowAtomFamily("target-1"));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: followingKey,
        exact: true,
      });
      expect(queryClient.getQueryState(followingKey)?.isInvalidated).toBe(true);
    });
    expect(queryClient.getQueryState(globalKey)?.isInvalidated).toBe(false);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("does not invalidate the post.list queries when the mutation fails", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({ id: "target-1", username: "target", viewerIsFollowing: false }),
    );
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fakeClient.user.follow.mockRejectedValue(new Error("network down"));

    store.set(toggleFollowAtomFamily("target-1"));

    // The rollback runs, but the feed membership never changed, so no refresh.
    await waitFor(() => {
      expect(queryClient.getQueryData<Profile>(profileKey("target"))?.viewerIsFollowing).toBe(
        false,
      );
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("clearFollowFamilies", () => {
  it("empties the exported family — the same user id produces a brand new atom afterwards", () => {
    const before = toggleFollowAtomFamily("user-x");
    clearFollowFamilies();
    expect(toggleFollowAtomFamily("user-x")).not.toBe(before);
  });
});
