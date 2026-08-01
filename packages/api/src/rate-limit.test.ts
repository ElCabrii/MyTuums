import { describe, expect, it } from "vitest";
import { createRateLimiter, type RateLimitPolicy } from "./rate-limit.js";

// Pure unit tests — the limiter holds its state in memory and takes an
// injectable clock, so none of this needs a database or real elapsed time.

const policy: RateLimitPolicy = { name: "test", limit: 3, windowMs: 60_000 };

/** A limiter whose clock this test moves by hand. */
function limiterAt(start = 1_000_000) {
  let clock = start;
  const limiter = createRateLimiter({ now: () => clock });
  return { limiter, advance: (ms: number) => (clock += ms) };
}

describe("createRateLimiter", () => {
  it("allows exactly `limit` requests, then blocks", () => {
    const { limiter } = limiterAt();

    const results = [1, 2, 3, 4].map(() => limiter.consume("a", policy));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it("reports how much budget is left", () => {
    const { limiter } = limiterAt();

    expect(limiter.consume("a", policy).remaining).toBe(2);
    expect(limiter.consume("a", policy).remaining).toBe(1);
    expect(limiter.consume("a", policy).remaining).toBe(0);
    expect(limiter.consume("a", policy).remaining).toBe(0);
  });

  it("counts each key separately", () => {
    const { limiter } = limiterAt();

    for (let i = 0; i < 3; i++) limiter.consume("a", policy);

    expect(limiter.consume("a", policy).allowed).toBe(false);
    expect(limiter.consume("b", policy).allowed).toBe(true);
  });

  it("keeps blocking for the rest of the window", () => {
    const { limiter, advance } = limiterAt();

    for (let i = 0; i < 4; i++) limiter.consume("a", policy);
    advance(policy.windowMs - 1);

    expect(limiter.consume("a", policy).allowed).toBe(false);
  });

  it("starts a fresh window once the old one elapses", () => {
    const { limiter, advance } = limiterAt();

    for (let i = 0; i < 4; i++) limiter.consume("a", policy);
    advance(policy.windowMs);

    const result = limiter.consume("a", policy);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("reports a positive retry-after only once blocked", () => {
    const { limiter, advance } = limiterAt();

    expect(limiter.consume("a", policy).retryAfterSeconds).toBe(0);

    advance(30_000);
    for (let i = 0; i < 3; i++) limiter.consume("a", policy);

    // 60s window opened at t=0, blocked at t=30s.
    expect(limiter.consume("a", policy).retryAfterSeconds).toBe(30);
  });

  it("never reports a retry-after of zero while blocked", () => {
    const { limiter, advance } = limiterAt();

    for (let i = 0; i < 3; i++) limiter.consume("a", policy);
    // Far enough in that the remaining window rounds down to nothing.
    advance(policy.windowMs - 1);

    expect(limiter.consume("a", policy)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
  });

  it("collects rolled-over windows once the key cap is reached", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock, maxKeys: 4 });

    for (let i = 0; i < 4; i++) limiter.consume(`old-${String(i)}`, policy);
    expect(limiter.size).toBe(4);

    clock += policy.windowMs;
    limiter.consume("new", policy);

    // The four expired keys were swept; only the new one survives.
    expect(limiter.size).toBe(1);
  });

  it("clears every counter on demand", () => {
    const { limiter } = limiterAt();

    for (let i = 0; i < 4; i++) limiter.consume("a", policy);
    expect(limiter.consume("a", policy).allowed).toBe(false);

    limiter.clear();

    expect(limiter.size).toBe(0);
    expect(limiter.consume("a", policy).allowed).toBe(true);
  });
});
