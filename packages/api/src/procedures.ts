import { ORPCError, os } from "@orpc/server";
import {
  hasCompletedOnboarding,
  hasCurrentLegalConsent,
  LEGAL_CONSENT_REQUIRED_MESSAGE,
  ONBOARDING_REQUIRED_MESSAGE,
} from "@my-tuums/auth/rules";
import type { Context } from "./context.js";
import type { RateLimitPolicy } from "./rate-limit.js";
import { roleAtLeast, type UserRole } from "./roles.js";

const base = os.$context<Context>();

/**
 * The session-less base procedure — the app's one public surface.
 *
 * Every procedure in this app is built from `protectedProcedure` (issue #36);
 * this export is the single exception, used by exactly one procedure
 * (`moderation.appealOpen`), which is capability-gated by an HMAC token
 * rather than by a session — a suspended or banned user cannot sign in, so
 * the appeal link in their email must work signed-out. The hole exists so a
 * banned account can be heard, not as a door: nothing else may build from it.
 *
 * The one procedure that does build from it is not unthrottled for that:
 * `appealOpen` consumes a budget keyed on the capability the caller
 * presented (see `rateLimitCapability` below) — the `rateLimit` middleware
 * cannot apply here because it keys on a session that this procedure has no
 * guarantee of.
 */
export const baseProcedure = base;

/** The session user, once a session is guaranteed to exist — what `protectedProcedure` adds to `context.user`. */
type SessionUser = NonNullable<Context["session"]>["user"];
/**
 * Throttles a procedure per signed-in caller, keyed on `user:<id>`.
 *
 * The one anonymous surface (the public post permalink's reads, 0.4.0) does
 * not fall back to an IP-keyed bucket here — it has its own sibling,
 * `publicRateLimit`, because the two key on different things a caller may or
 * may not have. This is typed against a context that already carries
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
 *
 * The one procedure that runs without a session (`moderation.appealOpen`,
 * see `baseProcedure` above) cannot use this — its budget is keyed on the
 * capability the caller presented, not on `user:<id>`; that is
 * `rateLimitCapability` below.
 */
export function rateLimit(policy: RateLimitPolicy) {
  return os.$context<Context & { user: SessionUser }>().middleware(({ context, next }) => {
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
 * Capability-keyed rate limiting — the session-less sibling of `rateLimit`.
 *
 * `rateLimit` keys on `context.user`, which only exists after
 * `protectedProcedure` has run; this variant keys on a capability string the
 * caller presented, so it can throttle a `baseProcedure` call. It is the
 * budget `moderation.appealOpen` consumes: `appeal:<nonce>` on the
 * signed-out token branch, `appeal:<actionId>` on the signed-in branch —
 * never a session, which the token branch cannot have by construction, and
 * never an IP, so the "no anonymous IP fallback" property holds here too.
 *
 * Deliberately not a middleware: a middleware must know its key before the
 * handler runs, and the appeal key exists only after the handler's own
 * branch work — an HMAC verify for the token path, the removal lookup for
 * the signed-in path. Deriving it earlier would mean running that work
 * twice, and for the signed-in path that is duplicating the very query the
 * budget exists to protect. So the handler calls this at the exact point
 * the key comes into existence, and the budget gates everything after it.
 *
 * Same consume-and-throw shape as `rateLimit` (same message, same
 * `retryAfterSeconds` data), so a caller cannot tell which variant refused
 * them.
 *
 * The parameter is the limiter slice of `Context`, not the whole thing: the
 * caller is `./appeal-intake.ts`, which deliberately declares a narrower
 * context than a procedure gets, and this function has never needed more.
 */
export function rateLimitCapability(
  context: Pick<Context, "rateLimiter">,
  policy: RateLimitPolicy,
  key: string,
): void {
  const result = context.rateLimiter.consume(`${policy.name}:${key}`, policy);

  if (!result.allowed) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: "You're doing that too fast. Try again in a moment.",
      data: { retryAfterSeconds: result.retryAfterSeconds },
    });
  }
}

/**
 * The base procedure plus a session requirement; handlers receive the session
 * user as `context.user`. Everything except the public read surface
 * (`publicReadProcedure` above, 0.4.0) and the capability-gated appeal
 * intake is built from this (issue #36; the old `publicProcedure` is gone).
 */
