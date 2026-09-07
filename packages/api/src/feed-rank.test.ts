import { describe, expect, it } from "vitest";
import { ORPCError } from "@orpc/server";
import { createRankCursorCodec } from "./cursor.js";
import {
  diversifyScores,
  extractRankHashtagKeys,
  rankBucketedNow,
  scorePost,
  type RankFeatures,
} from "./feed-rank.js";

const base: RankFeatures = {
  favoriteGameOverlap: 0,
  replyTopicOverlap: 0,
  authorLikedPosts: 0,
  likedTopicOverlap: 0,
  followsAuthor: false,
  authorRepostedPosts: 0,
  repostedTopicOverlap: 0,
  likeCount: 0,
  repostCount: 0,
  replyCount: 0,
  eventAgeHours: 24,
};

describe("scorePost", () => {
  it("is monotone in every feature", () => {
    const raised: RankFeatures[] = [
      { ...base, favoriteGameOverlap: 1 },
      { ...base, replyTopicOverlap: 1 },
      { ...base, authorLikedPosts: 1 },
      { ...base, likedTopicOverlap: 1 },
      { ...base, followsAuthor: true },
      { ...base, authorRepostedPosts: 1 },
      { ...base, repostedTopicOverlap: 1 },
      { ...base, likeCount: 10 },
      { ...base, repostCount: 5 },
      { ...base, replyCount: 3 },
    ];
    for (const features of raised) {
      expect(scorePost(features)).toBeGreaterThan(scorePost(base));
    }
  });

  it("decays with event age", () => {
    expect(scorePost({ ...base, eventAgeHours: 1 })).toBeGreaterThan(
      scorePost({ ...base, eventAgeHours: 24 }),
    );
    expect(scorePost({ ...base, eventAgeHours: 24 })).toBeGreaterThan(
      scorePost({ ...base, eventAgeHours: 24 * 7 }),
    );
  });

  it("keeps the capped maxima ordered: one favorite game > likes > follow > reposts, topics, popularity", () => {
    const favorite = scorePost({ ...base, favoriteGameOverlap: 1 });
    const likes = scorePost({ ...base, authorLikedPosts: 5, likedTopicOverlap: 3 });
    const follow = scorePost({ ...base, followsAuthor: true });
    const reposts = scorePost({ ...base, authorRepostedPosts: 3, repostedTopicOverlap: 3 });
    const topic = scorePost({ ...base, replyTopicOverlap: 3 });
    expect(favorite).toBeGreaterThan(likes);
    expect(likes).toBeGreaterThan(follow);
    expect(follow).toBeGreaterThan(reposts);
    expect(follow).toBeGreaterThan(topic);
    expect(reposts).toBeGreaterThan(scorePost(base));
  });

  it("shares one cap per category: matching both halves earns no more than saturating one", () => {
    expect(scorePost({ ...base, authorLikedPosts: 5, likedTopicOverlap: 3 })).toBe(
      scorePost({ ...base, authorLikedPosts: 5 }),
    );
    expect(scorePost({ ...base, authorRepostedPosts: 3, repostedTopicOverlap: 3 })).toBe(
      scorePost({ ...base, authorRepostedPosts: 3 }),
    );
    expect(scorePost({ ...base, favoriteGameOverlap: 1 })).toBe(
      scorePost({ ...base, favoriteGameOverlap: 20 }),
    );
  });

  it("caps the popularity total so virality stays tertiary", () => {
    const viral = scorePost({
      ...base,
      likeCount: 1000000,
      repostCount: 100000,
      replyCount: 10000,
    });
    expect(viral - scorePost(base)).toBeLessThanOrEqual(3);
  });
});

