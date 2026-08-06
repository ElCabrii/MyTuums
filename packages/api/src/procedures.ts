import { ORPCError, os } from "@orpc/server";
import type { Context } from "./context.js";
import type { RateLimitPolicy } from "./rate-limit.js";
import { roleAtLeast, type UserRole } from "./roles.js";

const base = os.$context<Context>();

/** The session user, once a session is guaranteed to exist — what `protectedProcedure` adds to `context.user`. */
type SessionUser = NonNullable<Context["session"]>["user"];

/**
 * Throttles a procedure per signed-in caller, keyed on `user:<id>`.
 *
 * There is no anonymous surface left to fall back to an IP-keyed bucket for —
 * every procedure in this app requires a session (see `protectedProcedure`
 * below; issue #36). This is typed against a context that already carries
 * `user`, not the bare `Context`, so a procedure that tried to rate-limit
 * without going through `protectedProcedure` first would fail to compile
 * rather than silently keying on `undefined`.
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
  return os
    .$context<Context & { user: SessionUser }>()
    .middleware(({ context, next }) => {
      const result = context.rateLimiter.consume(`${policy.name}:user:${context.user.id}`, policy);

      if (!result.allowed) {
        throw new ORPCError("TOO_MANY_REQUESTS", {
          message: "You're doing that too fast. Try again in a moment.",
          data: { retryAfterSeconds: result.retryAfterSeconds },
        });
      }

      return next();
    });
}

/**
 * The base procedure plus a session requirement; handlers receive the session
 * user as `context.user`. Every procedure in this app is built from this —
 * there is no anonymous surface (issue #36; `publicProcedure` used to sit
 * here for the five/eight reads that stayed public, and is now gone).
 */
export const protectedProcedure = base.use(({ context, next }) => {
  if (!context.session?.user) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { ...context, user: context.session.user } });
});

/**
 * Denies with FORBIDDEN when the caller's role is below the minimum.
 *
 * Built on `protectedProcedure`, so the session requirement is inherited.
 * The role arrives typed on `session.user.role` from the admin plugin
 * (packages/auth/src/index.ts) — no `additionalFields` wiring. The
 * `?? "user"` is defensive: the column has a database default, so a missing
 * value can only mean a row written before the plugin landed, and the
 * weakest role is the safe read for it.
 *
 * These are the only three gates the moderation router uses; every procedure
 * in packages/api/src/moderation.ts is built from one of them plus
 * `rateLimit`. Deny here is a 403, not a 401 — the caller exists and is
 * signed in, this is just not their desk (see ./roles.ts for the ordering).
 */
function requireRole(minRole: UserRole) {
  return protectedProcedure.use(({ context, next }) => {
    if (!roleAtLeast(context.user.role ?? "user", minRole)) {
      throw new ORPCError("FORBIDDEN");
    }
    return next();
  });
}

/** Moderator and above (moderator, staff, admin). */
export const moderatorProcedure = requireRole("moderator");

/** Staff and above (staff, admin). */
export const staffProcedure = requireRole("staff");

/** Admin only. */
export const adminProcedure = requireRole("admin");
