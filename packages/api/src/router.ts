import { moderationRouter } from "./moderation.js";
import { postRouter } from "./posts.js";
import { searchRouter } from "./search.js";
import { userRouter } from "./users.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";

/**
 * The oRPC router: `me`, plus the `post`, `user`, `search` and `moderation`
 * procedure groups.
 *
 * Liveness/readiness is served over plain HTTP at GET /health (see
 * apps/server/src/index.ts) so orchestrators (Docker, k8s) that can't speak
 * oRPC can probe it directly, and so it can check the DB without paying for
 * oRPC request matching. There is deliberately no RPC-level health check —
 * two health checks with different shapes was one too many.
 */
export const appRouter = {
  /** The caller's own session user, email included. Requires a session. */
  me: protectedProcedure.use(rateLimit(RATE_LIMITS.read)).handler(({ context }) => {
    return context.user;
  }),
  post: postRouter,
  user: userRouter,
  search: searchRouter,
  moderation: moderationRouter,
};

/** The inferred router type, for callers that import the contract (tests, the client). */
export type AppRouter = typeof appRouter;
