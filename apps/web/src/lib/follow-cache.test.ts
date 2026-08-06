import { describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { orpc, type Profile, type SearchUser, type SearchUsersPage, type UserListPage, type UserSummary } from "@/lib/orpc";
import {
  patchFollowState,
  readCachedIsFollowing,
  reconcileFollow,
  restoreFollowCaches,
  snapshotFollowCaches,
} from "@/lib/follow-cache";

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

function makeSummary(overrides: Partial<UserSummary> & { id: string; username: string }): UserSummary {
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

const profileKey = (username: string) => orpc.user.byUsername.key({ input: { username } });
const followersKey = (username: string) => orpc.user.followers.key({ input: { username } });
const followingKey = (username: string) => orpc.user.following.key({ input: { username } });

describe("patchFollowState", () => {
  it("moves followerCount and flips viewerIsFollowing on the TARGET's profile, and followingCount on the VIEWER's own — never bleeding into each other", () => {
    const queryClient = new QueryClient();
    const target = makeProfile({
      id: "target-1",
      username: "target",
      followerCount: 5,
      followingCount: 2,
      viewerIsFollowing: false,
    });
    const viewer = makeProfile({
      id: "viewer-1",
      username: "viewer",
      followerCount: 3,
      followingCount: 10,
      viewerIsFollowing: false,
    });
    queryClient.setQueryData(profileKey("target"), target);
    queryClient.setQueryData(profileKey("viewer"), viewer);

    patchFollowState(queryClient, { userId: "target-1", viewerId: "viewer-1", following: true });

    const patchedTarget = queryClient.getQueryData<Profile>(profileKey("target"));
    expect(patchedTarget?.followerCount).toBe(6);
    expect(patchedTarget?.viewerIsFollowing).toBe(true);
    // The target's OWN following count is untouched — only their follower count moved.
    expect(patchedTarget?.followingCount).toBe(2);

    const patchedViewer = queryClient.getQueryData<Profile>(profileKey("viewer"));
    expect(patchedViewer?.followingCount).toBe(11);
    // The viewer's follower count and viewerIsFollowing (they don't follow themselves) are untouched.
    expect(patchedViewer?.followerCount).toBe(3);
    expect(patchedViewer?.viewerIsFollowing).toBe(false);
  });

  it("flips viewerIsFollowing on matching search.users rows, touching no counts", () => {
    const queryClient = new QueryClient();
    const searchKey = orpc.search.users.key({ input: { q: "target", limit: 20 } });
    queryClient.setQueryData(
      searchKey,
      searchUsersPage([
        makeSearchUser({ id: "target-1", username: "target", viewerIsFollowing: false }),
        makeSearchUser({ id: "other-1", username: "other", viewerIsFollowing: true }),
      ]),
    );

    patchFollowState(queryClient, { userId: "target-1", viewerId: "viewer-1", following: true });

    const data = queryClient.getQueryData<InfiniteData<SearchUsersPage>>(searchKey);
    expect(data?.pages[0]?.items.find((i) => i.id === "target-1")?.viewerIsFollowing).toBe(true);
    // The other row is untouched, and search rows carry no counts to move.
    expect(data?.pages[0]?.items.find((i) => i.id === "other-1")?.viewerIsFollowing).toBe(true);
  });

  it("clamps followerCount and followingCount at 0 on unfollow", () => {
    const queryClient = new QueryClient();
    const target = makeProfile({ id: "target-1", username: "target", followerCount: 0 });
    const viewer = makeProfile({ id: "viewer-1", username: "viewer", followingCount: 0 });
    queryClient.setQueryData(profileKey("target"), target);
    queryClient.setQueryData(profileKey("viewer"), viewer);

    patchFollowState(queryClient, { userId: "target-1", viewerId: "viewer-1", following: false });

    expect(queryClient.getQueryData<Profile>(profileKey("target"))?.followerCount).toBe(0);
    expect(queryClient.getQueryData<Profile>(profileKey("viewer"))?.followingCount).toBe(0);
  });

  it("patches the matching item in both follower and following list caches, leaving other items alone", () => {
    const queryClient = new QueryClient();
    const target = makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false });
    const other = makeSummary({ id: "other-1", username: "other", viewerIsFollowing: false });

    queryClient.setQueryData(followersKey("someone"), listPage([target, other]));
    queryClient.setQueryData(followingKey("someone-else"), listPage([other, target]));

    patchFollowState(queryClient, { userId: "target-1", viewerId: "viewer-1", following: true });

    const followers = queryClient.getQueryData<InfiniteData<UserListPage>>(
      followersKey("someone"),
    );
    expect(followers?.pages[0]?.items.find((i) => i.id === "target-1")?.viewerIsFollowing).toBe(
      true,
    );
    expect(followers?.pages[0]?.items.find((i) => i.id === "other-1")?.viewerIsFollowing).toBe(
      false,
    );

    const following = queryClient.getQueryData<InfiniteData<UserListPage>>(
      followingKey("someone-else"),
    );
    expect(following?.pages[0]?.items.find((i) => i.id === "target-1")?.viewerIsFollowing).toBe(
      true,
    );
    expect(following?.pages[0]?.items.find((i) => i.id === "other-1")?.viewerIsFollowing).toBe(
      false,
    );
  });
});