describe("extractRankHashtagKeys", () => {
  it("extracts client-linkified tags, lowercased and deduplicated", () => {
    expect(extractRankHashtagKeys(["Playing #DOOM all weekend #doom"])).toEqual(["doom"]);
    expect(extractRankHashtagKeys(["#hades and #celeste!"])).toEqual(["hades", "celeste"]);
    expect(extractRankHashtagKeys(["(#doom)"])).toEqual(["doom"]);
  });

  it("keeps valid generic tags with underscores", () => {
    expect(extractRankHashtagKeys(["#foo_bar"])).toEqual(["foo_bar"]);
  });

  it("never partially matches a longer or malformed token", () => {
    // `#doom2016` is one token, not `#doom` plus noise.
    expect(extractRankHashtagKeys(["#doom2016"])).toEqual(["doom2016"]);
    // An underscored run is one token — its head must not leak as a match.
    expect(extractRankHashtagKeys(["#doom_edition"])).toEqual(["doom_edition"]);
    // A tag running into an accented letter or a hyphen is wholly inert,
    // exactly as the client's trailing boundary check treats it.
    expect(extractRankHashtagKeys(["#café"])).toEqual([]);
    expect(extractRankHashtagKeys(["#doom-way"])).toEqual([]);
  });

  it("respects the client's leading boundaries", () => {
    expect(extractRankHashtagKeys(["a#doom"])).toEqual([]);
    expect(extractRankHashtagKeys(["é#doom"])).toEqual([]);
    expect(extractRankHashtagKeys(["##doom"])).toEqual([]);
  });

  it("excludes URL fragments — the URL match wins", () => {
    expect(extractRankHashtagKeys(["see https://example.com/page#doom"])).toEqual([]);
    expect(extractRankHashtagKeys(["https://example.com/#doom and #hades"])).toEqual(["hades"]);
    expect(extractRankHashtagKeys(["🎮 https://example.com/#doom and #hades"])).toEqual(["hades"]);
  });

  it("rejects overlong tags and ignores bare words and nullish texts", () => {
    expect(extractRankHashtagKeys([`#${"a".repeat(100)}`])).toEqual([]);
    expect(extractRankHashtagKeys([`#${"a".repeat(99)}`])).toHaveLength(1);
    expect(extractRankHashtagKeys(["doom", null, undefined, "no tags", "#"])).toEqual([]);
  });
});

describe("diversifyScores", () => {
  const entry = (id: string, author: string, score: number) => ({ id, author, score });

  it("demotes a repeat author below a close third party, mildly", () => {
    const ordered = [entry("a1", "a", 10), entry("a2", "a", 9.5), entry("b1", "b", 9)];
    const diversified = diversifyScores(ordered, {
      authorOf: (item) => item.author,
      scoreOf: (item) => item.score,
      keyOf: (item) => item.id,
    });
    expect(diversified.map((item) => item.id)).toEqual(["a1", "b1", "a2"]);
  });

  it("never excludes anyone — no hard cap", () => {
    const ordered = Array.from({ length: 10 }, (_, i) => entry(`a${i}`, "a", 10 - i));
    const diversified = diversifyScores(ordered, {
      authorOf: (item) => item.author,
      scoreOf: (item) => item.score,
      keyOf: (item) => item.id,
    });
    expect(diversified).toHaveLength(10);
  });

  it("breaks penalized ties deterministically by key", () => {
    const ordered = [entry("b", "a", 10), entry("a", "b", 10)];
    const diversified = diversifyScores(ordered, {
      authorOf: (item) => item.author,
      scoreOf: (item) => item.score,
      keyOf: (item) => item.id,
    });
    expect(diversified.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("rankBucketedNow", () => {
  it("freezes the clock within the bucket", () => {
    const first = new Date("2026-09-07T10:12:00.000Z");
    const second = new Date("2026-09-07T10:48:00.000Z");
    expect(rankBucketedNow(first).getTime()).toBe(rankBucketedNow(second).getTime());
    expect(rankBucketedNow(first).getTime()).toBeLessThan(
      rankBucketedNow(new Date("2026-09-07T11:00:00.000Z")).getTime(),
    );
  });
});

describe("rank cursor codec", () => {
  const codec = createRankCursorCodec();
  const snapshotId = "123e4567-e89b-12d3-a456-426614174000";

  it("round-trips a snapshot and offset", () => {
    expect(codec.decode(codec.encode(snapshotId, 40))).toEqual({ snapshotId, offset: 40 });
  });

  it("refuses malformed cursors and out-of-range offsets", () => {
    for (const raw of ["not-a-cursor", codec.encode(snapshotId, -1)]) {
      let error: unknown;
      try {
        codec.decode(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ORPCError);
      const message = error instanceof ORPCError ? error.message : undefined;
      expect(message).toBe("Malformed pagination cursor.");
    }
  });
});
