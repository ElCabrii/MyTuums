import { protectedProcedure } from "./procedures.js";

// Liveness/readiness is served over plain HTTP at GET /health (see
// apps/server/src/index.ts) so orchestrators (Docker, k8s) that can't speak
// oRPC can probe it directly, and so it can check the DB without paying for
// oRPC request matching. There is deliberately no RPC-level health check —
// two health checks with different shapes was one too many.
export const appRouter = {
  me: protectedProcedure.handler(({ context }) => {
    return context.user;
  }),
};

export type AppRouter = typeof appRouter;
