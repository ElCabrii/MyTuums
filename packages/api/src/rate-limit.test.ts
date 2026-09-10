import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, RATE_LIMITS, type RateLimitPolicy } from "./rate-limit.js";

function policy(overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return { name: "t", limit: 3, windowMs: 1000, ...overrides };
}

// House convention (see apps/web/src/lib/media.test.ts,
// apps/web/src/atoms/moderation.test.ts): restore in `afterEach`, not as the
// last line of the test body. A spy stubbed inline and only restored at the
// end of a passing test stays stubbed for every test that runs after a
// failing assertion throws before that line.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRateLimiter", () => {
  it("allows exactly `limit` requests per window and denies the next", () => {
    // No clock movement needed: everything here happens inside one window.
    const limiter = createRateLimiter({ now: () => 0 });
    const p = policy({ limit: 3 });

    expect(limiter.consume("k", p).allowed).toBe(true);
    expect(limiter.consume("k", p).allowed).toBe(true);
    expect(limiter.consume("k", p).allowed).toBe(true);
    expect(limiter.consume("k", p).allowed).toBe(false);
  });

  it("remaining counts down and clamps at 0 instead of going negative", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const p = policy({ limit: 2 });

    expect(limiter.consume("k", p).remaining).toBe(1);
    expect(limiter.consume("k", p).remaining).toBe(0);
    // Both denied calls below must still read 0, not -1/-2 — a caller
    // surfacing this as "requests left" would otherwise print nonsense.
    expect(limiter.consume("k", p).remaining).toBe(0);
    expect(limiter.consume("k", p).remaining).toBe(0);
  });

  it("retryAfterSeconds is 0 while allowed and floors at 1 right at the reset boundary", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock });
    const p = policy({ limit: 1 });

    const first = limiter.consume("k", p); // resetAt = 1000
    expect(first.allowed).toBe(true);
    expect(first.retryAfterSeconds).toBe(0);

    clock = 999; // 1ms before rollover — the raw (resetAt-at)/1000 is tiny
    const second = limiter.consume("k", p);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBe(1);
  });

  it("gives distinct keys independent buckets", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    const p = policy({ limit: 1 });

    expect(limiter.consume("a", p).allowed).toBe(true);
    expect(limiter.consume("a", p).allowed).toBe(false);
    expect(limiter.consume("b", p).allowed).toBe(true);
  });

  it("allows again once the window rolls over", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock });
    const p = policy({ limit: 1 });

    expect(limiter.consume("k", p).allowed).toBe(true);
    expect(limiter.consume("k", p).allowed).toBe(false);

    clock += 1000;
    expect(limiter.consume("k", p).allowed).toBe(true);
  });

  it("permits a 2x burst across a window boundary — documented trade-off, not a bug", () => {
    // rate-limit.ts: "the failure mode of a fixed window is that a caller
    // can burst up to 2x the limit across a window boundary ... irrelevant
    // [for this use case] ... costs one map lookup instead of per-key
    // timers." This pins that trade-off down as intended behaviour.
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock });
    const p = policy({ limit: 3 });

    // Consume the whole budget of window N, with the last two calls landing
    // right at its boundary (clock = 999, resetAt = 1000).
    const first = limiter.consume("k", p);
    clock = 999;
    const second = limiter.consume("k", p);
    const third = limiter.consume("k", p);
    expect([first, second, third].every((r) => r.allowed)).toBe(true);

    // Window rolls over here — only ~1ms of real time has passed.
    clock = 1000;
    const windowNPlus1 = [
      limiter.consume("k", p),
      limiter.consume("k", p),
      limiter.consume("k", p),
    ];
    expect(windowNPlus1.every((r) => r.allowed)).toBe(true);
    // 2 * limit (6) requests allowed across the boundary.
  });

  describe("sweep", () => {
    it("is lazy: an expired key survives until a full map needs to insert a new one", () => {
      let clock = 0;
      const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
      const p = policy({ limit: 5 });

      limiter.consume("a", p); // size 1, resetAt 1000
      limiter.consume("b", p); // size check happens BEFORE this insert (size
      // was 1, not >= maxKeys 2), so no sweep here
      expect(limiter.size).toBe(2);

      clock = 2000; // both "a" and "b" are now well past resetAt
      // Nothing has called consume() since, so nothing has swept — an
      // expired key is not the same as an absent one until something looks.
      expect(limiter.size).toBe(2);

      limiter.consume("c", p); // new key, map is full (size 2 >= maxKeys 2)
      // -> sweep(2000) runs first, drops a and b
      expect(limiter.size).toBe(1);
    });
  });

  describe("maxKeys", () => {
    it("allows a brand-new key through when the map is at capacity with live windows", () => {
      // The clock never moves here: every window must stay live for the map
      // to be genuinely at capacity when the third key arrives.
      const clock = 0;
      const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
      const p = policy({ limit: 3 });

      expect(limiter.consume("a", p).allowed).toBe(true);
      expect(limiter.consume("b", p).allowed).toBe(true);
      expect(limiter.size).toBe(2);

      // "c" is a third tracked key arriving while every window is still
      // live. Issue #60: fail OPEN instead of refusing it — the map is
      // allowed to grow past maxKeys, and "c" gets judged on its own
      // policy limit like any other key (1 of 3 used, so allowed).
      const third = limiter.consume("c", p);
      expect(third.allowed).toBe(true);
      expect(third.remaining).toBe(2);
      expect(limiter.size).toBe(3);
    });

    it("logs the capacity warning once per episode, not once per request", () => {
      const clock = 0;
      const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
      const p = policy({ limit: 10 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      limiter.consume("a", p);
      limiter.consume("b", p);
      expect(warn).not.toHaveBeenCalled();

      // Map is at capacity now; every further brand-new key logs, but only
      // the first one of this episode.
      limiter.consume("c", p);
      limiter.consume("d", p);
      limiter.consume("e", p);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("does not re-log when the map merely wobbles below maxKeys and back within the cooldown", () => {
      // Regression for a real bug: an earlier version re-armed the warning
      // the moment ANY insert observed `buckets.size` dip under `maxKeys`
      // after a sweep. Sweeping only ever runs from inside a full-map insert
      // attempt, so under real traffic sitting near the ceiling, one key
      // expiring is enough to cross that threshold for a single call before
      // the very next insert crosses back — which turned "once per episode"
      // into a flood keyed on map-size noise, not on anything resembling an
      // episode boundary. This test drives exactly that wobble — a clock
      // that ADVANCES, a window that expires mid-episode and drops the map
      // one entry below `maxKeys` — and pins that a single warning survives
      // it as long as the cooldown hasn't elapsed. Under the old
      // size-latched implementation this assertion fails (it logs twice).
      let clock = 0;
      const limiter = createRateLimiter({
        now: () => clock,
        maxKeys: 2,
        capacityWarnCooldownMs: 10_000,
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const long = policy({ limit: 10, windowMs: 1000 });
      // A short-lived bucket, so it alone expires while `long` keys don't —
      // that is what produces a dip of exactly the keys that rolled over,
      // rather than a full drain of everything at once.
      const short = policy({ limit: 10, windowMs: 10 });

      limiter.consume("a", short); // resetAt 10
      limiter.consume("b", short); // resetAt 10
      expect(limiter.size).toBe(2);

      // Map is at capacity (2 >= maxKeys 2): first warning of the episode.
      limiter.consume("c", long); // resetAt 1000
      expect(limiter.size).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);

      // "a" and "b" roll over; the next insert's sweep drops both, leaving
      // only "c" — the map dips to 1, one below maxKeys (2).
      clock = 15;
      limiter.consume("d", long); // resetAt 1015
      expect(limiter.size).toBe(2); // {c, d} — genuinely below capacity for
      // this call (size was 1 pre-insert), not just "at" it.

      // The very next brand-new key puts the map back at capacity. Under the
      // old size-latched behaviour this would log a second time immediately
      // (16ms after the first), because the dip above reset the latch. The
      // cooldown (10s) has not elapsed, so it must not log again.
      clock = 16;
      limiter.consume("e", long);
      expect(limiter.size).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("logs again once the cooldown elapses, even if the map never dips at all", () => {
      // Flip side of the test above: recurrence is tied to elapsed time, not
      // to `buckets.size` ever dropping. A monotonically growing leak — the
      // exact case the original comment worried a permanent latch would go
      // silent on — must still get a fresh log line every cooldown window,
      // even though the map here only ever grows and never dips below
      // maxKeys even once.
      let clock = 0;
      const limiter = createRateLimiter({
        now: () => clock,
        maxKeys: 2,
        capacityWarnCooldownMs: 1000,
      });
      // windowMs far longer than the whole test, so nothing ever expires —
      // the map's growth is the leak, not window turnover.
      const p = policy({ limit: 10, windowMs: 1_000_000 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      limiter.consume("a", p);
      limiter.consume("b", p);
      limiter.consume("c", p); // at capacity (2 >= 2): first warning
      expect(limiter.size).toBe(3);
      expect(warn).toHaveBeenCalledTimes(1);

      clock = 500; // still within the 1000ms cooldown
      limiter.consume("d", p);
      expect(limiter.size).toBe(4);
      expect(warn).toHaveBeenCalledTimes(1);

      clock = 1000; // cooldown has now fully elapsed since t=0
      limiter.consume("e", p);
      expect(limiter.size).toBe(5); // never dipped once — only grew
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it("recycles a returning caller's expired slot even when the map holds a live window", () => {
      let clock = 0;
      const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
      const p = policy({ limit: 3 });

      limiter.consume("a", p); // resetAt 1000
      clock = 500;
      limiter.consume("b", p); // resetAt 1500

      clock = 1200; // "a" expired, "b" still live, map at capacity
      // "a" replaces its own expired entry, which never grows the map —
      // recycling isn't the fail-open path at all, it just doesn't need it.
      expect(limiter.consume("a", p).allowed).toBe(true);
      expect(limiter.size).toBe(2);
    });

    it("lets expired windows free capacity for a brand-new key", () => {
      let clock = 0;
      const limiter = createRateLimiter({ now: () => clock, maxKeys: 2 });
      const p = policy({ limit: 3 });

      limiter.consume("a", p);
      limiter.consume("b", p);
      clock = 1000; // both windows expired (windowMs 1000)

      // Both share one clock, so sweep drops a AND b — the new key lands
      // alone at size 1, and a fourth key fills the map back to capacity.
      expect(limiter.consume("c", p).allowed).toBe(true);
      expect(limiter.size).toBe(1);
      expect(limiter.consume("d", p).allowed).toBe(true);
      expect(limiter.size).toBe(2);
    });
  });

  it("clear() empties the map", () => {
    const limiter = createRateLimiter({ now: () => 0 });
    limiter.consume("a", policy());
    limiter.consume("b", policy());
    expect(limiter.size).toBe(2);

    limiter.clear();
    expect(limiter.size).toBe(0);
  });
});

describe("RATE_LIMITS", () => {
  it("defines fourteen tiers with distinct names", () => {
    const policies = Object.values(RATE_LIMITS);
    expect(policies).toHaveLength(14);
    // Distinct names are the whole mechanism: `name` namespaces the counter, so
    // two tiers sharing one would silently share a budget.
    expect(new Set(policies.map((p) => p.name)).size).toBe(14);
    // And the moderation tiers exist at all — a tier dropped from RATE_LIMITS
    // would unmask the procedure that names it in its `.use(rateLimit(...))`.
    expect(Object.keys(RATE_LIMITS)).toEqual(
      expect.arrayContaining(["report", "block", "moderate", "markRead"]),
    );
  });

  it("gives uploads the tightest budget, and its own counter", () => {
    // An upload costs megabytes of request body and a round trip to object
    // storage, against a single indexed insert for everything else — and
    // exhausting it must not take the composer down too.
    expect(RATE_LIMITS.upload.limit).toBeLessThan(RATE_LIMITS.write.limit);
    expect(RATE_LIMITS.upload.name).not.toBe(RATE_LIMITS.write.name);
  });

  it("keeps follow and like on separate counters even though they cost the same", () => {
    // Both are a single indexed insert, so by cost alone they could share a
    // tier. `name` is what namespaces the counter (rate-limit.ts), and the
    // split exists specifically so someone burning through the follow
    // budget with mass-follow spam can't also get locked out of liking.
    expect(RATE_LIMITS.follow.name).not.toBe(RATE_LIMITS.like.name);
  });
});
