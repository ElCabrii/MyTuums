/**
 * Rate limiting for oRPC procedures.
 *
 * BetterAuth's own `rateLimit` (packages/auth/src/index.ts) only covers the
 * `/api/auth/*` routes it serves. Everything under `/rpc` — including every
 * write in this package — was unthrottled, so a single signed-in caller could
 * flood the `post` table as fast as the network allowed. This closes that.
 *
 * Fixed window rather than a token bucket: the failure mode of a fixed window
 * is that a caller can burst up to 2x the limit across a window boundary,
 * which for "stop someone hammering the write path" is irrelevant, and it
 * costs one map lookup instead of per-key timers.
 *
 * State lives in this process's memory, not in Postgres. That is a deliberate
 * trade: the alternative is a database round trip on every single RPC call,
 * to defend a single-container deployment (see docker-compose.yml). The
 * consequences are worth stating plainly — limits reset on deploy, and if the
 * server is ever scaled to N replicas each one keeps its own counters, so the
 * effective limit becomes N x `limit`. Both are fine while the intent is
 * "bound the damage one client can do"; neither is fine if these limits ever
 * become a billing or abuse boundary, at which point this wants to move to
 * Postgres or Redis behind the same `consume` interface.
 */

export interface RateLimitPolicy {
  /** Namespaces the counter, so a caller's writes and reads don't share one. */
  name: string;
  /** Requests allowed per window, per caller. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window; 0 once the limit is hit. */
  remaining: number;
  /** Seconds until the window rolls over, for a Retry-After style hint. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy): RateLimitResult;
  /** Drops all counters. Exposed for tests and for a deliberate operational reset. */
  clear(): void;
  readonly size: number;
}

export function createRateLimiter(
  options: {
    /** Injectable so tests can advance time without sleeping. */
    now?: () => number;
    /**
     * Upper bound on tracked keys. Anonymous callers are keyed by IP, so a
     * spray of requests from many addresses would otherwise grow this map
     * without limit — which would turn the rate limiter itself into the
     * denial-of-service vector it exists to prevent.
     */
    maxKeys?: number;
  } = {},
): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  /** Drops windows that have already rolled over. */
  function sweep(at: number): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  }

  return {
    consume(key, policy) {
      const at = now();
      const existing = buckets.get(key);
      const bucket =
        existing && existing.resetAt > at
          ? existing
          : { count: 0, resetAt: at + policy.windowMs };

      if (!existing || existing.resetAt <= at) {
        // Only sweep when adding a key, and only once the map has actually
        // grown — an O(n) scan on every request would be worse than the leak.
        if (buckets.size >= maxKeys) sweep(at);
        buckets.set(key, bucket);
      }

      bucket.count += 1;

      const allowed = bucket.count <= policy.limit;

      return {
        allowed,
        remaining: Math.max(0, policy.limit - bucket.count),
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - at) / 1000)),
      };
    },

    clear() {
      buckets.clear();
    },

    get size() {
      return buckets.size;
    },
  };
}

/** The limiter the procedures in this package share. */
export const rateLimiter = createRateLimiter();

const MINUTE = 60_000;

/**
 * Per-caller budgets, tiered by what the call costs us rather than one
 * blanket number. Reads are cheap and a busy feed legitimately makes a lot of
 * them; an insert is the thing actually worth protecting.
 */
export const RATE_LIMITS = {
  /** Feed and profile reads. Generous: scrolling paginates. */
  read: { name: "read", limit: 300, windowMs: MINUTE },
  /** Likes. A human can't out-click this; a script can. */
  like: { name: "like", limit: 120, windowMs: MINUTE },
  /** Publishing. Deliberately tight — this is the one that writes rows. */
  write: { name: "write", limit: 15, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitPolicy>;
