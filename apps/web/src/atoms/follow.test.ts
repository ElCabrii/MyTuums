import { describe, expect, it, vi } from "vitest";
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

import { orpc, type Profile, type SearchUser, type SearchUsersPage } from "@/lib/orpc";
import { readCachedIsFollowing } from "@/lib/follow-cache";
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

  // Following someone changes which posts belong in the Following feed, and
  // there's no way to synthesise that client-side — so unlike every other
  // cache this module touches, `post.list` has to actually be refetched.
  it("resets the post.list queries once the mutation settles", async () => {
    const { store, queryClient } = freshStoreWithTarget(
      makeProfile({ id: "target-1", username: "target", viewerIsFollowing: false }),
    );
    const resetSpy = vi.spyOn(queryClient, "resetQueries");
    fakeClient.user.follow.mockResolvedValue({
      userId: "target-1",
      followerCount: 1,
      viewerIsFollowing: true,
    });

    store.set(toggleFollowAtomFamily("target-1"));

    await waitFor(() => {
      expect(resetSpy).toHaveBeenCalledWith({ queryKey: orpc.post.list.key() });
    });
  });
});

describe("clearFollowFamilies", () => {
  it("empties the exported family — the same user id produces a brand new atom afterwards", () => {
    const before = toggleFollowAtomFamily("user-x");
    clearFollowFamilies();
    expect(toggleFollowAtomFamily("user-x")).not.toBe(before);
  });
});