export const protectedProcedure = base
  .use(({ context, next }) => {
    if (!context.session?.user) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { ...context, user: context.session.user } });
  })
  /**
   * The legal consent gate (issues #157, #158).
   *
   * `packages/auth`'s create hook refuses a `/sign-up/email` that carries no
   * acceptance, but it is structurally unable to cover the other creation
   * paths: an OAuth or passkey sign-up has nowhere to put a checkbox, so
   * those accounts exist before anyone can be asked. Accounts that predate
   * the record have the same shape, as does anyone whose acceptance is for a
   * superseded version.
   *
   * So the record is enforced again here, at use rather than at creation.
   * The web app's consent dialog asks for it, but a dialog is a courtesy
   * anyone can skip — this is the half that holds, and it is why the gate
   * lives on `protectedProcedure` rather than on the procedures someone
   * remembered to mark.
   *
   * What stays reachable is deliberate, and all of it is outside oRPC:
   * accepting runs through `authClient.updateUser`, the /welcome handle and
   * date-of-birth claim through the same, and signing out and reading the
   * documents never touch a procedure. `moderation.appealOpen` builds from
   * `baseProcedure`, so a banned account can still be heard without first
   * being asked to accept anything.
   *
   * FORBIDDEN, not UNAUTHORIZED: the session is valid and the caller is who
   * they say they are — there is simply something they owe first. Signing
   * them out would lose the session they need in order to accept.
   */
  .use(({ context, next }) => {
    if (!hasCurrentLegalConsent(context.user)) {
      throw new ORPCError("FORBIDDEN", { message: LEGAL_CONSENT_REQUIRED_MESSAGE });
    }
    return next();
  })
  /**
   * The onboarding gate (security audit finding 3).
   *
   * OAuth and passkey sign-ups have nowhere to put a handle or a date of
   * birth, so those accounts exist incomplete; the /welcome flow is where the
   * two get declared. The client redirect that sends people there is a
   * courtesy anyone can skip, so the record is enforced again here, at use
   * rather than at creation — the same shape and the same reason as the legal
   * consent gate above, and it is why the gate lives on `protectedProcedure`
   * rather than on the procedures someone remembered to mark.
   *
   * What stays reachable is deliberate, and all of it is outside oRPC:
   * claiming the handle and declaring the date of birth run through
   * `authClient.updateUser`, the /welcome page's own route never touches a
   * procedure, and `moderation.appealOpen` builds from `baseProcedure`, so a
   * banned account can still be heard without first finishing onboarding.
   *
   * FORBIDDEN, not UNAUTHORIZED, for the same reason as the legal gate: the
   * session is valid and the caller is who they say they are — there is
   * simply something they owe first. Signing them out would lose the session
   * they need in order to finish.
   */
  .use(({ context, next }) => {
    if (!hasCompletedOnboarding(context.user)) {
      throw new ORPCError("FORBIDDEN", { message: ONBOARDING_REQUIRED_MESSAGE });
    }
    return next();
  });

/**
 * The one session-optional read surface: post permalinks (0.4.0).
 *
 * A signed-in caller gets exactly `protectedProcedure`'s treatment — session,
 * legal consent, onboarding — so no existing reader's behaviour moves. A
 * signed-out caller passes through with `context.user` undefined, and the
 * procedures built on this are the ones whose handlers then decide, per mode,
 * what an anonymous reader may see (`post.thread` everything it renders,
 * `post.list` only its reply modes, `post.linkCard` the cached card). A
 * handler that reads `context.user` off one of these MUST treat it as
 * possibly-undefined; the viewers' SQL probes already do (a NULL viewer id
 * matches no like/repost/bookmark row and no block edge).
 *
 * The set of procedures built from this is pinned by `router.int.test.ts`'s
 * sessionless inventory — adding one is a deliberate, reviewed act, never an
 * accident of reaching for the wrong base.
 */
export const publicReadProcedure = base.use(({ context, next }) => {
  const user = context.session?.user;
  if (user) {
    if (!hasCurrentLegalConsent(user)) {
      throw new ORPCError("FORBIDDEN", { message: LEGAL_CONSENT_REQUIRED_MESSAGE });
    }
    if (!hasCompletedOnboarding(user)) {
      throw new ORPCError("FORBIDDEN", { message: ONBOARDING_REQUIRED_MESSAGE });
    }
  }
  return next({ context: { ...context, user } });
});

/**
 * The rate limiter for `publicReadProcedure`: keyed on the signed-in caller's
 * id when there is one, and on the first `X-Forwarded-For` address when there
 * is not (the proxy hop in front of every deployment — Cloudflare, Railway —
 * writes it; a request without it shares one "unknown" bucket, which is a
 * blunt fallback but never an unbounded one).
 *
 * IP-keyed is weaker than session-keyed — a determined caller rotates
 * addresses — but the calls it gates are reads already bounded per response
 * by pagination, and the alternative (no anonymous budget) would make the
 * public thread pages a free firehose.
 */
export function publicRateLimit(policy: RateLimitPolicy) {
  return os.$context<Context>().middleware(({ context, next }) => {
    const forwarded = context.headers?.get("x-forwarded-for");
    const address = forwarded?.split(",")[0]?.trim();
    const key = context.session?.user
      ? `user:${context.session.user.id}`
      : `ip:${address && address.length > 0 ? address : "unknown"}`;

    const result = context.rateLimiter.consume(`${policy.name}:${key}`, policy);
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
 * Denies with FORBIDDEN when the caller's role is below the minimum.
 *
 * Built on `protectedProcedure`, so the session requirement is inherited.
 * The role arrives typed on `session.user.role` from the admin plugin
 * (packages/auth/src/index.ts) — no `additionalFields` wiring. The
 * `?? "user"` is defensive: the plugin's create hook writes `user` into every
 * row created through Better Auth, but the column itself is bare nullable
 * text, so a row written outside that flow (a direct Drizzle insert) holds
 * NULL, and the weakest role is the safe read for it.
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
