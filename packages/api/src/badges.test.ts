import { describe, expect, it } from "vitest";
import {
  BADGE_IDS,
  FOLLOWER_BADGE_TIERS,
  POST_LIKE_BADGE_TIERS,
  badgeFamilyOf,
  displayProfileBadges,
  followerBadgeTierFor,
  postLikeBadgeTierFor,
} from "./badges.js";

/**
 * The catalog IS the contract (issue #308): these thresholds are shared by
 * the server's stamping sites and the browser's rendering, and the
 * `user_badge.badge` check constraint repeats the id list — so a threshold
 * or id that drifts silently changes what profiles display. Pinned here,
 * in the dependency-free module's own unit test, with no database. (The
 * join family's ranks live beside its one writer,
 * packages/db/src/stamp-join-badges.ts, and are pinned by the sign-up
 * integration tests instead.)
 */
describe("badge catalog", () => {
  it("is the thirteen decided badges with the decided thresholds", () => {
    expect(FOLLOWER_BADGE_TIERS).toEqual([
      { id: "popular", threshold: 1_000 },
      { id: "rising_star", threshold: 10_000 },
      { id: "star", threshold: 100_000 },
      { id: "superstar", threshold: 1_000_000 },
      { id: "supernova", threshold: 10_000_000 },
    ]);
    expect(POST_LIKE_BADGE_TIERS).toEqual([
      { id: "noticed", threshold: 10_000 },
      { id: "trendy", threshold: 100_000 },
      { id: "big", threshold: 1_000_000 },
      { id: "exploding", threshold: 10_000_000 },
      { id: "giant", threshold: 100_000_000 },
    ]);
  });

  it("lists every id in canonical display order — the check constraint's copy keeps in step", () => {
    expect(BADGE_IDS).toEqual([
      "popular",
      "rising_star",
      "star",
      "superstar",
      "supernova",
      "noticed",
      "trendy",
      "big",
      "exploding",
      "giant",
      "founder",
      "super_early_access",
      "early_access",
    ]);
  });
});

describe("followerBadgeTierFor", () => {
  it("reads 'more than X followers' literally: the threshold itself earns nothing", () => {
    expect(followerBadgeTierFor(0)).toBeNull();
    expect(followerBadgeTierFor(1_000)).toBeNull();
    expect(followerBadgeTierFor(1_001)).toBe("popular");
  });

  it("returns the highest tier only", () => {
    expect(followerBadgeTierFor(10_001)).toBe("rising_star");
    expect(followerBadgeTierFor(10_000_001)).toBe("supernova");
  });
});

describe("postLikeBadgeTierFor", () => {
  it("earns at strictly above the threshold, highest tier only", () => {
    expect(postLikeBadgeTierFor(10_000)).toBeNull();
    expect(postLikeBadgeTierFor(10_001)).toBe("noticed");
    expect(postLikeBadgeTierFor(100_000_001)).toBe("giant");
  });
});

describe("badgeFamilyOf", () => {
  it("maps every catalog id to its family", () => {
    expect(badgeFamilyOf("popular")).toBe("followers");
    expect(badgeFamilyOf("supernova")).toBe("followers");
    expect(badgeFamilyOf("noticed")).toBe("post-likes");
    expect(badgeFamilyOf("giant")).toBe("post-likes");
    expect(badgeFamilyOf("founder")).toBe("founder");
    expect(badgeFamilyOf("super_early_access")).toBe("join");
    expect(badgeFamilyOf("early_access")).toBe("join");
  });
});

describe("displayProfileBadges", () => {
  it("orders the display set canonically: follower tier, like tier, founder, super-early, early", () => {
    expect(
      displayProfileBadges({
        stampedBadgeIds: ["early_access", "super_early_access", "founder", "giant", "supernova"],
      }),
    ).toEqual(["supernova", "giant", "founder", "super_early_access", "early_access"]);
  });

  it("displays only the highest stamped tier per family, even when lower ones are also stamped", () => {
    expect(
      displayProfileBadges({ stampedBadgeIds: ["noticed", "trendy", "popular", "star"] }),
    ).toEqual(["star", "trendy"]);
  });

  it("ignores ids that are not badges — a stray user_badge row surfaces nowhere", () => {
    expect(displayProfileBadges({ stampedBadgeIds: ["not-a-badge"] })).toEqual([]);
  });

  it("renders an empty set for an account with no rows", () => {
    expect(displayProfileBadges({ stampedBadgeIds: [] })).toEqual([]);
  });
});
