import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { orpc, type Profile, type UserListPage, type UserSummary } from "@/lib/orpc";
import {
  patchFollowState,
  readCachedIsFollowing,
  reconcileFollow,
  restoreFollowCaches,
  snapshotFollowCaches,
} from "@/lib/follow-cache";

// Pure `(QueryClient, args) => …` helpers, exercised against a bare client.
// See ./post-cache.test.ts for why this layer carries the coverage.

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "author-1",
    name: "Alex Mercer",
    username: "alexmercer",
    displayUsername: "AlexMercer",
    image: null,
    createdAt: new Date(2026, 7, 15),
    followerCount: 1234,
    followingCount: 42,
    viewerIsFollowing: false,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: "follower-1",
    name: "Sam Vega",
    username: "samvega",
    displayUsername: "SamVega",
    image: null,
    createdAt: new Date(2026, 6, 1),
    followedAt: new Date(2026, 7, 20),
    viewerIsFollowing: false,
    ...overrides,
  };
}

function makeListPage(items: UserSummary[]): InfiniteData<UserListPage> {
  return {
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  };
}

// Prefix-matched keys, as in ./post-cache.test.ts.
const profileKey = (suffix: string) => [...orpc.user.byUsername.key(), suffix];
const followersKey = [...orpc.user.followers.key(), "alexmercer"];
const followingKey = [...orpc.user.following.key(), "alexmercer"];

const TARGET = profileKey("alexmercer");
const VIEWER = profileKey("viewer");

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

describe("readCachedIsFollowing", () => {
  it("prefers the profile cache", () => {
    queryClient.setQueryData(TARGET, makeProfile({ id: "author-1", viewerIsFollowing: true }));

    expect(readCachedIsFollowing(queryClient, "author-1")).toBe(true);
  });

  it("falls back to a follower/following list row", () => {
    queryClient.setQueryData(
      followersKey,
      makeListPage([makeSummary({ id: "follower-1", viewerIsFollowing: true })]),
    );

    expect(readCachedIsFollowing(queryClient, "follower-1")).toBe(true);
  });

  it("returns false when no cache holds this person", () => {
    queryClient.setQueryData(TARGET, makeProfile({ id: "author-1" }));

    expect(readCachedIsFollowing(queryClient, "stranger")).toBe(false);
  });
});

