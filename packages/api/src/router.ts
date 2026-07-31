import { os } from "@orpc/server";
import { z } from "zod";

const base = os.$context<{ db?: unknown }>();

export const appRouter = base.router({
  healthCheck: base
    .input(z.void())
    .output(z.object({ status: z.string(), timestamp: z.string() }))
    .handler(async () => {
      return {
        status: "ok",
        timestamp: new Date().toISOString(),
      };
    }),
});

export type AppRouter = typeof appRouter;
