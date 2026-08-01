import { ORPCError, os } from "@orpc/server";
import type { Context } from "./context.js";
import { rateLimiter, type RateLimitPolicy } from "./rate-limit.js";

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
 */
export function rateLimit(policy: RateLimitPolicy) {
  return base.middleware(({ context, next }) => {
    const identity = context.session?.user.id
      ? `user:${context.session.user.id}`
      : `ip:${context.clientIp ?? "unknown"}`;

    const result = rateLimiter.consume(`${policy.name}:${identity}`, policy);

    if (!result.allowed) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: "You're doing that too fast. Try again in a moment.",
        data: { retryAfterSeconds: result.retryAfterSeconds },
      });
    }

    return next();
  });
}

export const publicProcedure = base;

export const protectedProcedure = base.use(({ context, next }) => {
  if (!context.session?.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ...context, user: context.session.user } });
});
