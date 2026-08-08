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
 *
 * This module is a pure factory — it does not instantiate a limiter of its
 * own. `context.ts` owns the one instance production procedures share
 * (created once, threaded onto every `Context` via `createContext`), and
 * `testing/harness.ts` owns a separate one scoped to the test run. Neither
 * has to import the other's, which is what makes a test's rate-limit state
 * fully independent of anything the request layer does.
 */

/** A per-caller budget for one named operation. */
export interface RateLimitPolicy {
  /** Namespaces the counter, so a caller's writes and reads don't share one. */
  name: string;
  /** Requests allowed per window, per caller. */
  limit: number;
  windowMs: number;
}

/** The verdict of one `consume` call. */
export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window; 0 once the limit is hit. */
  remaining: number;
  /** Seconds until the window rolls over, for a Retry-After style hint. */
  retryAfterSeconds: number;
}

/** The counter procedures consume budget from and tests substitute. */
export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy): RateLimitResult;
  /** Drops all counters. Exposed for tests and for a deliberate operational reset. */
  clear(): void;
  readonly size: number;
}

/** Creates an in-memory fixed-window rate limiter. */
export function createRateLimiter(
  options: {
    /** Injectable so tests can advance time without sleeping. */
    now?: () => number;
    /**
     * Soft ceiling on tracked keys, kept as a memory backstop rather than an
     * admission gate. Every caller is a signed-in user keyed on
     * `${policy.name}:user:<id>` (issue #36 removed the anonymous surface and
     * its IP keying), so the keyspace is bounded by registered users times
     * the 9 policies in `RATE_LIMITS` — it can no longer be grown without
     * limit by an attacker spraying requests from many addresses. What
     * `maxKeys` now guards against is a leak: if some caller shape ever kept
     * producing distinct keys that never expire, this is what would surface
     * it (see below) before the map grows unbounded.
     *
     * At capacity, a brand-new key is let through anyway (`allowed` still
     * follows the caller's own policy limit, just like any other key) — see
     * issue #60. Refusing it, as this used to do, punished exactly the wrong
     * caller: it turned "the map is full" into "brand-new sessions get 429
     * on every single request," indistinguishable from a bug to the person
     * hitting it, to defend a keyspace nothing can grow on purpose anymore.
     * The limiter's job is bounding one client's damage, not gatekeeping who
     * gets to make requests at all. A returning caller whose own window
     * expired still recycles its slot without touching the ceiling either
     * way.
     */
    maxKeys?: number;
  } = {},
): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  // Latches the capacity warning so a sustained episode logs once instead of
  // once per request — see the log call below for why it fires at all.
  //
  // It re-arms (sets back to false) the moment the map is observed below
  // maxKeys again, rather than staying latched for the rest of the process.
  // Sweeping only ever runs from inside a full-map insert attempt, so a real
  // capacity episode can only recur at roughly the pace of the longest
  // tracked window — re-arming can't turn this into a flood. Latching
  // permanently instead would mean the first episode after boot is the only
  // one anyone ever hears about; every later one (arguably the more
  // worrying case — a leak getting worse, not better) would log nothing.
  let capacityWarned = false;

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
        existing && existing.resetAt > at ? existing : { count: 0, resetAt: at + policy.windowMs };

      if (!existing || existing.resetAt <= at) {
        // Only sweep when adding a key, and only once the map has actually
        // grown — an O(n) scan on every request would be worse than the leak.
        if (buckets.size >= maxKeys) sweep(at);

        if (buckets.size >= maxKeys) {
          // Still at capacity after sweeping. Fail OPEN: let a brand-new key
          // through rather than refusing it (issue #60) — `maxKeys` is a
          // memory backstop, not an admission gate, and there is no longer
          // an attacker who can grow this keyspace on purpose (issue #36).
          // A returning caller (`existing !== undefined`) was never refused
          // either way, so it gets no log line of its own.
          if (existing === undefined && !capacityWarned) {
            capacityWarned = true;
            console.warn(
              `[rate-limit] at capacity (${maxKeys} keys) — allowing new keys through unthrottled instead of refusing them; investigate for a leak or raise maxKeys`,
            );
          }
        } else {
          // Below capacity again: rearm so a future episode gets its own
          // log line instead of silence (see the comment on `capacityWarned`).
          capacityWarned = false;
        }
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
  /**
   * Follows and unfollows. The same single indexed insert a like costs, so by
   * cost alone it would share the `like` budget — but `name` is what
   * namespaces the counter, and mass-following is a spam vector in a way
   * mass-liking isn't. A separate bucket means someone burning this one
   * can't also lock themselves out of liking. 60 is high enough that
   * following a full screen of suggestions never trips it.
   */
  follow: { name: "follow", limit: 60, windowMs: MINUTE },
  /** Publishing. Deliberately tight — this is the one that writes rows. */
  write: { name: "write", limit: 15, windowMs: MINUTE },
  /**
   * Avatar and banner uploads. The tightest budget here, because it is the
   * only call that costs megabytes of request body and a round trip to object
   * storage rather than a single indexed insert — and because nobody legitimately
   * changes their avatar ten times a minute.
   *
   * Its own namespace, like `follow`, so someone burning it cannot also lock
   * themselves out of posting: an upload is a `write` by cost, but exhausting a
   * shared budget with one large retry loop would take the composer down with it.
   */
  upload: { name: "upload", limit: 10, windowMs: MINUTE },
  /**
   * Search. An ILIKE scan costs more than the indexed reads the `read` tier
   * serves, and a debounced typeahead legitimately fires several times a
   * second — so search gets its own namespace: a search abuser must not be
   * able to exhaust the `read` budget the feeds depend on. 120 covers the
   * typeahead's bursts with room to spare.
   */
  search: { name: "search", limit: 120, windowMs: MINUTE },
  /**
   * Reporting. One indexed upsert per report, so by cost it could share the
   * `write` tier — but a flood of reports is a moderation nuisance (a queue
   * full of junk), not a data hazard, so it gets its own namespace: someone
   * burning this one must not also lock themselves out of posting.
   */
  report: { name: "report", limit: 20, windowMs: MINUTE },
  /**
   * Blocking. The same shape as `follow` (one indexed insert, a mass-action
   * spam vector), so it gets the same budget by the same reasoning.
   */
  block: { name: "block", limit: 30, windowMs: MINUTE },
  /**
   * Moderation actions — removals, suspensions, bans, resolutions. The most
   * generous of the moderation namespaces on purpose: one moderator working
   * a queue legitimately clears many cases in a minute, and every action
   * also writes an audit row and sends mail, so this one has real per-call
   * cost.
   */
  moderate: { name: "moderate", limit: 60, windowMs: MINUTE },
} as const satisfies Record<string, RateLimitPolicy>;
