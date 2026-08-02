import { auth } from "@my-tuums/auth";
import { db, type Database } from "@my-tuums/db";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

export interface Context {
  db: Database;
  session: Session;
  /**
   * The caller's IP, as resolved by the transport (see
   * apps/server/src/client-ip.ts). It is the rate limiter's fallback identity
   * for anonymous callers, who have no user id to key on.
   *
   * Optional because it is transport-specific: `call()` in tests, and any
   * future in-process caller, have no socket behind them. A missing IP is
   * treated as one shared bucket rather than as "unlimited" — see
   * ./procedures.ts.
   */
  clientIp?: string;
  /**
   * Where `./procedures.ts`'s `rateLimit()` middleware consumes budget.
   *
   * Required, not optional: every `Context` has to come from somewhere, and
   * making that explicit is what keeps a limiter from being an invisible
   * global a procedure reaches for on its own. Production gets exactly one
   * instance for the server's lifetime — see `defaultRateLimiter` below —
   * shared across every request the same way the old module-level singleton
   * in `rate-limit.ts` was. Tests build `Context` objects directly
   * (`testing/harness.ts`) and supply their own, entirely independent
   * instance, so a rate-limit assertion in one suite can never bleed into
   * another's.
   */
  rateLimiter: RateLimiter;
}

/**
 * Created once, at module load, and captured by the default parameter below —
 * NOT created fresh inside `createContext`. `createContext` runs once per
 * request, but a rate limiter has to persist ACROSS requests to mean
 * anything; a fresh instance per call would let every caller reset their own
 * budget just by making another request.
 */
const defaultRateLimiter = createRateLimiter();

export async function createContext({
  headers,
  clientIp,
  rateLimiter = defaultRateLimiter,
}: {
  headers: Headers;
  clientIp?: string;
  /** Override for tests that want to build a context without a real request. */
  rateLimiter?: RateLimiter;
}): Promise<Context> {
  const session = await auth.api.getSession({ headers });
  return { db, session, clientIp, rateLimiter };
}
