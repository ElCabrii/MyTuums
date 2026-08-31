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

const MINUTE = 60_000;

/** Creates an in-memory fixed-window rate limiter. */
export function createRateLimiter(
  options: {
    /** Injectable so tests can advance time without sleeping. */
    now?: () => number;
    /**
     * Threshold past which the map is considered "at capacity" — a leak
     * alarm, not an admission gate, and (see below) not a memory bound
     * either: crossing it does not stop the map from growing, it only makes
     * the limiter log about it.
     *
     * Nearly every caller is a signed-in user keyed on
     * `${policy.name}:user:<id>` (issue #36 removed the anonymous surface and
     * its IP keying). The one exception is `moderation.appealOpen`, which
     * runs signed out and calls `rateLimitCapability`
     * (packages/api/src/procedures.ts) to key on `appeal:<nonce>` or
     * `appeal:<actionId>` instead — a capability the server itself mints and
     * HMAC-signs (`appeal-token.ts`), never one an outside caller can choose.
     * So the keyspace is bounded by registered users times the 10 policies in
     * `RATE_LIMITS`, plus however many appeal capabilities happen to be
     * outstanding at once — all server-issued, none of it grown on purpose by
     * an attacker spraying requests from many addresses. What `maxKeys`
     * guards against is a leak: if some caller shape ever kept producing
     * distinct keys that never expire, crossing this threshold is what would
     * surface it (see below).
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
     * way. The consequence worth stating plainly: nothing now caps how far
     * past `maxKeys` the map can grow — a real leak just keeps growing, this
     * only makes it visible.
     */
    maxKeys?: number;
    /**
     * Minimum time between capacity-warning log lines. Time-based rather than
     * tied to `buckets.size` dipping back under `maxKeys`, because size is
     * noisy right at the threshold: sweeping only ever runs from inside a
     * full-map insert attempt, so under sustained near-capacity traffic one
     * key expiring can put the map momentarily under `maxKeys` and the very
     * next insert can put it right back over — a size-based latch re-arms on
     * that dip and fires again a moment later, which is a flood, not "once
     * per episode". A cooldown keyed on elapsed time instead doesn't care how
     * the size wobbles: it logs again only once this much wall-clock time has
     * passed, whether or not the map ever dipped at all — which also means a
     * leak that only ever grows (never dips) still gets a fresh log line
     * every cooldown window, instead of warning once at boot and then falling
     * silent for good. Defaults to a minute: long enough that a busy episode
     * doesn't spam the log, short enough that a new one is heard from soon
     * after it starts.
     */
    capacityWarnCooldownMs?: number;
  } = {},
): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const capacityWarnCooldownMs = options.capacityWarnCooldownMs ?? MINUTE;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  // -Infinity so the very first capacity episode always logs immediately,
  // regardless of what `now()` returns at boot.
  let lastCapacityWarnAt = -Infinity;

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
          // leak alarm, not an admission gate or a memory bound, and there
          // is no longer an attacker who can grow this keyspace on purpose
          // (issue #36; see the `maxKeys` doc comment above for the
          // appeal-capability exception). A returning caller
          // (`existing !== undefined`) was never refused either way, so it
          // gets no log line of its own.
          if (existing === undefined && at - lastCapacityWarnAt >= capacityWarnCooldownMs) {
            lastCapacityWarnAt = at;
            console.warn(
              `[rate-limit] at capacity (${maxKeys} keys) — allowing new keys through unthrottled instead of refusing them; investigate for a leak or raise maxKeys`,
            );
          }
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
   * Bookmarks. The same single indexed insert a like costs, and no more of a
   * spam vector — the list is private — but `name` namespaces the counter and
   * the two are different habits: someone curating a long saved list in one
   * sitting must not burn through the budget their likes depend on. Own
   * namespace, like `follow`, for that isolation alone.
   */
  bookmark: { name: "bookmark", limit: 120, windowMs: MINUTE },
  /**
   * Follows and unfollows. The same single indexed insert a like costs, so by
   * cost alone it would share the `like` budget — but `name` is what
   * namespaces the counter, and mass-following is a spam vector in a way
   * mass-liking isn't. A separate bucket means someone burning this one
   * can't also lock themselves out of liking. 60 is high enough that
   * following a full screen of suggestions never trips it.
   */
  follow: { name: "follow", limit: 60, windowMs: MINUTE },
  /**
   * Reposts and unreposts. The same single indexed insert a like costs, so by
   * cost alone it would share the `like` budget — but mass-reposting is an
   * amplification vector in a way mass-liking isn't (every repost lands in a
   * follower feed), so it gets its own namespace: someone burning it can't
   * also lock themselves out of liking. The same 60 as `follow`, the other
   * mass-action spam vector with the same per-call cost.
   */
  repost: { name: "repost", limit: 60, windowMs: MINUTE },
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
