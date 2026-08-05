import { ORPCError, os } from "@orpc/server";
import type { Context } from "./context.js";
import type { RateLimitPolicy } from "./rate-limit.js";

const base = os.$context<Context>();

/**
 * Throttles a procedure per caller.
 *
 * Identity is the user id when there is a session and the client IP
 * otherwise, prefixed so a user id can never collide with an IP. A caller we
 * can't identify at all falls into a single shared `ip:unknown` bucket: that
 * bucket is easy for unrelated callers to exhaust between them, but the
 * alternative — treating "no identity" as exempt — would make the limit
 * trivially bypassable, and being throttled is the safer failure.
 *
 * Applied per procedure rather than globally so the budget can match what the
 * call actually costs; see RATE_LIMITS in ./rate-limit.ts.
 *
 * Consumes from `context.rateLimiter` rather than a module-level import —
 * deliberately: this middleware has no opinion on which instance that is or
 * how many callers share it, only that `Context` always carries one. See the
 * doc comment on `Context.rateLimiter` in ./context.ts.
 */
export function rateLimit(policy: RateLimitPolicy) {
  return base.middleware(({ context, next }) => {
    const identity = context.session?.user.id
      ? `user:${context.session.user.id}`
      : `ip:${context.clientIp ?? "unknown"}`;

    const result = context.rateLimiter.consume(`${policy.name}:${identity}`, policy);

    if (!result.allowed) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: "You're doing that too fast. Try again in a moment.",
        data: { retryAfterSeconds: result.retryAfterSeconds },
      });
    }

    return next();
  });
}

/** The base procedure — usable without a session, which is what keeps the public feeds public. */
export const publicProcedure = base;

/**
 * The base procedure plus a session requirement; handlers receive the session
 * user as `context.user`.
 */
export const protectedProcedure = base.use(({ context, next }) => {
  if (!context.session?.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ...context, user: context.session.user } });
});