describe("readCachedIsFollowing", () => {
  it("reads from the profile cache first", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      profileKey("target"),
      makeProfile({ id: "target-1", username: "target", viewerIsFollowing: true }),
    );
    // A stale/contradictory list entry — profile must win.
    queryClient.setQueryData(
      followersKey("someone"),
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false })]),
    );

    expect(readCachedIsFollowing(queryClient, "target-1")).toBe(true);
  });

  it("falls back to the follower/following list caches when no profile is cached", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      followingKey("someone"),
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: true })]),
    );

    expect(readCachedIsFollowing(queryClient, "target-1")).toBe(true);
  });

  // The search page renders live follow buttons off `search.users` rows
  // (user-list.tsx), and a user who appears ONLY there has no profile or
  // follower-list cache entry yet. The direction must come from that row or
  // every click on a search-result button would be treated as "follow" —
  // making unfollow from search results impossible.
  it("falls back to the search.users cache when the person appears only there", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      orpc.search.users.key({ input: { q: "target", limit: 20 } }),
      searchUsersPage([
        makeSearchUser({ id: "target-1", username: "target", viewerIsFollowing: true }),
      ]),
    );

    expect(readCachedIsFollowing(queryClient, "target-1")).toBe(true);
  });

  it("returns false when the person is in neither cache", () => {
    const queryClient = new QueryClient();
    expect(readCachedIsFollowing(queryClient, "nobody")).toBe(false);
  });
});

describe("snapshot / restore round trip", () => {
  it("restoreFollowCaches undoes a patchFollowState edit", () => {
    const queryClient = new QueryClient();
    const target = makeProfile({ id: "target-1", username: "target", followerCount: 5 });
    queryClient.setQueryData(profileKey("target"), target);
    queryClient.setQueryData(
      followersKey("someone"),
      listPage([makeSummary({ id: "target-1", username: "target", viewerIsFollowing: false })]),
    );

    const before = {
      profile: queryClient.getQueryData(profileKey("target")),
      list: queryClient.getQueryData(followersKey("someone")),
    };

    const snapshot = snapshotFollowCaches(queryClient);
    patchFollowState(queryClient, { userId: "target-1", viewerId: undefined, following: true });

    expect(queryClient.getQueryData<Profile>(profileKey("target"))?.followerCount).toBe(6);

    restoreFollowCaches(queryClient, snapshot);

    expect(queryClient.getQueryData(profileKey("target"))).toEqual(before.profile);
    expect(queryClient.getQueryData(followersKey("someone"))).toEqual(before.list);
  });
});

describe("reconcileFollow", () => {
  it("updates only the profile object, leaving list caches untouched — the response carries no per-row data", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      profileKey("target"),
      makeProfile({ id: "target-1", username: "target", followerCount: 6, viewerIsFollowing: true }),
    );
    const listBefore = listPage([
      makeSummary({ id: "target-1", username: "target", viewerIsFollowing: true }),
    ]);
    queryClient.setQueryData(followersKey("someone"), listBefore);

    // The server's authoritative count differs from whatever the optimistic
    // patch guessed — e.g. a concurrent follow from another session.
    reconcileFollow(queryClient, {
      userId: "target-1",
      followerCount: 42,
      viewerIsFollowing: true,
    });

    const profile = queryClient.getQueryData<Profile>(profileKey("target"));
    expect(profile?.followerCount).toBe(42);
    expect(profile?.viewerIsFollowing).toBe(true);

    expect(queryClient.getQueryData(followersKey("someone"))).toEqual(listBefore);
  });
});
