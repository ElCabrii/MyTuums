import { describe, expect, it } from "vitest";
import { relationshipLockKey, RELATIONSHIP_LOCK_CLASS } from "./relationship-lock.js";

describe("relationshipLockKey", () => {
  it("gives one key to an unordered pair, whichever way round it is asked", () => {
    // The invariant the whole lock rests on: `follow` writes a directed edge
    // and `block` severs both directions, so they name the pair in opposite
    // orders. If the two orderings hashed differently they would take
    // different locks and never serialize against each other — which is the
    // race, not a fix for it.
    expect(relationshipLockKey("alice", "bob")).toBe(relationshipLockKey("bob", "alice"));
  });

  it("separates pairs that share a member, and pairs whose ids concatenate alike", () => {
    expect(relationshipLockKey("alice", "bob")).not.toBe(relationshipLockKey("alice", "carol"));
    // The delimiter earning its place: without it "ab"+"c" and "a"+"bc" would
    // hash the same input and two unrelated pairs would serialize on one key.
    expect(relationshipLockKey("ab", "c")).not.toBe(relationshipLockKey("a", "bc"));
  });

  it("stays inside the signed 32-bit range pg_advisory_xact_lock's int4 arguments take", () => {
    // A value outside int4 makes PostgreSQL raise at the call site rather than
    // lock anything, so the width is a correctness property of the derivation
    // and not an implementation detail. Ids long and varied enough to drive
    // the hash through its full range.
    const keys = Array.from({ length: 500 }, (_, i) =>
      relationshipLockKey(`user-${i}-${"x".repeat(i % 40)}`, `user-${i * 7 + 1}`),
    );

    for (const key of keys) {
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThanOrEqual(2 ** 31 - 1);
    }
    // Sanity: the hash spreads rather than collapsing onto a few keys.
    expect(new Set(keys).size).toBeGreaterThan(490);
  });

  it("keeps the lock class in int4 too, and out of the bigint post-media namespace", () => {
    // Two-argument advisory locks live in a space PostgreSQL keeps entirely
    // separate from the one-argument bigint form POST_MEDIA_LIFECYCLE_LOCK_KEY
    // uses, so no collision is possible — but the class must still be int4.
    expect(RELATIONSHIP_LOCK_CLASS).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(RELATIONSHIP_LOCK_CLASS).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});