describe("patchFollowState", () => {
  it("moves the target's follower count and flag together", () => {
    queryClient.setQueryData(
      TARGET,
      makeProfile({ id: "author-1", followerCount: 1234, viewerIsFollowing: false }),
    );

    patchFollowState(queryClient, { userId: "author-1", viewerId: "viewer-9", following: true });

    const cached = queryClient.getQueryData<Profile>(TARGET);
    expect(cached?.viewerIsFollowing).toBe(true);
    expect(cached?.followerCount).toBe(1235);
  });

  it("moves the viewer's *following* count, not their follower count", () => {
    // The viewer's own profile may be cached from an earlier visit. Following
    // someone changes how many people *they* follow — their own follower
    // count is untouched.
    queryClient.setQueryData(TARGET, makeProfile({ id: "author-1" }));
    queryClient.setQueryData(
      VIEWER,
      makeProfile({ id: "viewer-9", followerCount: 10, followingCount: 42 }),
    );

    patchFollowState(queryClient, { userId: "author-1", viewerId: "viewer-9", following: true });

    const viewer = queryClient.getQueryData<Profile>(VIEWER);
    expect(viewer?.followingCount).toBe(43);
    expect(viewer?.followerCount).toBe(10);
  });

  it("leaves the viewer's profile alone when no viewerId is known", () => {
    queryClient.setQueryData(VIEWER, makeProfile({ id: "viewer-9", followingCount: 42 }));

    patchFollowState(queryClient, { userId: "author-1", viewerId: undefined, following: true });

    expect(queryClient.getQueryData<Profile>(VIEWER)?.followingCount).toBe(42);
  });

  it("floors counts at zero rather than going negative", () => {
    queryClient.setQueryData(
      TARGET,
      makeProfile({ id: "author-1", followerCount: 0, viewerIsFollowing: true }),
    );
    queryClient.setQueryData(
      VIEWER,
      makeProfile({ id: "viewer-9", followingCount: 0 }),
    );

    patchFollowState(queryClient, { userId: "author-1", viewerId: "viewer-9", following: false });

    expect(queryClient.getQueryData<Profile>(TARGET)?.followerCount).toBe(0);
    expect(queryClient.getQueryData<Profile>(VIEWER)?.followingCount).toBe(0);
  });

  it("patches the person's row in both list caches", () => {
    queryClient.setQueryData(
      followersKey,
      makeListPage([makeSummary({ id: "author-1", viewerIsFollowing: false })]),
    );
    queryClient.setQueryData(
      followingKey,
      makeListPage([makeSummary({ id: "author-1", viewerIsFollowing: false })]),
    );

    patchFollowState(queryClient, { userId: "author-1", viewerId: undefined, following: true });

    for (const key of [followersKey, followingKey]) {
      const cached = queryClient.getQueryData<InfiniteData<UserListPage>>(key);
      expect(cached?.pages[0]?.items[0]?.viewerIsFollowing).toBe(true);
    }
  });

  it("leaves other rows in a list untouched", () => {
    queryClient.setQueryData(
      followersKey,
      makeListPage([
        makeSummary({ id: "author-1", viewerIsFollowing: false }),
        makeSummary({ id: "other-1", viewerIsFollowing: false }),
      ]),
    );

    patchFollowState(queryClient, { userId: "author-1", viewerId: undefined, following: true });

    const items = queryClient.getQueryData<InfiniteData<UserListPage>>(followersKey)?.pages[0]?.items;
    expect(items?.[0]?.viewerIsFollowing).toBe(true);
    expect(items?.[1]?.viewerIsFollowing).toBe(false);
  });
});

describe("snapshotFollowCaches / restoreFollowCaches", () => {
  it("undoes an optimistic edit across profiles and both lists", () => {
    queryClient.setQueryData(
      TARGET,
      makeProfile({ id: "author-1", followerCount: 1234, viewerIsFollowing: false }),
    );
    queryClient.setQueryData(
      followersKey,
      makeListPage([makeSummary({ id: "author-1", viewerIsFollowing: false })]),
    );

    const snapshot = snapshotFollowCaches(queryClient);

    patchFollowState(queryClient, { userId: "author-1", viewerId: undefined, following: true });
    expect(queryClient.getQueryData<Profile>(TARGET)?.followerCount).toBe(1235);

    restoreFollowCaches(queryClient, snapshot);

    expect(queryClient.getQueryData<Profile>(TARGET)?.followerCount).toBe(1234);
    expect(queryClient.getQueryData<Profile>(TARGET)?.viewerIsFollowing).toBe(false);
    expect(
      queryClient.getQueryData<InfiniteData<UserListPage>>(followersKey)?.pages[0]?.items[0]
        ?.viewerIsFollowing,
    ).toBe(false);
  });
});

describe("reconcileFollow", () => {
  it("takes the authoritative count from the response", () => {
    queryClient.setQueryData(
      TARGET,
      makeProfile({ id: "author-1", followerCount: 1235, viewerIsFollowing: true }),
    );

    // The server is the source of truth: the optimistic guess was 1235, but
    // someone else followed at the same time.
    reconcileFollow(queryClient, {
      userId: "author-1",
      followerCount: 1240,
      viewerIsFollowing: true,
    });

    expect(queryClient.getQueryData<Profile>(TARGET)?.followerCount).toBe(1240);
  });

  it("only touches the profile the result names", () => {
    queryClient.setQueryData(TARGET, makeProfile({ id: "author-1", followerCount: 1234 }));
    queryClient.setQueryData(VIEWER, makeProfile({ id: "viewer-9", followerCount: 10 }));

    reconcileFollow(queryClient, {
      userId: "author-1",
      followerCount: 1240,
      viewerIsFollowing: true,
    });

    expect(queryClient.getQueryData<Profile>(VIEWER)?.followerCount).toBe(10);
  });
});
