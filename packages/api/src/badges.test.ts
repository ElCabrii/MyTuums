import { describe, expect, it } from "vitest";
import {
  BADGE_IDS,
  EARLY_ACCESS_RANK,
  FOLLOWER_BADGE_TIERS,
  POST_LIKE_BADGE_TIERS,
  STAMPED_BADGE_IDS,
  SUPER_EARLY_ACCESS_RANK,
  badgeFamilyOf,
  displayProfileBadges,
  followerBadgeTierFor,
  joinBadgeIdsFor,
  postLikeBadgeTierFor,
} from "./badges.js";

/**
 * The catalog IS the contract (issue #308): these thresholds are shared by the
 * server's derivation/stamping and the browser's rendering, and the
 * `user_badge.badge` check constraint repeats the stamped subset — so a
 * threshold or id that drifts silently changes what profiles display. Pinned
 * here, in the dependency-free module's own unit test, with no database.
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
    expect(SUPER_EARLY_ACCESS_RANK).toBe(50);
    expect(EARLY_ACCESS_RANK).toBe(1_000);
    expect(BADGE_IDS).toHaveLength(13);
  });

  it("leaves only the post-like tiers and founder stamped — follower tiers and join badges are derived", () => {
    expect(STAMPED_BADGE_IDS).toEqual([
      "noticed",
      "trendy",
      "big",
      "exploding",
      "giant",
      "founder",
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

  it("drops back below a tier — live state, not an achievement", () => {
    expect(followerBadgeTierFor(1_000)).toBeNull();
  });
});

describe("postLikeBadgeTierFor", () => {
  it("earns at strictly above the threshold, highest tier only", () => {
    expect(postLikeBadgeTierFor(10_000)).toBeNull();
    expect(postLikeBadgeTierFor(10_001)).toBe("noticed");
    expect(postLikeBadgeTierFor(100_000_001)).toBe("giant");
  });
});

describe("joinBadgeIdsFor", () => {
  it("ranks the first 50 as super-early (and early), the first 1,000 as early, nothing after", () => {
    expect(joinBadgeIdsFor(0)).toEqual(["super_early_access", "early_access"]);
    expect(joinBadgeIdsFor(49)).toEqual(["super_early_access", "early_access"]);
    expect(joinBadgeIdsFor(50)).toEqual(["early_access"]);
    expect(joinBadgeIdsFor(999)).toEqual(["early_access"]);
    expect(joinBadgeIdsFor(1_000)).toEqual([]);
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
        stampedBadgeIds: ["giant", "noticed", "trendy", "founder"],
        followerCount: 10_000_001,
        creationRank: 3,
      }),
    ).toEqual(["supernova", "giant", "founder", "super_early_access", "early_access"]);
  });

  it("displays only the highest stamped like tier, even when lower ones are also stamped", () => {
    expect(
      displayProfileBadges({
        stampedBadgeIds: ["noticed", "trendy"],
        followerCount: 0,
        creationRank: 1_000,
      }),
    ).toEqual(["trendy"]);
  });

  it("keeps stamped like tiers when the live follower count has no tier, and vice versa", () => {
    expect(
      displayProfileBadges({ stampedBadgeIds: ["noticed"], followerCount: 0, creationRank: 2_000 }),
    ).toEqual(["noticed"]);
    expect(
      displayProfileBadges({ stampedBadgeIds: [], followerCount: 1_001, creationRank: 2_000 }),
    ).toEqual(["popular"]);
  });

  it("ignores ids that are never stamped — a derived id in a user_badge row surfaces nowhere", () => {
    expect(
      displayProfileBadges({
        stampedBadgeIds: ["popular", "early_access", "not-a-badge"],
        followerCount: 0,
        creationRank: 2_000,
      }),
    ).toEqual([]);
  });
});
